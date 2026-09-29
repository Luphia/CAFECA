import "server-only";
import { promises as fs } from "fs";
import path from "path";

/** 原型用的 JSON 檔案儲存（data/store.json）。正式環境換成資料庫。 */

export type ChatEnvelope = { iv: string; ct: string };
export type ChatMessage = {
  id: string;
  from: string; // address 或 "system"
  to: string;
  fromDevice?: string;
  kind: "text" | "pay.request" | "pay.receipt" | "pay.transfer" | "agent.intent" | "system";
  /** 端對端加密內容：deviceId → 密文（system 訊息為明文 body） */
  envelopes?: Record<string, ChatEnvelope>;
  body?: unknown;
  ts: number;
};

export type AgentRecord = {
  owner: string;
  name: string;
  salt: string;
  operatorKey: string; // 測試網：伺服器保管（代表 TEE），正式版放在 TDX enclave
  operator: string;
  channel?: string;
  createdAt: number;
  log: { ts: number; text: string; tx?: string }[];
};

export type VisaAuth = {
  id: string;
  channel: string;
  owner: string;
  merchant: string;
  amount: string;
  status: "authorized" | "captured" | "released";
  captured?: string;
  txs: string[];
  ts: number;
};

export type Store = {
  handles: Record<string, string>; // handle → address
  profiles: Record<string, { handle: string; iss: string; createdAt: number }>;
  messages: ChatMessage[];
  agents: Record<string, AgentRecord>; // id → record
  visa: VisaAuth[];
  visaChannels: Record<string, string>; // owner → channel
  /** 模擬 KYC 單位保存的紀錄：身分證字號只存 HMAC，用於重新 KYC 恢復時比對本人 */
  kyc: Record<string, KycRecord>;
  /** 活體驗證挑戰（一次性） */
  kycChallenges: Record<string, { code: string; actions: string[]; exp: number; used: boolean }>;
  /** 實體卡訂單：以鏈上付款交易為憑 */
  cardOrders: Record<string, CardOrder>;
  /** 裝置配對 session：新裝置只知道自己的公鑰，既有裝置確認後把身分地址回填 */
  pairings: Record<string, Pairing>;
  /** 票券（活動、交通等），由票券發行方簽章，持有人以數位身分出示 */
  tickets: Record<string, Ticket>;
  /** 身分狀態同步進度（處理到哪個區塊的 RecoveryExecuted） */
  identitySync?: { lastBlock: number; log: { account: string; block: number; action: "reattest" | "suspend" | "skip"; tx?: string; at: number }[] };
};

export type Ticket = {
  owner: string;
  kind: "event" | "transit" | "coupon";
  title: string;
  subtitle: string;
  venue: string;
  startsAt: number;
  seat?: string;
  issuer: string;
  issuedAt: number;
};

export type Pairing = { qx: string; qy: string; rpIdHash: string; name: string; exp: number; createdAt: number; address?: string };

export type KycRecord = {
  level: number;
  ts: number;
  idHash?: string;
  /** KYC 案件（證件僅保存浮水印版；原始影像從未離開使用者裝置） */
  cases?: KycCase[];
};

export type KycCase = {
  id: string;
  purpose: "onboard" | "recover";
  createdAt: number;
  challenge: string;
  files: { front: string; back: string; face: string };
  hashes: { front: string; back: string; face: string };
  actions: { action: string; startedAt: number; completedAt: number; peak: number }[];
  docFeatures: unknown;
  /** 後台處理結果（團隊自建：OCR、活體重檢、人臉比對、翻拍偵測） */
  status: "pending" | "approved" | "review" | "rejected";
  checks: Record<string, { ok: boolean; detail: string }>;
  fields?: { name?: string; birthday?: string; idNumberHash?: string } | null;
};

export type CardOrder = { owner: string; txHash: string; amount: string; paidAt: number; used: boolean; replaces?: string; issuedFor?: string };

const FILE = path.join(process.cwd(), "data", "store.json");
const EMPTY: Store = { handles: {}, profiles: {}, messages: [], agents: {}, visa: [], visaChannels: {}, kyc: {}, kycChallenges: {}, cardOrders: {}, pairings: {}, tickets: {} };

let lock: Promise<unknown> = Promise.resolve();

async function load(): Promise<Store> {
  try {
    return { ...EMPTY, ...JSON.parse(await fs.readFile(FILE, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function read(): Promise<Store> {
  await lock.catch(() => undefined);
  return load();
}

export function update<T>(fn: (s: Store) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const s = await load();
    const out = await fn(s);
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(FILE + ".tmp", JSON.stringify(s, null, 2));
    await fs.rename(FILE + ".tmp", FILE);
    return out;
  };
  const next = lock.then(run, run);
  lock = next.catch(() => undefined);
  return next;
}
