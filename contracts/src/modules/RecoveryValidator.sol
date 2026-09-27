// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {
    IValidator,
    IERC7579Execution,
    Execution,
    MODULE_TYPE_VALIDATOR,
    CALLTYPE_SINGLE,
    VALIDATION_FAILED,
    ERC1271_INVALID
} from "../interfaces/IERC7579.sol";
import {ExecLib} from "../lib/ExecLib.sol";

interface IKeyringForRecovery {
    function applyRecovery(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, bool wipe) external;
    function keyIdOf(bytes32 qx, bytes32 qy) external pure returns (bytes32);
    function masterCount(address account) external view returns (uint256);
}

interface IGuardianAuthorityRegistry {
    function isGuardianAuthority(address signer) external view returns (bool);
}

/// @title RecoveryValidator（平台備援金鑰）
/// @notice 使用者以身分證件＋引導式臉部影像完成 KYC 後，平台為這個身分產生一把「備援金鑰」並託管在 HSM。
///         備援金鑰等級高於裝置金鑰：裝置金鑰與卡片都無法移除或更換它，但它能做的事被刻意限縮為一件——
///         「在時間鎖之後，以一把新裝置金鑰取代所有裝置金鑰」。
///
///         被盜風險的緩解（規格 §5.3）：
///         1. 權限最小化：不能轉帳、不能調額度、不能動通道或模組、不能移除卡片。
///         2. 時間鎖：48 小時；已綁卡的帳戶 7 天（有卡的人可以用卡片立即恢復，不需要平台）。
///            期間主帳戶轉出凍結，所有裝置與卡片都會收到通知，任何一把裝置金鑰或卡片都能取消。
///         3. 冷卻：取消後 7 天內不能再發起。
///         4. 爭議升級：若裝置金鑰取消了恢復（可能是本人，也可能是盜用裝置的人），平台人工複核後可發起
///            「升級恢復」（7 天），此時只有卡片能取消。
///         5. 金鑰輪替：每個帳戶一把獨立的備援金鑰（單一金鑰外洩只影響一個帳戶）；若外洩，
///            由離線保存的平台根金鑰（guardian authority）直接輪替或撤銷，並清除進行中的恢復。
/// @dev 驗證階段不讀 TIMESTAMP：冷卻與時間鎖以 validationData 的 validAfter 交給 EntryPoint 檢查。
contract RecoveryValidator is IValidator {
    struct Pending {
        bool active;
        bool escalated;
        uint48 readyAt;
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
    }

    struct State {
        address guardian;
        uint48 cooldownUntil;
        uint48 disputedAt;
        uint64 nonce;
    }

    uint48 public constant DELAY = 48 hours;
    uint48 public constant DELAY_WITH_CARD = 7 days;
    uint48 public constant DELAY_ESCALATED = 7 days;
    uint48 public constant COOLDOWN = 7 days;
    uint48 public constant DISPUTE_WINDOW = 30 days;

    IKeyringForRecovery public immutable keyring;
    IGuardianAuthorityRegistry public immutable authority;

    mapping(address account => Pending) public pending;
    mapping(address account => State) public state;

    event GuardianSet(address indexed account, address guardian);
    event GuardianRotated(address indexed account, address oldGuardian, address newGuardian);
    event RecoveryInitiated(address indexed account, bytes32 newKeyId, uint48 readyAt, bool escalated);
    event RecoveryExecuted(address indexed account, bytes32 newKeyId);
    event RecoveryCancelled(address indexed account, bool byGuardian);

    error AlreadyPending();
    error NoPendingRecovery();
    error NotReady();
    error InCooldown();
    error NoGuardian();
    error GuardianAlreadySet();
    error InvalidAuthority();
    error NotDisputed();

    constructor(address keyring_, address authority_) {
        keyring = IKeyringForRecovery(keyring_);
        authority = IGuardianAuthorityRegistry(authority_);
    }

    // ───────────────────────── 模組 ─────────────────────────

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external pure {
        revert("Recovery: cannot uninstall");
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_INVALID; // 備援金鑰不能用來做一般簽章（登入、Permit 等）
    }

    // ───────────────────────── 驗證 ─────────────────────────

    /// @dev 只允許 execute(single) 呼叫本合約：
    ///      - initiateRecovery / guardianCancel：UserOp.signature = 備援金鑰對 userOpHash 的 ECDSA 簽章
    ///      - executeRecovery：時間鎖到期後任何人可送（signature 可為空）
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external view returns (uint256) {
        address account = userOp.sender;
        if (userOp.callData.length < 4 || bytes4(userOp.callData[0:4]) != IERC7579Execution.execute.selector) {
            return VALIDATION_FAILED;
        }
        (bytes32 mode, bytes memory ec) = abi.decode(userOp.callData[4:], (bytes32, bytes));
        if (mode[0] != CALLTYPE_SINGLE) return VALIDATION_FAILED;
        Execution memory e = ExecLib.decodeSingleMem(ec);
        if (e.target != address(this) || e.value != 0) return VALIDATION_FAILED;

        bytes4 sel = ExecLib.selector(e.callData);
        Pending memory p = pending[account];
        if (sel == this.executeRecovery.selector) {
            address who = abi.decode(ExecLib.args(e.callData), (address));
            if (who != account || !p.active) return VALIDATION_FAILED;
            return _packValidationData(false, 0, p.readyAt);
        }

        State memory st = state[account];
        if (st.guardian == address(0)) return VALIDATION_FAILED;
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(userOpHash), userOp.signature);
        if (err != ECDSA.RecoverError.NoError || signer != st.guardian) return VALIDATION_FAILED;

        if (sel == this.guardianCancel.selector) {
            return p.active ? 0 : VALIDATION_FAILED;
        }
        if (sel != this.initiateRecovery.selector) return VALIDATION_FAILED;
        if (p.active) return VALIDATION_FAILED;
        (,,, bool escalated) = abi.decode(ExecLib.args(e.callData), (bytes32, bytes32, bytes32, bool));
        if (escalated && st.disputedAt == 0) return VALIDATION_FAILED;
        return _packValidationData(false, 0, escalated ? 0 : st.cooldownUntil);
    }

    // ───────────────────────── 備援金鑰的安裝與輪替 ─────────────────────────

    /// @notice KYC 通過後由使用者的裝置金鑰送出（msg.sender = 身分帳戶）。只能安裝一次，之後無法由帳戶更換或移除。
    /// @param authoritySig 平台根金鑰對 guardianDigest(account, guardian, nonce) 的簽章，證明這是平台託管的金鑰
    function setGuardian(address guardian, bytes calldata authoritySig) external {
        State storage st = state[msg.sender];
        if (st.guardian != address(0)) revert GuardianAlreadySet();
        if (guardian == address(0)) revert NoGuardian();
        _checkAuthority(msg.sender, guardian, st.nonce, authoritySig);
        st.guardian = guardian;
        st.nonce++;
        emit GuardianSet(msg.sender, guardian);
    }

    /// @notice 平台根金鑰輪替（備援金鑰疑似外洩）或撤銷（newGuardian = 0，使用者重新驗證後申請停用）。
    ///         任何人可代送，只看根金鑰簽章；會一併清除進行中的恢復。
    function rotateGuardian(address account, address newGuardian, bytes calldata authoritySig) external {
        State storage st = state[account];
        if (st.guardian == address(0)) revert NoGuardian();
        _checkAuthority(account, newGuardian, st.nonce, authoritySig);
        emit GuardianRotated(account, st.guardian, newGuardian);
        st.guardian = newGuardian;
        st.nonce++;
        if (pending[account].active) {
            delete pending[account];
            emit RecoveryCancelled(account, true);
        }
    }

    function _checkAuthority(address account, address guardian, uint64 n, bytes calldata sig) internal view {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(guardianDigest(account, guardian, n), sig);
        if (err != ECDSA.RecoverError.NoError || !authority.isGuardianAuthority(signer)) revert InvalidAuthority();
    }

    // ───────────────────────── 恢復 ─────────────────────────

    /// @notice 備援金鑰發起恢復（msg.sender = 身分帳戶，經本 validator 驗證）
    /// @param escalated 爭議升級：僅在裝置金鑰取消過恢復後的 30 天內，且平台人工複核通過才會使用
    function initiateRecovery(bytes32 qx, bytes32 qy, bytes32 rpIdHash, bool escalated) external {
        address account = msg.sender;
        State storage st = state[account];
        if (st.guardian == address(0)) revert NoGuardian();
        if (pending[account].active) revert AlreadyPending();
        uint48 delay;
        if (escalated) {
            if (st.disputedAt == 0 || block.timestamp > uint256(st.disputedAt) + DISPUTE_WINDOW) revert NotDisputed();
            st.disputedAt = 0;
            delay = DELAY_ESCALATED;
        } else {
            if (block.timestamp < st.cooldownUntil) revert InCooldown();
            delay = keyring.masterCount(account) > 0 ? DELAY_WITH_CARD : DELAY;
        }
        st.cooldownUntil = uint48(block.timestamp) + COOLDOWN;
        uint48 readyAt = uint48(block.timestamp) + delay;
        pending[account] = Pending(true, escalated, readyAt, qx, qy, rpIdHash);
        emit RecoveryInitiated(account, keyring.keyIdOf(qx, qy), readyAt, escalated);
    }

    /// @notice 時間鎖到期後任何人可觸發：清除所有裝置金鑰，安裝新裝置金鑰（卡片保留）
    function executeRecovery(address account) external {
        Pending memory p = pending[account];
        if (!p.active) revert NoPendingRecovery();
        if (block.timestamp < p.readyAt) revert NotReady();
        delete pending[account];
        state[account].disputedAt = 0;
        keyring.applyRecovery(account, p.qx, p.qy, p.rpIdHash, true);
        emit RecoveryExecuted(account, keyring.keyIdOf(p.qx, p.qy));
    }

    /// @notice 裝置金鑰或卡片取消（經 KeyringValidator 驗證；升級恢復只接受卡片）。取消後冷卻 7 天。
    function cancelRecovery() external {
        Pending memory p = pending[msg.sender];
        if (!p.active) revert NoPendingRecovery();
        delete pending[msg.sender];
        State storage st = state[msg.sender];
        st.cooldownUntil = uint48(block.timestamp) + COOLDOWN;
        if (!p.escalated) st.disputedAt = uint48(block.timestamp);
        emit RecoveryCancelled(msg.sender, false);
    }

    /// @notice 平台自行撤回（例如使用者來電說明是誤操作）
    function guardianCancel() external {
        if (!pending[msg.sender].active) revert NoPendingRecovery();
        delete pending[msg.sender];
        emit RecoveryCancelled(msg.sender, true);
    }

    // ───────────────────────── 查詢 ─────────────────────────

    function isPending(address account) external view returns (bool) {
        return pending[account].active;
    }

    function isEscalated(address account) external view returns (bool) {
        Pending memory p = pending[account];
        return p.active && p.escalated;
    }

    function guardianOf(address account) external view returns (address) {
        return state[account].guardian;
    }

    function guardianDigest(address account, address guardian, uint64 n) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("CAFECA_GUARDIAN", block.chainid, address(this), account, guardian, n))
        );
    }
}
