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
  kind: "text" | "pay.request" | "pay.receipt" | "agent.intent" | "system";
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
  kyc: Record<string, { level: number; ts: number }>;
};

const FILE = path.join(process.cwd(), "data", "store.json");
const EMPTY: Store = { handles: {}, profiles: {}, messages: [], agents: {}, visa: [], visaChannels: {}, kyc: {} };

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
