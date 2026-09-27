import { defineChain, type Address } from "viem";
import deployment from "../../deployments/boltchain-testnet.json";

export type Deployment = {
  chainId: number;
  deployed: boolean;
  entryPoint: Address;
  accountImpl: Address;
  factory: Address;
  keyring: Address;
  recovery: Address;
  channelValidator: Address;
  channelManager: Address;
  attestation: Address;
  deviceDirectory: Address;
  paymaster: Address;
  twdc: Address;
  startBlock: number;
};

export const DEPLOYMENT = deployment as Deployment;

export const CHAIN_ID = DEPLOYMENT.chainId;

/** 瀏覽器一律經由 /api/rpc 代理（避免 CORS 與 mixed content），伺服器直連 RPC_URL */
export const boltchain = defineChain({
  id: CHAIN_ID,
  name: "Boltchain Testnet",
  nativeCurrency: { name: "BOLT", symbol: "BOLT", decimals: 18 },
  rpcUrls: { default: { http: ["http://211.22.118.149:8545"] } },
  blockExplorers: { default: { name: "Boltchain Explorer", url: "http://211.22.118.149:8080" } },
});

export const EXPLORER = "http://211.22.118.149:8080";

export const TWDC_DECIMALS = 6;


/** 實體卡售價（測試網以 TWDC 支付給發卡方） */
export const CARD_PRICE_TWDC = "1200";

/** 金鑰類別、權限需求（對應 KeyringValidator 的 enum）：DAILY＝裝置金鑰（所有裝置同級），MASTER＝實體卡 */
export const KeyClass = { NONE: 0, DAILY: 1, MASTER: 2 } as const;
export const Req = { REJECT: 0, DAILY: 1, MASTER: 2 } as const;
export const Action = { ADD_DAILY: 0, REMOVE_KEY: 1, SET_LIMITS: 2, MODULE: 3 } as const;
export const ChannelType = { AGENT: 0, CARD: 1, MERCHANT: 2 } as const;

export const OP_KIND_LABEL: Record<number, string> = {
  0: "未知合約操作",
  1: "轉帳",
  2: "授權",
  3: "新增裝置金鑰",
  4: "綁定卡片",
  5: "移除金鑰",
  6: "排程變更",
  7: "執行排程",
  8: "取消排程",
  9: "調降額度",
  10: "調升額度",
  11: "建立支出通道",
  12: "放寬通道權限",
  13: "收緊通道權限",
  14: "核准 AI 請求",
  15: "模組變更",
  16: "聊天裝置",
  17: "取消恢復",
  18: "恢復：新增裝置",
  19: "啟用平台備援金鑰",
};
