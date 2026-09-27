// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {CafecaAccount} from "../account/CafecaAccount.sol";
import {IOidcVerifier, OidcNonce} from "../interfaces/IOidcVerifier.sol";
import {JwksRegistry} from "../registry/JwksRegistry.sol";
import {KeyringValidator} from "../modules/KeyringValidator.sol";

/// @title IdentityAccountFactory
/// @notice account = CREATE2(idCommitment)。開戶順序（規格 §4.4）：
///         1. 瀏覽器產生一次性 ephemeral 金鑰，OIDC 登入的 nonce 綁定其地址（先建立身分）
///         2. 登入後在裝置建立 passkey，由 ephemeral 金鑰簽署「此身分綁定此 passkey」
///         3. 工廠驗證 OIDC 證明（nonce = ephemeral）＋ ephemeral 簽章
///         被攔截的 JWT 沒有 ephemeral 私鑰，無法綁定其他金鑰（與 zkLogin 相同模式）。
/// @dev 以 UserOp initCode 呼叫（工廠需在 EntryPoint 質押，才能讀取 JwksRegistry）。
///      驗證階段不讀 TIMESTAMP；expiry 只作為 nonce 的一部分，限制 ephemeral 授權的語意有效期（由鏈下檢查）。
contract IdentityAccountFactory {
    struct BindParams {
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
        bytes32 jwksKeyHash;
        address ephemeral; // 登入前產生的一次性金鑰地址
        uint64 expiry;
        bytes proof; // OIDC 證明（nonce = bindNonce(ephemeral, expiry)）
        bytes ephemeralSig; // ephemeral 對 bindAuthorizationDigest 的簽章
    }

    address public immutable accountImpl;
    address public immutable keyring;
    address public immutable recovery;
    JwksRegistry public immutable jwks;
    IOidcVerifier public immutable verifier;

    address public immutable defaultToken;
    uint128 public immutable defaultPerTx;
    uint128 public immutable defaultDaily;

    event AccountCreated(address indexed account, bytes32 indexed idCommitment);

    error UnknownJwksKey();
    error InvalidProof();
    error InvalidEphemeralSignature();

    constructor(
        address accountImpl_,
        address keyring_,
        address recovery_,
        address jwks_,
        address verifier_,
        address defaultToken_,
        uint128 defaultPerTx_,
        uint128 defaultDaily_
    ) {
        accountImpl = accountImpl_;
        keyring = keyring_;
        recovery = recovery_;
        jwks = JwksRegistry(jwks_);
        verifier = IOidcVerifier(verifier_);
        defaultToken = defaultToken_;
        defaultPerTx = defaultPerTx_;
        defaultDaily = defaultDaily_;
    }

    function getAddress(bytes32 idCommitment) public view returns (address) {
        return Clones.predictDeterministicAddress(accountImpl, idCommitment);
    }

    /// @notice 登入用的 nonce：只綁定 ephemeral 金鑰（登入時還沒有 passkey）
    function bindNonce(address ephemeral, uint64 expiry) public view returns (uint256) {
        return OidcNonce.toField(keccak256(abi.encode("bind", block.chainid, address(this), ephemeral, expiry)));
    }

    /// @notice ephemeral 金鑰簽署的授權：此身分承諾綁定此 passkey
    function bindAuthorizationDigest(bytes32 idCommitment, bytes32 qx, bytes32 qy, bytes32 rpIdHash)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("CAFECA_BIND_PASSKEY", block.chainid, address(this), idCommitment, qx, qy, rpIdHash))
        );
    }

    function createAccount(bytes32 idCommitment, BindParams calldata b) external returns (address account) {
        account = getAddress(idCommitment);
        if (account.code.length > 0) return account;

        if (!jwks.isKnown(b.jwksKeyHash)) revert UnknownJwksKey();
        uint256[4] memory pub = [
            uint256(idCommitment),
            uint256(b.jwksKeyHash),
            bindNonce(b.ephemeral, b.expiry),
            uint256(b.expiry)
        ];
        if (!verifier.verify(pub, b.proof)) revert InvalidProof();
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(bindAuthorizationDigest(idCommitment, b.qx, b.qy, b.rpIdHash), b.ephemeralSig);
        if (err != ECDSA.RecoverError.NoError || signer != b.ephemeral) revert InvalidEphemeralSignature();

        Clones.cloneDeterministic(accountImpl, idCommitment);

        address[] memory validators = new address[](2);
        validators[0] = keyring;
        validators[1] = recovery;

        KeyringValidator.LimitInit[] memory lims = new KeyringValidator.LimitInit[](1);
        lims[0] = KeyringValidator.LimitInit(defaultToken, defaultPerTx, defaultDaily);
        bytes[] memory vdata = new bytes[](2);
        vdata[0] = abi.encode(KeyringValidator.KeyInit(b.qx, b.qy, b.rpIdHash), lims);
        vdata[1] = abi.encode(idCommitment);

        CafecaAccount(payable(account)).initialize(validators, vdata, new address[](0), new bytes[](0));
        emit AccountCreated(account, idCommitment);
    }
}
