import { defineChain, type Address } from "viem";

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
  /** IdentityRegistry v2（規格 §16.2）；舊部署沒有時為 undefined，程式退回讀 v1 */
  identityRegistry?: Address;
  deviceDirectory: Address;
  /** 法人帳戶（規格 §16.4）；舊部署沒有時為 undefined（npm run deploy -- --entity 增量部署） */
  memberValidator?: Address;
  auditAnchor?: Address;
  multisig?: Address;
  entityFactory?: Address;
  paymaster: Address;
  twdc: Address;
  startBlock: number;
};

/**
 * 部署位址由 next.config.ts 在啟動時讀入（優先 deployments/boltchain-testnet.local.json，
 * 沒有才用 git 追蹤的 deployments/boltchain-testnet.json），避免每個人部署後改到共用檔案。
 */
export const DEPLOYMENT = JSON.parse(process.env.NEXT_PUBLIC_CAFECA_DEPLOYMENT ?? "{}") as Deployment;

export const CHAIN_ID = DEPLOYMENT.chainId ?? 8018;

/** Boltchain 測試網公開 RPC（伺服器端可用 .env.local 的 RPC_URL 覆寫） */
export const BOLTCHAIN_RPC = "https://boltchain.cafeca.io";

/** 瀏覽器一律經由 /api/rpc 代理（避免 CORS 與 mixed content），伺服器直連 RPC_URL */
export const boltchain = defineChain({
  id: CHAIN_ID,
  name: "Boltchain Testnet",
  nativeCurrency: { name: "BOLT", symbol: "BOLT", decimals: 18 },
  rpcUrls: { default: { http: [BOLTCHAIN_RPC] } },
  blockExplorers: { default: { name: "Boltchain Explorer", url: "https://boltchain.cafeca.io" } },
});

export const EXPLORER = "https://boltchain.cafeca.io";

export const TWDC_DECIMALS = 6;


/** 實體卡售價（測試網以 TWDC 支付給發卡方） */
export const CARD_PRICE_TWDC = "1200";
/** 代稱設定後即固定；每次變更的費用 */
export const HANDLE_CHANGE_PRICE_TWDC = "150";

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

/** v2 身分狀態（IdentityRegistry.Status） */
export const IdentityStatus = { NONE: 0, ACTIVE: 1, SUSPENDED: 2, REVOKED: 3 } as const;
export const SignerClass = { NONE: 0, PROTOTYPE: 1, PRODUCTION: 2 } as const;
/** 撤銷／暫停原因碼（與合約一致） */
export const IdentityReason = {
  USER_REQUEST: 1,
  EVIDENCE_INVALID: 2,
  ENTITY_DISSOLVED: 3,
  REPRESENTATIVE_CHANGED: 4,
  RECOVERED: 5,
  SIGNER_RETIRED: 6,
  OTHER: 255,
} as const;
