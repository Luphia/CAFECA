// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title IdentityRegistry（v2，規格 §16.2）
/// @notice 給依賴方（relying party）使用的身分證明：主體類型（自然人／法人）、等級、效期、管轄地，
///         以及可撤銷、可暫停、不可重送的狀態。鏈上只放等級與 claimsRoot，個資原文不上鏈。
/// @dev 與 v1 AttestationRegistry 並存：v1 仍供 KeyringValidator 的綁卡門檻使用，CAFECA 後台雙寫。
///      每個帳戶有遞增的 nonce，attest／suspend／revoke 都必須帶「目前 nonce + 1」，舊簽章無法重送。
contract IdentityRegistry is EIP712 {
    // ───────────────────────── 常數 ─────────────────────────

    uint8 public constant SUBJECT_PERSON = 0;
    uint8 public constant SUBJECT_ENTITY = 1;

    uint8 public constant LEVEL_L0 = 0;
    uint8 public constant LEVEL_L1 = 1; // 手機驗證，不是實名
    uint8 public constant LEVEL_L2 = 2; // 證件＋活體（自然人）或登記資料＋代表人 L2（法人）

    /// @notice 簽章者等級：依賴方可只接受 PRODUCTION
    enum SignerClass {
        NONE,
        PROTOTYPE,
        PRODUCTION
    }

    enum Status {
        NONE,
        ACTIVE,
        SUSPENDED,
        REVOKED
    }

    /// @notice 撤銷／暫停原因碼（固定，依賴方據此處理）
    uint8 public constant REASON_USER_REQUEST = 1;
    uint8 public constant REASON_EVIDENCE_INVALID = 2; // 證據異常、偽造
    uint8 public constant REASON_ENTITY_DISSOLVED = 3; // 法人解散／撤銷／停業
    uint8 public constant REASON_REPRESENTATIVE_CHANGED = 4; // 法人代表人異動，待重驗
    uint8 public constant REASON_RECOVERED = 5; // 身分恢復後待重驗
    uint8 public constant REASON_SIGNER_RETIRED = 6;
    uint8 public constant REASON_OTHER = 255;

    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "Attest(address account,uint8 subjectType,uint8 level,uint48 expiry,bytes32 claimsRoot,bytes2 jurisdiction,uint64 nonce)"
    );
    bytes32 public constant STATUS_TYPEHASH =
        keccak256("StatusChange(address account,uint8 status,uint8 reason,uint64 nonce)");

    // ───────────────────────── 狀態 ─────────────────────────

    struct Attestation {
        uint8 subjectType;
        uint8 level;
        Status status;
        uint48 expiry;
        uint48 issuedAt;
        bytes2 jurisdiction; // ISO 3166-1 alpha-2，例 "TW"
        uint64 nonce;
        address signer;
        bytes32 claimsRoot;
    }

    address public governance;
    address public pendingGovernance;
    mapping(address signer => SignerClass) public signerClass;
    mapping(address account => Attestation) internal _att;
    /// @notice 帳戶目前的 nonce；下一次 attest／suspend／revoke 必須帶 nonceOf + 1
    mapping(address account => uint64) public nonceOf;

    // ───────────────────────── 事件（格式固定，依賴方鏡像進帳本） ─────────────────────────

    event Attested(
        address indexed account,
        uint8 subjectType,
        uint8 level,
        uint48 expiry,
        bytes32 claimsRoot,
        bytes2 jurisdiction,
        address signer,
        uint64 nonce
    );
    event Suspended(address indexed account, uint8 reason, address by, uint64 nonce);
    event Revoked(address indexed account, uint8 reason, address by, uint64 nonce);
    event SignerSet(address indexed signer, SignerClass signerClass);
    event GovernanceTransferStarted(address indexed from, address indexed to);
    event GovernanceTransferred(address indexed from, address indexed to);

    error OnlyGovernance();
    error InvalidSigner();
    error BadNonce(uint64 expected);
    error BadSubject();
    error BadLevel();
    error Expired();
    error NotActive();

    constructor(address governance_) EIP712("CAFECA IdentityRegistry", "2") {
        governance = governance_;
        emit GovernanceTransferred(address(0), governance_);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    // ───────────────────────── 治理 ─────────────────────────

    function setSigner(address signer, SignerClass cls) external onlyGovernance {
        signerClass[signer] = cls;
        emit SignerSet(signer, cls);
    }

    /// @notice 兩段式轉移治理權（v1 的 governance 為 immutable，這裡改為可轉移到多簽或治理合約）
    function transferGovernance(address to) external onlyGovernance {
        pendingGovernance = to;
        emit GovernanceTransferStarted(governance, to);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert OnlyGovernance();
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
    }

    // ───────────────────────── 簽署內容 ─────────────────────────

    function attestDigest(
        address account,
        uint8 subjectType,
        uint8 level,
        uint48 expiry,
        bytes32 claimsRoot,
        bytes2 jurisdiction,
        uint64 nonce
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(ATTEST_TYPEHASH, account, subjectType, level, expiry, claimsRoot, jurisdiction, nonce))
        );
    }

    function statusDigest(address account, Status status, uint8 reason, uint64 nonce) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(STATUS_TYPEHASH, account, uint8(status), reason, nonce)));
    }

    // ───────────────────────── 寫入（任何人可代送，只要附上有效簽章） ─────────────────────────

    /// @notice 簽發或更新證明。新的證明會覆蓋暫停狀態（例如恢復後重新驗證通過）
    function attest(
        address account,
        uint8 subjectType,
        uint8 level,
        uint48 expiry,
        bytes32 claimsRoot,
        bytes2 jurisdiction,
        uint64 nonce,
        bytes calldata sig
    ) external {
        if (subjectType > SUBJECT_ENTITY) revert BadSubject();
        if (level > LEVEL_L2) revert BadLevel();
        if (expiry <= block.timestamp) revert Expired();
        _useNonce(account, nonce);
        address signer =
            ECDSA.recover(attestDigest(account, subjectType, level, expiry, claimsRoot, jurisdiction, nonce), sig);
        if (signerClass[signer] == SignerClass.NONE) revert InvalidSigner();
        _att[account] = Attestation({
            subjectType: subjectType,
            level: level,
            status: Status.ACTIVE,
            expiry: expiry,
            issuedAt: uint48(block.timestamp),
            jurisdiction: jurisdiction,
            nonce: nonce,
            signer: signer,
            claimsRoot: claimsRoot
        });
        emit Attested(account, subjectType, level, expiry, claimsRoot, jurisdiction, signer, nonce);
    }

    /// @notice 暫停（可由新的 attest 恢復）：簽章者簽署，或治理直接呼叫（sig 為空）
    function suspend(address account, uint8 reason, uint64 nonce, bytes calldata sig) external {
        address by = _authorize(account, Status.SUSPENDED, reason, nonce, sig);
        Attestation storage a = _att[account];
        if (a.status != Status.ACTIVE) revert NotActive();
        a.status = Status.SUSPENDED;
        a.nonce = nonce;
        emit Suspended(account, reason, by, nonce);
    }

    /// @notice 撤銷：簽章者簽署，或治理直接呼叫（sig 為空）。之後只有新的 attest 能再次建立證明
    function revoke(address account, uint8 reason, uint64 nonce, bytes calldata sig) external {
        address by = _authorize(account, Status.REVOKED, reason, nonce, sig);
        _revoke(account, reason, by, nonce);
    }

    /// @notice 使用者自己撤銷自己的實名證明（由身分合約呼叫）
    function revokeSelf(uint8 reason) external {
        uint64 nonce = nonceOf[msg.sender] + 1;
        nonceOf[msg.sender] = nonce;
        _revoke(msg.sender, reason, msg.sender, nonce);
    }

    function _revoke(address account, uint8 reason, address by, uint64 nonce) internal {
        Attestation storage a = _att[account];
        if (a.status == Status.NONE || a.status == Status.REVOKED) revert NotActive();
        a.status = Status.REVOKED;
        a.nonce = nonce;
        emit Revoked(account, reason, by, nonce);
    }

    function _authorize(address account, Status status, uint8 reason, uint64 nonce, bytes calldata sig)
        internal
        returns (address by)
    {
        _useNonce(account, nonce);
        if (sig.length == 0) {
            if (msg.sender != governance) revert OnlyGovernance();
            return msg.sender;
        }
        by = ECDSA.recover(statusDigest(account, status, reason, nonce), sig);
        if (signerClass[by] == SignerClass.NONE) revert InvalidSigner();
    }

    function _useNonce(address account, uint64 nonce) internal {
        uint64 expected = nonceOf[account] + 1;
        if (nonce != expected) revert BadNonce(expected);
        nonceOf[account] = nonce;
    }

    // ───────────────────────── 讀取 ─────────────────────────

    /// @notice 完整狀態。effectiveLevel：ACTIVE、未過期、簽章者仍有效時才等於 level，否則為 0
    function statusOf(address account)
        external
        view
        returns (
            uint8 subjectType,
            uint8 level,
            uint8 effectiveLevel,
            Status status,
            uint48 expiry,
            uint48 issuedAt,
            bytes2 jurisdiction,
            uint64 nonce,
            address signer,
            SignerClass signerCls,
            bytes32 claimsRoot
        )
    {
        Attestation memory a = _att[account];
        return (
            a.subjectType,
            a.level,
            _effective(a),
            a.status,
            a.expiry,
            a.issuedAt,
            a.jurisdiction,
            a.nonce,
            a.signer,
            signerClass[a.signer],
            a.claimsRoot
        );
    }

    function levelOf(address account) external view returns (uint8) {
        return _effective(_att[account]);
    }

    /// @notice 只計入 PRODUCTION 簽章者的等級（依賴方要求正式實名時使用）
    function productionLevelOf(address account) external view returns (uint8) {
        Attestation memory a = _att[account];
        return signerClass[a.signer] == SignerClass.PRODUCTION ? _effective(a) : LEVEL_L0;
    }

    /// @notice 與 v1 AttestationRegistry 相容的讀取介面（CafecaPaymaster 使用）；level 為有效等級
    function attestations(address account)
        external
        view
        returns (uint8 level, uint48 expiry, bytes32 claimsRoot, address signer)
    {
        Attestation memory a = _att[account];
        return (_effective(a), a.expiry, a.claimsRoot, a.signer);
    }

    function isKycSigner(address signer) external view returns (bool) {
        return signerClass[signer] != SignerClass.NONE;
    }

    function _effective(Attestation memory a) internal view returns (uint8) {
        if (a.status != Status.ACTIVE || a.expiry < block.timestamp || signerClass[a.signer] == SignerClass.NONE) {
            return LEVEL_L0;
        }
        return a.level;
    }
}
