// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CafecaAccount} from "../account/CafecaAccount.sol";
import {IOidcVerifier, OidcNonce} from "../interfaces/IOidcVerifier.sol";
import {JwksRegistry} from "../registry/JwksRegistry.sol";
import {KeyringValidator} from "../modules/KeyringValidator.sol";

/// @title IdentityAccountFactory
/// @notice account = CREATE2(idCommitment)。部署時驗證 OIDC ZK 證明，
///         證明的 nonce 綁定第一把 passkey，被攔截的 JWT 也無法拿去綁別的金鑰（規格 §3.2、§4.4）。
/// @dev 以 UserOp initCode 呼叫（工廠需在 EntryPoint 質押，才能讀取 JwksRegistry）。
///      不檢查 JWT 是否過期：舊證明重放只會把「同一把 passkey」綁到「同一個帳戶」，沒有危害。
contract IdentityAccountFactory {
    struct BindParams {
        bytes32 qx;
        bytes32 qy;
        bytes32 rpIdHash;
        bytes32 jwksKeyHash;
        uint64 expiry;
        bytes proof;
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

    /// @dev nonce 只綁定 passkey 公鑰，不含帳戶地址：登入前還不知道 sub，也就算不出地址。
    ///      帳戶地址由 idCommitment 決定，證明本身已把 idCommitment 與 nonce 綁在一起。
    function bindNonce(bytes32 qx, bytes32 qy, bytes32 rpIdHash, uint64 expiry) public view returns (uint256) {
        return OidcNonce.toField(keccak256(abi.encode("bind", block.chainid, address(this), qx, qy, rpIdHash, expiry)));
    }

    function createAccount(bytes32 idCommitment, BindParams calldata b) external returns (address account) {
        account = getAddress(idCommitment);
        if (account.code.length > 0) return account;

        if (!jwks.isKnown(b.jwksKeyHash)) revert UnknownJwksKey();
        uint256[4] memory pub = [
            uint256(idCommitment),
            uint256(b.jwksKeyHash),
            bindNonce(b.qx, b.qy, b.rpIdHash, b.expiry),
            uint256(b.expiry)
        ];
        if (!verifier.verify(pub, b.proof)) revert InvalidProof();

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
