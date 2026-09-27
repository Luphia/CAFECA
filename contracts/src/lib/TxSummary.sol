// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice 卡片螢幕顯示的交易摘要。App 產生 abi.encode(TxSummary[]) 傳給卡片，
///         卡片顯示後把 sha256 寫入 WebAuthn 擴充 ctxd；鏈上由 calldata 重建並比對。
enum OpKind {
    UNKNOWN_CALL, // 0 無法摘要的任意合約呼叫（盲簽）
    TRANSFER, // 1 原生幣或 ERC-20 轉帳
    APPROVE, // 2 ERC-20 授權／NFT 全部授權
    KEY_ADD_DAILY, // 3
    KEY_ADD_MASTER, // 4
    KEY_REMOVE, // 5
    SCHEDULE, // 6 排程時間鎖變更
    EXECUTE_SCHEDULED, // 7
    CANCEL, // 8 取消排程
    LIMIT_LOWER, // 9
    LIMIT_RAISE, // 10
    CHANNEL_CREATE, // 11
    CHANNEL_RAISE, // 12
    CHANNEL_RESTRICT, // 13
    APPROVE_INTENT, // 14 核准 AI 超額請求
    MODULE, // 15 安裝／移除模組
    DEVICE, // 16 聊天裝置金鑰
    RECOVERY_CANCEL, // 17
    RECOVERY // 18 R1 恢復（卡片確認新增裝置）
}

struct TxSummary {
    uint8 kind;
    uint256 chainId;
    address token;
    uint256 amount;
    address counterparty;
    bytes32 extra;
}

library TxSummaryLib {
    function digest(TxSummary[] memory s) internal pure returns (bytes32) {
        return sha256(abi.encode(s));
    }

    function single(TxSummary memory s) internal pure returns (bytes32) {
        TxSummary[] memory arr = new TxSummary[](1);
        arr[0] = s;
        return digest(arr);
    }
}
