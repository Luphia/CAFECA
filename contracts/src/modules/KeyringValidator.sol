// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    IValidator,
    IERC7579Execution,
    IERC7579ModuleConfig,
    Execution,
    MODULE_TYPE_VALIDATOR,
    CALLTYPE_SINGLE,
    CALLTYPE_BATCH,
    VALIDATION_SUCCESS,
    VALIDATION_FAILED,
    ERC1271_MAGIC,
    ERC1271_INVALID
} from "../interfaces/IERC7579.sol";
import {ExecLib} from "../lib/ExecLib.sol";
import {WebAuthnLib} from "../lib/WebAuthnLib.sol";
import {OpKind, TxSummary, TxSummaryLib} from "../lib/TxSummary.sol";
import {ChannelPolicy, IChannelManager, IChannelControl} from "../channels/ChannelTypes.sol";

interface IRecoveryStatus {
    function isPending(address account) external view returns (bool);
    function cancelRecovery() external;
}

interface ICardIssuerRegistry {
    function isCardIssuer(address issuer) external view returns (bool);
}

interface IDeviceDirectory {
    function registerDevice(bytes32 deviceId, bytes calldata credential) external;
}

interface IERC20Extra {
    function increaseAllowance(address spender, uint256 amount) external returns (bool);
}

interface INftApproval {
    function setApprovalForAll(address operator, bool approved) external;
}

