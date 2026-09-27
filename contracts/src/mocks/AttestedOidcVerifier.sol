// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IOidcVerifier} from "../interfaces/IOidcVerifier.sol";

/// @title AttestedOidcVerifier（測試網替代方案）
/// @notice ZK 電路完成前，由 CAFECA OIDC 驗證服務在鏈下驗證 Google／Apple 的 JWT，
///         再對公開輸入簽章。信任模型是「信任驗證服務」，正式上線必須換成 Groth16 驗證器。
contract AttestedOidcVerifier is IOidcVerifier {
    address public immutable attestor;

    constructor(address attestor_) {
        attestor = attestor_;
    }

    function digest(uint256[4] calldata publicInputs) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("CAFECA_OIDC", block.chainid, address(this), publicInputs))
        );
    }

    function verify(uint256[4] calldata publicInputs, bytes calldata proof) external view returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest(publicInputs), proof);
        return err == ECDSA.RecoverError.NoError && signer == attestor;
    }
}
