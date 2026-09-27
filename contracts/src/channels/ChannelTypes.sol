// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

enum ChannelType {
    AGENT, // AI 代理
    CARD, // Visa 卡（發卡處理商）
    MERCHANT // 訂閱商家
}

/// @dev 骨架版本每個通道只使用單一代幣（平台穩定幣）
struct ChannelPolicy {
    address token;
    uint128 perTxLimit;
    uint128 dailyLimit;
    uint128 confirmThreshold; // 超過即需主人以卡片確認（AGENT）
    uint48 validUntil;
    address settlement; // CARD：清算收款地址
}

interface IChannelManager {
    function createChannel(uint8 channelType, address operator, ChannelPolicy calldata policy, bytes32 salt)
        external
        returns (address channel);
}

/// @notice 主帳戶（parent）對通道的控制函式；KeyringValidator 依 selector 判斷風險等級
interface IChannelControl {
    /// 放寬（需 MASTER）
    function updatePolicy(address channel, ChannelPolicy calldata policy) external;
    function allowTarget(address channel, address target) external;
    function approveIntent(address channel, uint256 intentId, address token, address to, uint256 amount) external;
    /// 收緊（任何金鑰立即生效）
    function restrictPolicy(address channel, ChannelPolicy calldata policy) external;
    function disallowTarget(address channel, address target) external;
    function revoke(address channel) external;
}