/// @title KeyringValidator
/// @notice 身分帳戶的主要 validator：管理 FIDO2 金鑰（MASTER＝CAFECA 卡、DAILY＝手機 passkey），
///         依「權限矩陣」判斷每個 UserOp 需要哪一級金鑰，並對 MASTER 簽章驗證卡片螢幕的 ctxd。
/// @dev 設計規格 §4、§9、§10。
///      儲存一律以帳戶為最內層 key（ERC-7562 associated storage）。
///      注意：每日額度與時間鎖在驗證階段讀取 block.timestamp，需 CAFECA bundler 放寬 ERC-7562
///      的 TIMESTAMP 規則（見規格 §12 待決事項），或改以執行期 hook 實作。
contract KeyringValidator is IValidator {
    // ───────────────────────── 型別 ─────────────────────────

    enum KeyClass {
        NONE,
        DAILY,
        MASTER
    }

    enum Req {
        REJECT,
        DAILY,
        MASTER
    }

    enum Action {
        ADD_DAILY,
        REMOVE_KEY,
        SET_LIMITS,
        MODULE
    }

    struct Key {
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
        KeyClass keyClass;
        uint48 addedAt;
    }

    struct Limit {
        uint128 perTx;
        uint128 daily;
    }

    struct Spent {
        uint128 amount;
        uint48 windowStart;
    }

    struct AccountState {
        uint32 keyCount;
        uint32 masterCount;
        bool initialized;
    }

    struct KeyInit {
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
    }

    struct LimitInit {
        address token;
        uint128 perTx;
        uint128 daily;
    }

    /// @dev UserOp.signature = abi.encode(SignatureData)
    struct SignatureData {
        bytes32 keyId;
        WebAuthnLib.Sig sig;
    }

    struct Classified {
        TxSummary s;
        Req r;
        bool frozenOk; // 恢復進行中仍允許
        address token; // 需計入額度的代幣
        uint256 amount;
        bool forceOver; // 例如 setApprovalForAll：一律視為超額
    }

    struct Assessment {
        Req req;
        bool frozenOk;
        bytes32 consumeSchedule;
        TxSummary[] summaries;
        address[] spendTokens;
        uint256[] spendAmounts;
        uint256 spendCount;
    }

    // ───────────────────────── 常數與不可變設定 ─────────────────────────

    uint48 public constant DELAY_DAILY = 24 hours;
    uint48 public constant DELAY_REMOVE_MASTER = 72 hours;
    uint48 public constant DELAY_MODULE = 72 hours;
    uint48 public constant WINDOW = 24 hours;

    address public immutable recovery;
    address public immutable channelManager;
    address public immutable channelControl;
    address public immutable deviceDirectory;
    address public immutable cardIssuerRegistry;

    // ───────────────────────── 儲存 ─────────────────────────

    mapping(bytes32 keyId => mapping(address account => Key)) internal _keys;
    mapping(address account => AccountState) public accountState;
    mapping(address token => mapping(address account => Limit)) public limits;
    mapping(address token => mapping(address account => Spent)) public spent;
    mapping(bytes32 actionHash => mapping(address account => uint48 readyAt)) public scheduledAt;
    mapping(address account => bytes32[]) internal _keyList;

    // ───────────────────────── 事件與錯誤 ─────────────────────────

    event KeyAdded(address indexed account, bytes32 indexed keyId, KeyClass keyClass);
    event KeyRemoved(address indexed account, bytes32 indexed keyId);
    event LimitsSet(address indexed account, address indexed token, uint128 perTx, uint128 daily);
    event Scheduled(address indexed account, bytes32 indexed actionHash, uint8 action, uint48 readyAt);
    event ScheduleExecuted(address indexed account, bytes32 indexed actionHash);
    event ScheduleCancelled(address indexed account, bytes32 indexed actionHash);
    event KeysWiped(address indexed account);

    error AlreadyInitialized();
    error NotInitialized();
    error KeyExists();
    error KeyNotFound();
    error LastKey();
    error InvalidCardAttestation();
    error NotReady();
    error OnlyRecovery();
    error CannotUninstall();
    error ScheduleViaInstallModule();

    constructor(
        address recovery_,
        address channelManager_,
        address channelControl_,
        address deviceDirectory_,
        address cardIssuerRegistry_
    ) {
        recovery = recovery_;
        channelManager = channelManager_;
        channelControl = channelControl_;
        deviceDirectory = deviceDirectory_;
        cardIssuerRegistry = cardIssuerRegistry_;
    }

    // ───────────────────────── ERC-7579 模組 ─────────────────────────

    /// @param data abi.encode(KeyInit firstDailyKey, LimitInit[] defaultLimits)
    function onInstall(bytes calldata data) external {
        AccountState storage st = accountState[msg.sender];
        if (st.initialized) revert AlreadyInitialized();
        st.initialized = true;
        (KeyInit memory k, LimitInit[] memory lims) = abi.decode(data, (KeyInit, LimitInit[]));
        _addKey(msg.sender, k.qx, k.qy, k.rpIdHash, KeyClass.DAILY);
        for (uint256 i = 0; i < lims.length; i++) {
            _setLimits(msg.sender, lims[i].token, lims[i].perTx, lims[i].daily);
        }
    }

    function onUninstall(bytes calldata) external pure {
        revert CannotUninstall();
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    // ───────────────────────── 驗證 ─────────────────────────

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256) {
        address account = userOp.sender;
        SignatureData memory sd = abi.decode(userOp.signature, (SignatureData));
        Key memory k = _keys[sd.keyId][account];
        if (k.keyClass == KeyClass.NONE) return VALIDATION_FAILED;

        // 1. 先驗簽，失敗時不改任何狀態
        if (!WebAuthnLib.verify(abi.encodePacked(userOpHash), sd.sig, k.rpIdHash, k.qx, k.qy)) {
            return VALIDATION_FAILED;
        }
        // 2. MASTER 必須是裝置綁定金鑰（卡片），BE 旗標不得為 1
        if (k.keyClass == KeyClass.MASTER && (WebAuthnLib.flags(sd.sig.authenticatorData) & WebAuthnLib.FLAG_BE) != 0)
        {
            return VALIDATION_FAILED;
        }

        // 3. 依權限矩陣分類
        Assessment memory a = _assess(account, userOp.callData);
        if (a.req == Req.REJECT) return VALIDATION_FAILED;
        if (a.req == Req.MASTER) {
            if (k.keyClass != KeyClass.MASTER) return VALIDATION_FAILED;
            (bool present, bytes32 ctxd) = WebAuthnLib.extractCtxd(sd.sig.authenticatorData);
            if (!present || ctxd != TxSummaryLib.digest(a.summaries)) return VALIDATION_FAILED;
        }

        // 4. 恢復進行中：凍結所有轉出與放寬權限的操作
        if (!a.frozenOk && IRecoveryStatus(recovery).isPending(account)) return VALIDATION_FAILED;

        // 5. 寫入額度與排程消耗
        _commit(account, a);
        return VALIDATION_SUCCESS;
    }

    /// @notice 預覽某筆 callData 需要的金鑰等級與卡片應顯示的摘要（供 App 與卡片使用）
    function previewAssessment(address account, bytes calldata callData)
        external
        view
        returns (Req req, bool frozenOk, TxSummary[] memory summaries, bytes32 ctxd)
    {
        Assessment memory a = _assess(account, callData);
        return (a.req, a.frozenOk, a.summaries, TxSummaryLib.digest(a.summaries));
    }

    function _assess(address account, bytes calldata callData) internal view returns (Assessment memory a) {
        a.req = Req.DAILY;
        a.frozenOk = true;
        if (callData.length < 4) {
            a.req = Req.REJECT;
            return a;
        }
        bool master = accountState[account].masterCount > 0;
        bytes4 sel = bytes4(callData[0:4]);

        if (sel == IERC7579Execution.execute.selector) {
            (bytes32 mode, bytes memory ec) = abi.decode(callData[4:], (bytes32, bytes));
            if (mode[0] != CALLTYPE_SINGLE && mode[0] != CALLTYPE_BATCH) {
                a.req = Req.REJECT;
                return a;
            }
            Execution[] memory execs = ExecLib.decode(mode, ec);
            a.summaries = new TxSummary[](execs.length);
            a.spendTokens = new address[](execs.length * 2);
            a.spendAmounts = new uint256[](execs.length * 2);

            bool over;
            for (uint256 i = 0; i < execs.length; i++) {
                Classified memory c = _classify(account, execs[i], master);
                a.summaries[i] = c.s;
                a.req = _combine(a.req, c.r);
                if (!c.frozenOk) a.frozenOk = false;
                if (c.forceOver) over = true;
                if (execs[i].value > 0) {
                    _addSpend(a, address(0), execs[i].value);
                    if (execs[i].value > limits[address(0)][account].perTx) over = true;
                }
                if (c.amount > 0) {
                    _addSpend(a, c.token, c.amount);
                    if (c.amount > limits[c.token][account].perTx) over = true;
                }
            }
            for (uint256 j = 0; j < a.spendCount; j++) {
                uint256 used = _windowSpent(account, a.spendTokens[j]);
                if (used + a.spendAmounts[j] > limits[a.spendTokens[j]][account].daily) over = true;
            }
            if (a.spendCount > 0) a.frozenOk = false;
            if (over) a.req = _combine(a.req, master ? Req.MASTER : Req.REJECT);
        } else if (
            sel == IERC7579ModuleConfig.installModule.selector || sel == IERC7579ModuleConfig.uninstallModule.selector
        ) {
            // 模組變更必須事先排程並等待 72 小時
            bytes32 h = keccak256(abi.encode(uint8(Action.MODULE), callData));
            uint48 ready = scheduledAt[h][account];
            if (ready == 0 || ready > block.timestamp) {
                a.req = Req.REJECT;
                return a;
            }
            a.consumeSchedule = h;
            a.frozenOk = false;
            a.req = master ? Req.MASTER : Req.DAILY;
            a.summaries = new TxSummary[](1);
            a.summaries[0] = TxSummary(uint8(OpKind.MODULE), block.chainid, address(0), 0, account, h);
        } else {
            a.req = Req.REJECT;
        }
    }

    function _classify(address account, Execution memory e, bool master)
        internal
        view
        returns (Classified memory c)
    {
        c.s.chainId = block.chainid;
        c.s.counterparty = e.target;
        c.s.amount = e.value;
        c.r = Req.DAILY;
        bytes4 fsel = ExecLib.selector(e.callData);

        if (e.target == account) {
            c.r = Req.REJECT; // 自呼叫一律走 installModule 等直接入口
            return c;
        }
        if (e.target == address(this)) return _classifySelf(account, e, fsel, master);

        if (e.target == recovery) {
            if (fsel == IRecoveryStatus.cancelRecovery.selector) {
                c.s.kind = uint8(OpKind.RECOVERY_CANCEL);
                c.frozenOk = true;
            } else {
                c.r = Req.REJECT;
            }
            return c;
        }
        if (e.target == deviceDirectory) {
            c.s.kind = uint8(OpKind.DEVICE);
            c.frozenOk = true;
            return c;
        }
        if (e.target == channelManager) {
            if (fsel != IChannelManager.createChannel.selector) {
                c.r = Req.REJECT;
                return c;
            }
            (, address operator, ChannelPolicy memory p,) =
                abi.decode(ExecLib.args(e.callData), (uint8, address, ChannelPolicy, bytes32));
            c.s.kind = uint8(OpKind.CHANNEL_CREATE);
            c.s.token = p.token;
            c.s.amount = p.dailyLimit;
            c.s.counterparty = operator;
            c.r = master ? Req.MASTER : Req.DAILY;
            return c;
        }
        if (e.target == channelControl) return _classifyChannel(e, fsel, master);

        // ── 一般合約呼叫 ──
        if (e.callData.length == 0) {
            c.s.kind = uint8(OpKind.TRANSFER); // 原生幣，額度在外層以 value 計入
        } else if (fsel == IERC20.transfer.selector) {
            (address to, uint256 amt) = abi.decode(ExecLib.args(e.callData), (address, uint256));
            c.s.kind = uint8(OpKind.TRANSFER);
            c.s.token = e.target;
            c.s.amount = amt;
            c.s.counterparty = to;
            c.token = e.target;
            c.amount = amt;
        } else if (fsel == IERC20.approve.selector || fsel == IERC20Extra.increaseAllowance.selector) {
            (address spender, uint256 amt) = abi.decode(ExecLib.args(e.callData), (address, uint256));
            c.s.kind = uint8(OpKind.APPROVE);
            c.s.token = e.target;
            c.s.amount = amt;
            c.s.counterparty = spender;
            if (amt == 0 && fsel == IERC20.approve.selector) {
                c.frozenOk = true; // 撤銷授權屬收緊
            } else {
                c.token = e.target;
                c.amount = amt;
            }
        } else if (fsel == INftApproval.setApprovalForAll.selector) {
            (address operator, bool approved) = abi.decode(ExecLib.args(e.callData), (address, bool));
            c.s.kind = uint8(OpKind.APPROVE);
            c.s.token = e.target;
            c.s.amount = approved ? type(uint256).max : 0;
            c.s.counterparty = operator;
            if (approved) c.forceOver = true;
            else c.frozenOk = true;
        } else if (fsel == IERC20.transferFrom.selector) {
            (address from, address to, uint256 amt) =
                abi.decode(ExecLib.args(e.callData), (address, address, uint256));
            c.s.kind = uint8(OpKind.TRANSFER);
            c.s.token = e.target;
            c.s.amount = amt;
            c.s.counterparty = to;
            if (from == account) c.forceOver = true; // NFT 或自身資產搬移，視為高風險
        } else {
            c.s.kind = uint8(OpKind.UNKNOWN_CALL); // 盲簽：DAILY 可用，但不能夾帶超額 value
            c.s.extra = bytes32(fsel);
        }
    }

    function _classifySelf(address account, Execution memory e, bytes4 fsel, bool master)
        internal
        view
        returns (Classified memory c)
    {
        c.s.chainId = block.chainid;
        c.s.counterparty = account;
        c.r = Req.DAILY;

        if (fsel == this.addDailyKey.selector) {
            (bytes32 qx, bytes32 qy,) = abi.decode(ExecLib.args(e.callData), (bytes32, bytes32, bytes32));
            c.s.kind = uint8(OpKind.KEY_ADD_DAILY);
            c.s.extra = keyIdOf(qx, qy);
            c.r = master ? Req.MASTER : Req.REJECT; // 標準模式需走排程（24h）
        } else if (fsel == this.addMasterKey.selector) {
            (bytes32 qx, bytes32 qy,,,) =
                abi.decode(ExecLib.args(e.callData), (bytes32, bytes32, bytes32, bytes32, bytes));
            c.s.kind = uint8(OpKind.KEY_ADD_MASTER);
            c.s.extra = keyIdOf(qx, qy);
            c.r = master ? Req.MASTER : Req.DAILY; // 第一張卡：DAILY＋發卡方簽章
        } else if (fsel == this.removeKey.selector) {
            bytes32 keyId = abi.decode(ExecLib.args(e.callData), (bytes32));
            c.s.kind = uint8(OpKind.KEY_REMOVE);
            c.s.extra = keyId;
            c.r = master ? Req.MASTER : Req.REJECT;
            c.frozenOk = true;
        } else if (fsel == this.setLimits.selector) {
            (address token, uint128 perTx, uint128 daily) =
                abi.decode(ExecLib.args(e.callData), (address, uint128, uint128));
            Limit memory cur = limits[token][account];
            c.s.token = token;
            c.s.amount = perTx;
            c.s.extra = bytes32(uint256(daily));
            if (perTx <= cur.perTx && daily <= cur.daily) {
                c.s.kind = uint8(OpKind.LIMIT_LOWER);
                c.frozenOk = true;
            } else {
                c.s.kind = uint8(OpKind.LIMIT_RAISE);
                c.r = master ? Req.MASTER : Req.REJECT;
            }
        } else if (fsel == this.schedule.selector) {
            (uint8 action, bytes memory payload) = abi.decode(ExecLib.args(e.callData), (uint8, bytes));
            c.s.kind = uint8(OpKind.SCHEDULE);
            c.s.amount = action;
            c.s.extra = keccak256(abi.encode(action, payload));
            bool sensitive = action == uint8(Action.SET_LIMITS) || action == uint8(Action.MODULE);
            c.r = (sensitive && master) ? Req.MASTER : Req.DAILY;
        } else if (fsel == this.executeScheduled.selector) {
            (uint8 action, bytes memory payload) = abi.decode(ExecLib.args(e.callData), (uint8, bytes));
            c.s.kind = uint8(OpKind.EXECUTE_SCHEDULED);
            c.s.extra = keccak256(abi.encode(action, payload));
        } else if (fsel == this.cancel.selector) {
            c.s.kind = uint8(OpKind.CANCEL);
            c.s.extra = abi.decode(ExecLib.args(e.callData), (bytes32));
            c.frozenOk = true;
        } else {
            c.r = Req.REJECT;
        }
    }

    function _classifyChannel(Execution memory e, bytes4 fsel, bool master)
        internal
        view
        returns (Classified memory c)
    {
        c.s.chainId = block.chainid;
        c.r = Req.DAILY;
        bytes memory a = ExecLib.args(e.callData);

        if (fsel == IChannelControl.restrictPolicy.selector || fsel == IChannelControl.disallowTarget.selector) {
            c.s.kind = uint8(OpKind.CHANNEL_RESTRICT);
            c.s.counterparty = abi.decode(a, (address));
            c.frozenOk = true;
        } else if (fsel == IChannelControl.revoke.selector) {
            c.s.kind = uint8(OpKind.CHANNEL_RESTRICT);
            c.s.counterparty = abi.decode(a, (address));
            c.frozenOk = true;
        } else if (fsel == IChannelControl.updatePolicy.selector) {
            (address channel, ChannelPolicy memory p) = abi.decode(a, (address, ChannelPolicy));
            c.s.kind = uint8(OpKind.CHANNEL_RAISE);
            c.s.counterparty = channel;
            c.s.token = p.token;
            c.s.amount = p.dailyLimit;
            c.r = master ? Req.MASTER : Req.DAILY;
        } else if (fsel == IChannelControl.allowTarget.selector) {
            (address channel, address target) = abi.decode(a, (address, address));
            c.s.kind = uint8(OpKind.CHANNEL_RAISE);
            c.s.counterparty = channel;
            c.s.extra = bytes32(uint256(uint160(target)));
            c.r = master ? Req.MASTER : Req.DAILY;
        } else if (fsel == IChannelControl.approveIntent.selector) {
            (, uint256 id, address token, address to, uint256 amount) =
                abi.decode(a, (address, uint256, address, address, uint256));
            c.s.kind = uint8(OpKind.APPROVE_INTENT);
            c.s.token = token;
            c.s.amount = amount;
            c.s.counterparty = to;
            c.s.extra = bytes32(id);
            c.r = master ? Req.MASTER : Req.DAILY;
        } else {
            c.r = Req.REJECT;
        }
    }

    function _combine(Req a, Req b) internal pure returns (Req) {
        if (a == Req.REJECT || b == Req.REJECT) return Req.REJECT;
        return uint8(a) >= uint8(b) ? a : b;
    }

    function _addSpend(Assessment memory a, address token, uint256 amount) internal pure {
        for (uint256 i = 0; i < a.spendCount; i++) {
            if (a.spendTokens[i] == token) {
                a.spendAmounts[i] = _satAdd(a.spendAmounts[i], amount);
                return;
            }
        }
        a.spendTokens[a.spendCount] = token;
        a.spendAmounts[a.spendCount] = amount;
        a.spendCount++;
    }

    function _windowSpent(address account, address token) internal view returns (uint256) {
        Spent memory sp = spent[token][account];
        if (block.timestamp >= uint256(sp.windowStart) + WINDOW) return 0;
        return sp.amount;
    }

    function _commit(address account, Assessment memory a) internal {
        for (uint256 i = 0; i < a.spendCount; i++) {
            Spent storage sp = spent[a.spendTokens[i]][account];
            if (block.timestamp >= uint256(sp.windowStart) + WINDOW) {
                sp.windowStart = uint48(block.timestamp);
                sp.amount = 0;
            }
            uint256 total = _satAdd(sp.amount, a.spendAmounts[i]);
            sp.amount = total > type(uint128).max ? type(uint128).max : uint128(total);
        }
        if (a.consumeSchedule != bytes32(0)) {
            delete scheduledAt[a.consumeSchedule][account];
            emit ScheduleExecuted(account, a.consumeSchedule);
        }
    }

    function _satAdd(uint256 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            uint256 z = x + y;
            return z < x ? type(uint256).max : z;
        }
    }

    // ───────────────────────── ERC-1271 ─────────────────────────

    /// @dev TODO(上線前)：改用 ERC-7739 防禦性重雜湊，並限制 DAILY 金鑰可簽的 EIP-712 domain，
    ///      避免 DAILY 金鑰被誘騙簽下 Permit／Permit2 授權而繞過權限矩陣（規格 §11）。
    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata data) external view returns (bytes4) {
        SignatureData memory sd = abi.decode(data, (SignatureData));
        Key memory k = _keys[sd.keyId][msg.sender];
        if (k.keyClass == KeyClass.NONE) return ERC1271_INVALID;
        if (!WebAuthnLib.verify(abi.encodePacked(hash), sd.sig, k.rpIdHash, k.qx, k.qy)) return ERC1271_INVALID;
        return ERC1271_MAGIC;
    }

    // ───────────────────────── 金鑰管理（msg.sender = 身分帳戶） ─────────────────────────

    function addDailyKey(bytes32 qx, bytes32 qy, bytes32 rpIdHash) external {
        _requireInit(msg.sender);
        _addKey(msg.sender, qx, qy, rpIdHash, KeyClass.DAILY);
    }

    /// @notice 綁定 CAFECA 卡。發卡方在鏈下驗證卡片 attestation 後簽署
    ///         keccak256(chainId, account, qx, qy, rpIdHash, cardSerialHash)。
    function addMasterKey(
        bytes32 qx,
        bytes32 qy,
        bytes32 rpIdHash,
        bytes32 cardSerialHash,
        bytes calldata issuerSig
    ) external {
        _requireInit(msg.sender);
        address issuer = ECDSA.recover(cardAttestationDigest(msg.sender, qx, qy, rpIdHash, cardSerialHash), issuerSig);
        if (!ICardIssuerRegistry(cardIssuerRegistry).isCardIssuer(issuer)) revert InvalidCardAttestation();
        _addKey(msg.sender, qx, qy, rpIdHash, KeyClass.MASTER);
    }

    function removeKey(bytes32 keyId) external {
        _removeKey(msg.sender, keyId);
    }

    function setLimits(address token, uint128 perTx, uint128 daily) external {
        _requireInit(msg.sender);
        _setLimits(msg.sender, token, perTx, daily);
    }

    /// @param action Action 列舉值
    /// @param payload ADD_DAILY: (qx,qy,rpIdHash)；REMOVE_KEY: (keyId)；SET_LIMITS: (token,perTx,daily)；
    ///                MODULE: 呼叫帳戶 installModule/uninstallModule 的完整 calldata
    function schedule(uint8 action, bytes calldata payload) external returns (bytes32 h) {
        _requireInit(msg.sender);
        h = keccak256(abi.encode(action, payload));
        uint48 readyAt = uint48(block.timestamp) + _delayOf(msg.sender, action, payload);
        scheduledAt[h][msg.sender] = readyAt;
        emit Scheduled(msg.sender, h, action, readyAt);
    }

    function executeScheduled(uint8 action, bytes calldata payload) external {
        bytes32 h = keccak256(abi.encode(action, payload));
        uint48 ready = scheduledAt[h][msg.sender];
        if (ready == 0 || ready > block.timestamp) revert NotReady();
        delete scheduledAt[h][msg.sender];

        if (action == uint8(Action.ADD_DAILY)) {
            (bytes32 qx, bytes32 qy, bytes32 rp) = abi.decode(payload, (bytes32, bytes32, bytes32));
            _addKey(msg.sender, qx, qy, rp, KeyClass.DAILY);
        } else if (action == uint8(Action.REMOVE_KEY)) {
            _removeKey(msg.sender, abi.decode(payload, (bytes32)));
        } else if (action == uint8(Action.SET_LIMITS)) {
            (address token, uint128 perTx, uint128 daily) = abi.decode(payload, (address, uint128, uint128));
            _setLimits(msg.sender, token, perTx, daily);
        } else {
            revert ScheduleViaInstallModule();
        }
        emit ScheduleExecuted(msg.sender, h);
    }

    function cancel(bytes32 actionHash) external {
        delete scheduledAt[actionHash][msg.sender];
        emit ScheduleCancelled(msg.sender, actionHash);
    }

    // ───────────────────────── 恢復模組介面 ─────────────────────────

    function applyRecovery(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, bool wipe) external {
        if (msg.sender != recovery) revert OnlyRecovery();
        if (wipe) {
            bytes32[] storage list = _keyList[account];
            for (uint256 i = 0; i < list.length; i++) {
                delete _keys[list[i]][account];
            }
            delete _keyList[account];
            AccountState storage st = accountState[account];
            st.keyCount = 0;
            st.masterCount = 0;
            emit KeysWiped(account);
        }
        _addKey(account, qx, qy, rpIdHash, KeyClass.DAILY);
    }

    /// @notice R1 恢復：驗證卡片對 challenge 的簽章，且卡片螢幕顯示的內容符合 expectedCtxd
    function verifyMasterSignature(address account, bytes32 challenge, bytes calldata sigData, bytes32 expectedCtxd)
        external
        view
        returns (bool)
    {
        SignatureData memory sd = abi.decode(sigData, (SignatureData));
        Key memory k = _keys[sd.keyId][account];
        if (k.keyClass != KeyClass.MASTER) return false;
        if ((WebAuthnLib.flags(sd.sig.authenticatorData) & WebAuthnLib.FLAG_BE) != 0) return false;
        (bool present, bytes32 ctxd) = WebAuthnLib.extractCtxd(sd.sig.authenticatorData);
        if (!present || ctxd != expectedCtxd) return false;
        return WebAuthnLib.verify(abi.encodePacked(challenge), sd.sig, k.rpIdHash, k.qx, k.qy);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    function keyIdOf(bytes32 qx, bytes32 qy) public pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy));
    }

    function getKey(address account, bytes32 keyId) external view returns (Key memory) {
        return _keys[keyId][account];
    }

    function masterCount(address account) external view returns (uint256) {
        return accountState[account].masterCount;
    }

    function isMasterMode(address account) external view returns (bool) {
        return accountState[account].masterCount > 0;
    }

    function cardAttestationDigest(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, bytes32 cardSerialHash)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("CAFECA_CARD", block.chainid, account, qx, qy, rpIdHash, cardSerialHash))
        );
    }

    // ───────────────────────── 內部 ─────────────────────────

    function _requireInit(address account) internal view {
        if (!accountState[account].initialized) revert NotInitialized();
    }

    function _addKey(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, KeyClass cls) internal {
        bytes32 keyId = keyIdOf(qx, qy);
        Key storage k = _keys[keyId][account];
        if (k.keyClass != KeyClass.NONE) revert KeyExists();
        _keys[keyId][account] = Key(qx, qy, rpIdHash, cls, uint48(block.timestamp));
        _keyList[account].push(keyId);
        AccountState storage st = accountState[account];
        st.keyCount++;
        if (cls == KeyClass.MASTER) st.masterCount++;
        emit KeyAdded(account, keyId, cls);
    }

    function _removeKey(address account, bytes32 keyId) internal {
        Key memory k = _keys[keyId][account];
        if (k.keyClass == KeyClass.NONE) revert KeyNotFound();
        AccountState storage st = accountState[account];
        if (st.keyCount <= 1) revert LastKey();
        delete _keys[keyId][account];
        st.keyCount--;
        if (k.keyClass == KeyClass.MASTER) st.masterCount--;
        emit KeyRemoved(account, keyId);
    }

    function _setLimits(address account, address token, uint128 perTx, uint128 daily) internal {
        limits[token][account] = Limit(perTx, daily);
        emit LimitsSet(account, token, perTx, daily);
    }

    function _delayOf(address account, uint8 action, bytes calldata payload) internal view returns (uint48) {
        if (action == uint8(Action.REMOVE_KEY)) {
            bytes32 keyId = abi.decode(payload, (bytes32));
            return _keys[keyId][account].keyClass == KeyClass.MASTER ? DELAY_REMOVE_MASTER : DELAY_DAILY;
        }
        if (action == uint8(Action.MODULE)) return DELAY_MODULE;
        return DELAY_DAILY;
    }
}
