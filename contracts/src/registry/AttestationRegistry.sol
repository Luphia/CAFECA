// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title AttestationRegistry
/// @notice 身分等級證明（L1 手機、L2 KYC）、發卡方清單與平台備援金鑰的根授權。
///         鏈上只存 claimsRoot（Merkle root），個資原文只在使用者裝置。
/// @dev KYC 單位與發卡方名單本質上需要治理，由 governance 管理（可設為 Boltchain 治理合約）。
contract AttestationRegistry {
    uint8 public constant LEVEL_L0 = 0;
    uint8 public constant LEVEL_L1 = 1;
    uint8 public constant LEVEL_L2 = 2;

    struct Attestation {
        uint8 level;
        uint48 expiry;
        bytes32 claimsRoot;
        address signer;
    }

    address public immutable governance;
    mapping(address => bool) public isKycSigner;
    mapping(address => bool) public isCardIssuer;
    /// @notice 平台根金鑰（離線保存）：授權安裝、輪替各帳戶的平台備援金鑰
    mapping(address => bool) public isGuardianAuthority;
    mapping(address account => Attestation) public attestations;

    event KycSignerSet(address indexed signer, bool allowed);
    event CardIssuerSet(address indexed issuer, bool allowed);
    event GuardianAuthoritySet(address indexed signer, bool allowed);
    event Attested(address indexed account, uint8 level, uint48 expiry, bytes32 claimsRoot, address signer);

    error OnlyGovernance();
    error InvalidSigner();

    constructor(address governance_) {
        governance = governance_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert OnlyGovernance();
        _;
    }

    function setKycSigner(address signer, bool allowed) external onlyGovernance {
        isKycSigner[signer] = allowed;
        emit KycSignerSet(signer, allowed);
    }

    function setCardIssuer(address issuer, bool allowed) external onlyGovernance {
        isCardIssuer[issuer] = allowed;
        emit CardIssuerSet(issuer, allowed);
    }

    function setGuardianAuthority(address signer, bool allowed) external onlyGovernance {
        isGuardianAuthority[signer] = allowed;
        emit GuardianAuthoritySet(signer, allowed);
    }

    function attestationDigest(address account, uint8 level, bytes32 claimsRoot, uint48 expiry)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), account, level, claimsRoot, expiry))
        );
    }

    /// @notice 任何人可代送，只要附上 KYC 單位的簽章
    function attest(address account, uint8 level, bytes32 claimsRoot, uint48 expiry, bytes calldata sig) external {
        address signer = ECDSA.recover(attestationDigest(account, level, claimsRoot, expiry), sig);
        if (!isKycSigner[signer]) revert InvalidSigner();
        attestations[account] = Attestation(level, expiry, claimsRoot, signer);
        emit Attested(account, level, expiry, claimsRoot, signer);
    }

    function levelOf(address account) external view returns (uint8) {
        Attestation memory a = attestations[account];
        return a.expiry >= block.timestamp ? a.level : LEVEL_L0;
    }
}
