// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice OIDC JWT 的 ZK 證明驗證器（Groth16 驗證合約由電路產生後實作此介面）
/// 公開輸入：[idCommitment, jwksKeyHash, nonce, expiry]，皆需小於 BN254 scalar field
/// 電路證明：
///  1. JWT 的 RS256 簽章可由 jwksKeyHash 對應的公鑰驗證
///  2. Poseidon(iss, aud, sub, salt) == idCommitment
///  3. JWT.nonce == nonce
///  4. JWT 在簽發時未過期；expiry 是使用者在 nonce 中自選的有效期限（類似 zkLogin 的 max_epoch）
interface IOidcVerifier {
    function verify(uint256[4] calldata publicInputs, bytes calldata proof) external view returns (bool);
}

library OidcNonce {
    /// @dev 截掉高 8 bits，確保落在 BN254 scalar field 內
    function toField(bytes32 h) internal pure returns (uint256) {
        return uint256(h) >> 8;
    }
}
