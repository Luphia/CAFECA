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
import {IOidcVerifier, OidcNonce} from "../interfaces/IOidcVerifier.sol";
import {ExecLib} from "../lib/ExecLib.sol";
import {OpKind, TxSummary, TxSummaryLib} from "../lib/TxSummary.sol";
import {JwksRegistry} from "../registry/JwksRegistry.sol";

interface IKeyringForRecovery {
    function applyRecovery(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, bool wipe) external;
    function verifyMasterSignature(address account, bytes32 challenge, bytes calldata sigData, bytes32 expectedCtxd)
        external
        view
        returns (bool);
    function masterCount(address account) external view returns (uint256);
    function keyIdOf(bytes32 qx, bytes32 qy) external pure returns (bytes32);
}

interface IKycSignerRegistry {
    function isKycSigner(address signer) external view returns (bool);
}

/// @title RecoveryValidator
/// @notice OIDC（Google／Apple）僅作為恢復憑證，三條路徑：
///         R1 OIDC＋卡片指紋：立即新增 DAILY 金鑰
///         R2 OIDC＋發卡方重新 KYC 簽章：48 小時後清除所有金鑰並新增 DAILY
///         R3 僅 OIDC：7 天後清除所有金鑰並新增 DAILY（主金鑰模式停用）
/// @dev 設計規格 §5。驗證階段不讀 TIMESTAMP：冷卻期、JWT 期限、JWKS 期限、時間鎖
///      都以 validationData 的 validAfter／validUntil 交給 EntryPoint 檢查。
///      讀取 JwksRegistry 不屬於帳戶關聯儲存，需 CAFECA bundler 放寬 ERC-7562（規格 §12）。
contract RecoveryValidator is IValidator {
    enum Path {
        NONE,
        R1_CARD,
        R2_REKYC,
        R3_OIDC_ONLY
    }

    struct OidcProof {
        bytes32 idCommitment;
        bytes32 jwksKeyHash;
        uint64 expiry;
        bytes proof;
    }

    struct RecoveryRequest {
        Path path;
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
        OidcProof oidc;
        bytes kycSig; // R2：KYC 單位簽章
        // R1 的卡片簽章放在 UserOp.signature（KeyringValidator.SignatureData），
        // 因為它要簽 userOpHash，而 userOpHash 涵蓋 callData，不能放在 callData 裡。
    }

    struct Pending {
        Path path;
        uint48 readyAt;
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
    }

    struct State {
        uint48 cooldownUntil;
        uint64 recoveryNonce;
    }

    uint48 public constant R2_DELAY = 48 hours;
    uint48 public constant R3_DELAY = 7 days;
    uint48 public constant COOLDOWN = 7 days;

    IKeyringForRecovery public immutable keyring;
    JwksRegistry public immutable jwks;
    IOidcVerifier public immutable verifier;
    IKycSignerRegistry public immutable kycRegistry;

    mapping(bytes32 idCommitment => mapping(address account => bool)) public isIdentityOf;
    mapping(address account => Pending) public pending;
    mapping(address account => State) public state;

    event IdentityLinked(address indexed account, bytes32 indexed idCommitment);
    event RecoveryInitiated(address indexed account, Path path, bytes32 newKeyId, uint48 readyAt);
    event RecoveryExecuted(address indexed account, Path path, bytes32 newKeyId);
    event RecoveryCancelled(address indexed account);

    error AlreadyPending();
    error NoPendingRecovery();
    error NotReady();
    error InCooldown();
    error InvalidPath();

    constructor(address keyring_, address jwks_, address verifier_, address kycRegistry_) {
        keyring = IKeyringForRecovery(keyring_);
        jwks = JwksRegistry(jwks_);
        verifier = IOidcVerifier(verifier_);
        kycRegistry = IKycSignerRegistry(kycRegistry_);
    }

    // ───────────────────────── 模組 ─────────────────────────

    /// @param data abi.encode(bytes32 idCommitment)
    function onInstall(bytes calldata data) external {
        bytes32 idc = abi.decode(data, (bytes32));
        isIdentityOf[idc][msg.sender] = true;
        emit IdentityLinked(msg.sender, idc);
    }

    function onUninstall(bytes calldata) external pure {
        revert("Recovery: cannot uninstall");
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_INVALID; // 恢復憑證不能用來做一般簽章
    }

    // ───────────────────────── 驗證 ─────────────────────────

    /// @dev 只允許 execute(single) 呼叫本合約的 initiateRecovery 或 executeRecovery
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external view returns (uint256) {
        address account = userOp.sender;
        if (userOp.callData.length < 4 || bytes4(userOp.callData[0:4]) != IERC7579Execution.execute.selector) {
            return VALIDATION_FAILED;
        }
        (bytes32 mode, bytes memory ec) = abi.decode(userOp.callData[4:], (bytes32, bytes));
        if (mode[0] != CALLTYPE_SINGLE) return VALIDATION_FAILED;
        (address target, uint256 value, bytes memory data) = _decodeSingle(ec);
        if (target != address(this) || value != 0) return VALIDATION_FAILED;

        bytes4 sel = ExecLib.selector(data);
        if (sel == this.executeRecovery.selector) {
            address who = abi.decode(ExecLib.args(data), (address));
            Pending memory p = pending[account];
            if (who != account || p.path == Path.NONE) return VALIDATION_FAILED;
            return _packValidationData(false, 0, p.readyAt);
        }
        if (sel != this.initiateRecovery.selector) return VALIDATION_FAILED;

        RecoveryRequest memory req = abi.decode(ExecLib.args(data), (RecoveryRequest));
        if (pending[account].path != Path.NONE) return VALIDATION_FAILED;
        (bool ok, uint48 validUntil) = _checkRequest(account, req, userOpHash, userOp.signature);
        if (!ok) return VALIDATION_FAILED;
        return _packValidationData(false, validUntil, state[account].cooldownUntil);
    }

    function _checkRequest(address account, RecoveryRequest memory req, bytes32 userOpHash, bytes calldata masterSig)
        internal
        view
        returns (bool ok, uint48 validUntil)
    {
        OidcProof memory o = req.oidc;
        if (!isIdentityOf[o.idCommitment][account]) return (false, 0);

        uint48 jwksUntil = jwks.validUntilOf(o.jwksKeyHash);
        if (jwksUntil == 0) return (false, 0);
        validUntil = o.expiry < jwksUntil ? uint48(o.expiry) : jwksUntil;

        uint256 nonce = recoveryNonce(account, req.qx, req.qy, req.rpIdHash, state[account].recoveryNonce, o.expiry);
        uint256[4] memory pub =
            [uint256(o.idCommitment), uint256(o.jwksKeyHash), nonce, uint256(o.expiry)];
        if (!verifier.verify(pub, o.proof)) return (false, 0);

        if (req.path == Path.R1_CARD) {
            bytes32 expected = TxSummaryLib.single(recoverySummary(account, req.qx, req.qy));
            if (masterSig.length == 0) return (false, 0);
            try keyring.verifyMasterSignature(account, userOpHash, masterSig, expected) returns (bool v) {
                ok = v;
            } catch {
                ok = false;
            }
        } else if (req.path == Path.R2_REKYC) {
            address signer = ECDSA.recover(
                rekycDigest(account, req.qx, req.qy, req.rpIdHash, state[account].recoveryNonce), req.kycSig
            );
            ok = kycRegistry.isKycSigner(signer);
        } else if (req.path == Path.R3_OIDC_ONLY) {
            ok = keyring.masterCount(account) == 0; // 主金鑰模式停用 R3
        } else {
            ok = false;
        }
    }

    // ───────────────────────── 執行 ─────────────────────────

    /// @dev msg.sender = 身分帳戶（經本 validator 驗證過的 UserOp）
    function initiateRecovery(RecoveryRequest calldata req) external {
        address account = msg.sender;
        if (pending[account].path != Path.NONE) revert AlreadyPending();
        State storage st = state[account];
        if (block.timestamp < st.cooldownUntil) revert InCooldown();
        st.recoveryNonce++;
        st.cooldownUntil = uint48(block.timestamp) + COOLDOWN;

        bytes32 newKeyId = keyring.keyIdOf(req.qx, req.qy);
        if (req.path == Path.R1_CARD) {
            keyring.applyRecovery(account, req.qx, req.qy, req.rpIdHash, false);
            emit RecoveryInitiated(account, req.path, newKeyId, uint48(block.timestamp));
            emit RecoveryExecuted(account, req.path, newKeyId);
            return;
        }
        uint48 delay;
        if (req.path == Path.R2_REKYC) delay = R2_DELAY;
        else if (req.path == Path.R3_OIDC_ONLY) delay = R3_DELAY;
        else revert InvalidPath();

        uint48 readyAt = uint48(block.timestamp) + delay;
        pending[account] = Pending(req.path, readyAt, req.qx, req.qy, req.rpIdHash);
        emit RecoveryInitiated(account, req.path, newKeyId, readyAt);
    }

    /// @notice 時間鎖到期後任何人可觸發
    function executeRecovery(address account) external {
        Pending memory p = pending[account];
        if (p.path == Path.NONE) revert NoPendingRecovery();
        if (block.timestamp < p.readyAt) revert NotReady();
        delete pending[account];
        keyring.applyRecovery(account, p.qx, p.qy, p.rpIdHash, true);
        emit RecoveryExecuted(account, p.path, keyring.keyIdOf(p.qx, p.qy));
    }

    /// @notice 任何現存金鑰可取消（經 KeyringValidator 驗證），取消後冷卻 7 天
    function cancelRecovery() external {
        if (pending[msg.sender].path == Path.NONE) revert NoPendingRecovery();
        delete pending[msg.sender];
        state[msg.sender].cooldownUntil = uint48(block.timestamp) + COOLDOWN;
        emit RecoveryCancelled(msg.sender);
    }

    // ───────────────────────── 查詢與雜湊 ─────────────────────────

    function isPending(address account) external view returns (bool) {
        return pending[account].path != Path.NONE;
    }

    function recoveryNonce(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, uint64 n, uint64 expiry)
        public
        view
        returns (uint256)
    {
        return OidcNonce.toField(keccak256(abi.encode("recover", block.chainid, account, qx, qy, rpIdHash, n, expiry)));
    }

    function rekycDigest(address account, bytes32 qx, bytes32 qy, bytes32 rpIdHash, uint64 n)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("CAFECA_REKYC", block.chainid, account, qx, qy, rpIdHash, n))
        );
    }

    /// @notice R1 時卡片螢幕應顯示的摘要
    function recoverySummary(address account, bytes32 qx, bytes32 qy) public view returns (TxSummary memory) {
        return TxSummary(uint8(OpKind.RECOVERY), block.chainid, address(0), 0, account, keyring.keyIdOf(qx, qy));
    }

    function _decodeSingle(bytes memory ec) internal pure returns (address, uint256, bytes memory) {
        Execution memory e = ExecLib.decodeSingleMem(ec);
        return (e.target, e.value, e.callData);
    }
}
