// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    IValidator,
    IExecutor,
    IERC7579Execution,
    Execution,
    MODULE_TYPE_VALIDATOR,
    MODULE_TYPE_EXECUTOR,
    CALLTYPE_SINGLE,
    CALLTYPE_BATCH,
    VALIDATION_FAILED,
    ERC1271_MAGIC,
    ERC1271_INVALID
} from "../interfaces/IERC7579.sol";
import {ExecLib} from "../lib/ExecLib.sol";
import {ChannelType, ChannelPolicy, IChannelControl} from "../channels/ChannelTypes.sol";

/// @title ChannelValidator
/// @notice 安裝在「支出通道」子帳戶上，同時是 validator（驗證操作者簽章與政策）與 executor
///         （代主人核准 AI 超額請求、執行 Visa capture、撤銷時回收資金）。
/// @dev 設計規格 §6。
///      AGENT：操作者可直接在政策內轉帳；超過 confirmThreshold 需 requestIntent → 主人以卡片 approveIntent
///      CARD ：只能 authorize（鎖定）→ capture（扣款給 settlement）→ release
contract ChannelValidator is IValidator, IExecutor, IChannelControl {
    struct Config {
        address parent;
        address operator;
        ChannelType channelType;
        bool revoked;
    }

    struct Spent {
        uint128 amount;
        uint48 windowStart;
    }

    struct Hold {
        uint128 amount;
        uint48 expiry;
    }

    struct Intent {
        address to;
        uint128 amount;
        uint48 expiry;
        bool done;
    }

    uint48 public constant WINDOW = 24 hours;
    uint48 public constant INTENT_TTL = 24 hours;
    uint256 public constant CAPTURE_TOLERANCE_BPS = 12_000; // capture ≤ 授權金額 × 120%

    mapping(address channel => Config) public configOf;
    mapping(address channel => ChannelPolicy) public policyOf;
    mapping(address channel => Spent) public spentOf;
    mapping(address channel => uint256) public lockedOf;
    mapping(address channel => uint256) public targetCountOf;
    mapping(address target => mapping(address channel => bool)) public targetAllowed;
    mapping(bytes32 authId => mapping(address channel => Hold)) public holds;
    mapping(uint256 intentId => mapping(address channel => Intent)) public intents;
    mapping(address channel => uint256) public intentCountOf;

    event ChannelConfigured(address indexed channel, address indexed parent, address operator, ChannelType channelType);
    event PolicyUpdated(address indexed channel, ChannelPolicy policy);
    event TargetSet(address indexed channel, address indexed target, bool allowed);
    event Revoked(address indexed channel, uint256 swept);
    event IntentRequested(
        address indexed channel, uint256 indexed intentId, address to, uint256 amount, bytes32 reasonHash
    );
    event IntentApproved(address indexed channel, uint256 indexed intentId);
    event Authorized(address indexed channel, bytes32 indexed authId, uint256 amount, uint48 expiry);
    event Captured(address indexed channel, bytes32 indexed authId, uint256 amount);
    event Released(address indexed channel, bytes32 indexed authId);

    error OnlyParent();
    error OnlyChannel();
    error WrongChannelType();
    error ChannelRevoked();
    error PolicyExpired();
    error ExceedsPerTx();
    error ExceedsDaily();
    error InsufficientAvailable();
    error NotStricter();
    error HoldExists();
    error HoldNotFound();
    error CaptureTooLarge();
    error IntentInvalid();

    // ───────────────────────── 模組 ─────────────────────────

    /// @param data validator：abi.encode(parent, operator, uint8 channelType, ChannelPolicy)；executor：空
    function onInstall(bytes calldata data) external {
        if (data.length == 0) return;
        (address parent, address operator, uint8 ctype, ChannelPolicy memory p) =
            abi.decode(data, (address, address, uint8, ChannelPolicy));
        configOf[msg.sender] = Config(parent, operator, ChannelType(ctype), false);
        policyOf[msg.sender] = p;
        emit ChannelConfigured(msg.sender, parent, operator, ChannelType(ctype));
        emit PolicyUpdated(msg.sender, p);
    }

    function onUninstall(bytes calldata) external pure {
        revert("Channel: cannot uninstall");
    }

    function isModuleType(uint256 t) external pure returns (bool) {
        return t == MODULE_TYPE_VALIDATOR || t == MODULE_TYPE_EXECUTOR;
    }

    // ───────────────────────── 驗證（操作者） ─────────────────────────

    /// @dev signature = 操作者對 userOpHash 的 EIP-191 ECDSA 簽章（金鑰在 TEE 或發卡方 HSM）
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256) {
        address channel = userOp.sender;
        Config memory cfg = configOf[channel];
        if (cfg.revoked || cfg.operator == address(0)) return VALIDATION_FAILED;

        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(userOpHash), userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer != cfg.operator) return VALIDATION_FAILED;

        if (userOp.callData.length < 4 || bytes4(userOp.callData[0:4]) != IERC7579Execution.execute.selector) {
            return VALIDATION_FAILED;
        }
        (bytes32 mode, bytes memory ec) = abi.decode(userOp.callData[4:], (bytes32, bytes));
        if (mode[0] != CALLTYPE_SINGLE && mode[0] != CALLTYPE_BATCH) return VALIDATION_FAILED;
        Execution[] memory execs = ExecLib.decode(mode, ec);

        ChannelPolicy memory p = policyOf[channel];
        uint256 total;
        for (uint256 i = 0; i < execs.length; i++) {
            Execution memory e = execs[i];
            if (e.value != 0) return VALIDATION_FAILED;
            bytes4 sel = ExecLib.selector(e.callData);

            if (e.target == address(this)) {
                bool okSel = cfg.channelType == ChannelType.CARD
                    ? (sel == this.authorize.selector || sel == this.capture.selector || sel == this.release.selector)
                    : sel == this.requestIntent.selector;
                if (!okSel) return VALIDATION_FAILED;
                continue; // 金額檢查在執行期
            }
            // 直接轉帳：僅限 AGENT／MERCHANT，且只能是政策代幣
            if (cfg.channelType == ChannelType.CARD) return VALIDATION_FAILED;
            if (e.target != p.token || sel != IERC20.transfer.selector) return VALIDATION_FAILED;
            (address to, uint256 amt) = abi.decode(ExecLib.args(e.callData), (address, uint256));
            if (targetCountOf[channel] > 0 && !targetAllowed[to][channel]) return VALIDATION_FAILED;
            if (amt > p.perTxLimit || amt > p.confirmThreshold) return VALIDATION_FAILED;
            total += amt;
        }
        if (total > 0) {
            if (_windowSpent(channel) + total > p.dailyLimit) return VALIDATION_FAILED;
            if (total > _available(channel, p.token)) return VALIDATION_FAILED;
            _addSpent(channel, total);
        }
        return _packValidationData(false, p.validUntil, 0);
    }

    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata data) external view returns (bytes4) {
        Config memory cfg = configOf[msg.sender];
        if (cfg.revoked) return ERC1271_INVALID;
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, data);
        return (err == ECDSA.RecoverError.NoError && signer == cfg.operator) ? ERC1271_MAGIC : ERC1271_INVALID;
    }

    // ───────────────────────── 通道自身呼叫（msg.sender = channel） ─────────────────────────

    /// @notice AI 超額請求；由主人以卡片確認後 approveIntent 執行
    function requestIntent(address to, uint256 amount, bytes32 reasonHash) external returns (uint256 id) {
        Config memory cfg = _activeChannel(msg.sender);
        if (cfg.channelType != ChannelType.AGENT) revert WrongChannelType();
        id = ++intentCountOf[msg.sender];
        intents[id][msg.sender] = Intent(to, uint128(amount), uint48(block.timestamp) + INTENT_TTL, false);
        emit IntentRequested(msg.sender, id, to, amount, reasonHash);
    }

    /// @notice Visa 授權：鎖定金額，鎖定部分不可轉出
    function authorize(bytes32 authId, uint256 amount, uint48 expiry) external {
        Config memory cfg = _activeChannel(msg.sender);
        if (cfg.channelType != ChannelType.CARD) revert WrongChannelType();
        ChannelPolicy memory p = policyOf[msg.sender];
        if (holds[authId][msg.sender].amount != 0) revert HoldExists();
        if (amount > p.perTxLimit) revert ExceedsPerTx();
        if (_windowSpent(msg.sender) + amount > p.dailyLimit) revert ExceedsDaily();
        if (amount > _available(msg.sender, p.token)) revert InsufficientAvailable();
        _addSpent(msg.sender, amount);
        lockedOf[msg.sender] += amount;
        holds[authId][msg.sender] = Hold(uint128(amount), expiry);
        emit Authorized(msg.sender, authId, amount, expiry);
    }

    /// @notice Visa 清算：扣款給 settlement，金額 ≤ 授權金額 × 120%
    function capture(bytes32 authId, uint256 finalAmount) external {
        Config memory cfg = _activeChannel(msg.sender);
        if (cfg.channelType != ChannelType.CARD) revert WrongChannelType();
        Hold memory h = holds[authId][msg.sender];
        if (h.amount == 0) revert HoldNotFound();
        if (finalAmount * 10_000 > uint256(h.amount) * CAPTURE_TOLERANCE_BPS) revert CaptureTooLarge();
        ChannelPolicy memory p = policyOf[msg.sender];

        delete holds[authId][msg.sender];
        lockedOf[msg.sender] -= h.amount;
        if (finalAmount > _available(msg.sender, p.token)) revert InsufficientAvailable();
        _transferFrom(msg.sender, p.token, p.settlement, finalAmount);
        emit Captured(msg.sender, authId, finalAmount);
    }

    /// @notice 通道本身可隨時釋放；過期後任何人可釋放
    function release(address channel, bytes32 authId) external {
        Hold memory h = holds[authId][channel];
        if (h.amount == 0) revert HoldNotFound();
        if (msg.sender != channel && block.timestamp <= h.expiry) revert OnlyChannel();
        delete holds[authId][channel];
        lockedOf[channel] -= h.amount;
        emit Released(channel, authId);
    }

    // ───────────────────────── 主人控制（msg.sender = parent） ─────────────────────────

    function approveIntent(address channel, uint256 intentId, address token, address to, uint256 amount) external {
        _onlyParent(channel);
        Intent storage it = intents[intentId][channel];
        ChannelPolicy memory p = policyOf[channel];
        if (
            it.done || it.expiry < block.timestamp || it.to != to || it.amount != amount || token != p.token
                || it.to == address(0)
        ) revert IntentInvalid();
        it.done = true;
        if (amount > _available(channel, p.token)) revert InsufficientAvailable();
        _transferFrom(channel, p.token, to, amount);
        emit IntentApproved(channel, intentId);
    }

    function updatePolicy(address channel, ChannelPolicy calldata policy) external {
        _onlyParent(channel);
        policyOf[channel] = policy;
        emit PolicyUpdated(channel, policy);
    }

    /// @notice 只能收緊：所有上限不得提高、期限不得延長、代幣與 settlement 不變
    function restrictPolicy(address channel, ChannelPolicy calldata p) external {
        _onlyParent(channel);
        ChannelPolicy memory o = policyOf[channel];
        if (
            p.token != o.token || p.settlement != o.settlement || p.perTxLimit > o.perTxLimit
                || p.dailyLimit > o.dailyLimit || p.confirmThreshold > o.confirmThreshold || p.validUntil > o.validUntil
        ) revert NotStricter();
        policyOf[channel] = p;
        emit PolicyUpdated(channel, p);
    }

    function allowTarget(address channel, address target) external {
        _onlyParent(channel);
        if (!targetAllowed[target][channel]) {
            targetAllowed[target][channel] = true;
            targetCountOf[channel]++;
        }
        emit TargetSet(channel, target, true);
    }

    /// @dev 注意：白名單清空後 targetCount 歸零即代表「不限收款方」，前端應提醒改用 revoke
    function disallowTarget(address channel, address target) external {
        _onlyParent(channel);
        if (targetAllowed[target][channel]) {
            targetAllowed[target][channel] = false;
            targetCountOf[channel]--;
        }
        emit TargetSet(channel, target, false);
    }

    /// @notice 撤銷通道並把可用餘額（扣除 Visa 鎖定部分）歸還主帳戶
    function revoke(address channel) external {
        _onlyParent(channel);
        Config storage cfg = configOf[channel];
        cfg.revoked = true;
        ChannelPolicy memory p = policyOf[channel];
        uint256 amt = _available(channel, p.token);
        if (amt > 0) _transferFrom(channel, p.token, cfg.parent, amt);
        emit Revoked(channel, amt);
    }

    // ───────────────────────── 查詢與內部 ─────────────────────────

    function available(address channel) external view returns (uint256) {
        return _available(channel, policyOf[channel].token);
    }

    function _available(address channel, address token) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(channel);
        uint256 locked = lockedOf[channel];
        return bal > locked ? bal - locked : 0;
    }

    function _windowSpent(address channel) internal view returns (uint256) {
        Spent memory s = spentOf[channel];
        if (block.timestamp >= uint256(s.windowStart) + WINDOW) return 0;
        return s.amount;
    }

    function _addSpent(address channel, uint256 amount) internal {
        Spent storage s = spentOf[channel];
        if (block.timestamp >= uint256(s.windowStart) + WINDOW) {
            s.windowStart = uint48(block.timestamp);
            s.amount = 0;
        }
        s.amount += uint128(amount);
    }

    function _transferFrom(address channel, address token, address to, uint256 amount) internal {
        IERC7579Execution(channel).executeFromExecutor(
            ExecLib.modeSingle(), ExecLib.encodeSingle(token, 0, abi.encodeCall(IERC20.transfer, (to, amount)))
        );
    }

    function _onlyParent(address channel) internal view {
        if (configOf[channel].parent != msg.sender) revert OnlyParent();
    }

    function _activeChannel(address channel) internal view returns (Config memory cfg) {
        cfg = configOf[channel];
        if (cfg.parent == address(0)) revert OnlyChannel();
        if (cfg.revoked) revert ChannelRevoked();
        if (block.timestamp > policyOf[channel].validUntil) revert PolicyExpired();
    }
}
