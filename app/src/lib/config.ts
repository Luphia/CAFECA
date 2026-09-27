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
  jwks: Address;
  attestation: Address;
  deviceDirectory: Address;
  paymaster: Address;
  oidcVerifier: Address;
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

export const PUBLIC = {
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
  appleClientId: process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "",
  devLogin: process.env.NEXT_PUBLIC_DEV_LOGIN === "1",
};

/** 金鑰類別、權限需求（對應 KeyringValidator 的 enum） */
export const KeyClass = { NONE: 0, DAILY: 1, MASTER: 2 } as const;
export const Req = { REJECT: 0, DAILY: 1, MASTER: 2 } as const;
export const Action = { ADD_DAILY: 0, REMOVE_KEY: 1, SET_LIMITS: 2, MODULE: 3 } as const;
export const ChannelType = { AGENT: 0, CARD: 1, MERCHANT: 2 } as const;
export const RecoveryPath = { NONE: 0, R1_CARD: 1, R2_REKYC: 2, R3_OIDC_ONLY: 3 } as const;

export const OP_KIND_LABEL: Record<number, string> = {
  0: "未知合約操作",
  1: "轉帳",
  2: "授權",
  3: "新增日常金鑰",
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
};
