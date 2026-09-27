// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOidcVerifier} from "../interfaces/IOidcVerifier.sol";

/// @notice 測試用：proof == abi.encode(keccak256(abi.encode(publicInputs))) 即通過。
///         正式環境以電路產生的 Groth16 驗證合約取代。
contract MockOidcVerifier is IOidcVerifier {
    function verify(uint256[4] calldata publicInputs, bytes calldata proof) external pure returns (bool) {
        return keccak256(proof) == keccak256(abi.encode(keccak256(abi.encode(publicInputs))));
    }

    function makeProof(uint256[4] calldata publicInputs) external pure returns (bytes memory) {
        return abi.encode(keccak256(abi.encode(publicInputs)));
    }
}
