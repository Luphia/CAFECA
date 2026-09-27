// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title JwksRegistry
/// @notice Google／Apple 的 JWKS 公鑰清單。沒有 owner，只接受 Boltchain 共識層的系統地址寫入：
///         驗證者各自抓取 JWKS，同一公鑰獲 ⅔ 投票權重後，由區塊提議者以系統交易寫入。
/// @dev keyHash = keccak256(abi.encode(modulus, exponent)) >> 8（落在 BN254 field，供電路使用）
contract JwksRegistry {
    uint8 public constant ISSUER_GOOGLE = 1;
    uint8 public constant ISSUER_APPLE = 2;
    uint48 public constant GRACE_PERIOD = 72 hours;

    struct KeyInfo {
        uint8 issuer;
        uint48 addedAt;
        uint48 retiredAt; // 0 = 仍在 JWKS 中
    }

    address public immutable systemCaller;
    mapping(bytes32 keyHash => KeyInfo) public keys;

    event KeyAdded(bytes32 indexed keyHash, uint8 issuer);
    event KeyRetired(bytes32 indexed keyHash, uint48 validUntil);

    error OnlySystem();

    constructor(address systemCaller_) {
        systemCaller = systemCaller_;
    }

    modifier onlySystem() {
        if (msg.sender != systemCaller) revert OnlySystem();
        _;
    }

    function addKey(bytes32 keyHash, uint8 issuer) external onlySystem {
        keys[keyHash] = KeyInfo(issuer, uint48(block.timestamp), 0);
        emit KeyAdded(keyHash, issuer);
    }

    /// @notice 公鑰從 JWKS 消失時呼叫；保留 72 小時寬限期
    function retireKey(bytes32 keyHash) external onlySystem {
        KeyInfo storage k = keys[keyHash];
        if (k.addedAt == 0 || k.retiredAt != 0) return;
        k.retiredAt = uint48(block.timestamp);
        emit KeyRetired(keyHash, uint48(block.timestamp) + GRACE_PERIOD);
    }

    function isKnown(bytes32 keyHash) external view returns (bool) {
        return keys[keyHash].addedAt != 0;
    }

    /// @notice 回傳公鑰有效期限（供 validator 放進 validationData 的 validUntil，避免在驗證階段讀 TIMESTAMP）
    /// @return 0 = 未知公鑰；type(uint48).max = 仍有效
    function validUntilOf(bytes32 keyHash) external view returns (uint48) {
        KeyInfo memory k = keys[keyHash];
        if (k.addedAt == 0) return 0;
        if (k.retiredAt == 0) return type(uint48).max;
        return k.retiredAt + GRACE_PERIOD;
    }
}
