import "server-only";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

/**
 * 稽核紀錄（規格 §16.6 P2）：append-only、hash-chained。
 *
 * 每筆紀錄 = { seq, at, who, action, …detail, prev, hash }，hash = SHA-256(prev ‖ 其餘欄位的正規化 JSON)。
 * 竄改、刪除或插入任一筆，之後所有 hash 都對不上，verifyAudit() 會指出第一筆斷掉的位置。
 * 涵蓋：複核後台登入、檢視證件、KYC 決策、法人驗證、額度調整、資料調閱（申請、核准、放行、下載）。
 *
 * 正式環境建議把每日最後一筆的 hash 寫上鏈或交給第三方時戳，才能證明整份紀錄沒有被整批重寫。
 */

const FILE = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "audit", "audit.jsonl");
/** 舊版（P0-b）的未串接紀錄，保留供查閱 */
export const LEGACY_FILE = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "kyc", "review-log.jsonl");

export type AuditEntry = { seq: number; at: string; who: string; action: string; prev: string; hash: string; [k: string]: unknown };

const GENESIS = "0".repeat(64);

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function hashOf(e: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(String(e.prev)).update(canonical(e)).digest("hex");
}

/** 最後一筆的快取；檔案大小改變（例如 npm run cutover 等其他程序寫入）時重新讀取 */
let tail: { seq: number; hash: string; size: number } | null = null;
let lock: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<AuditEntry[]> {
  const text = await fs.readFile(FILE(), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}

async function loadTail() {
  const size = (await fs.stat(FILE()).catch(() => null))?.size ?? 0;
  if (tail && tail.size === size) return tail;
  const all = await readAll();
  const last = all[all.length - 1];
  tail = last ? { seq: last.seq, hash: last.hash, size } : { seq: 0, hash: GENESIS, size };
  return tail;
}

/** 寫入一筆稽核紀錄（序列化，確保 hash 鏈不分岔） */
export function writeAudit(e: { who: string; action: string; [k: string]: unknown }): Promise<AuditEntry> {
  const run = async () => {
    const t = await loadTail();
    const base = { ...JSON.parse(JSON.stringify(e)), seq: t.seq + 1, at: new Date().toISOString(), prev: t.hash } as Omit<AuditEntry, "hash">;
    const entry = { ...base, hash: hashOf(base) } as AuditEntry;
    await fs.mkdir(path.dirname(FILE()), { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(FILE(), line);
    tail = { seq: entry.seq, hash: entry.hash, size: t.size + Buffer.byteLength(line) };
    return entry;
  };
  const next = lock.then(run, run);
  lock = next.catch(() => undefined);
  return next;
}

/** 全部紀錄（依序） */
export const readAuditEntries = () => readAll();

export async function verifyAudit(): Promise<{ ok: boolean; count: number; head: string; brokenAt?: number; reason?: string }> {
  const all = await readAll();
  let prev = GENESIS;
  for (let i = 0; i < all.length; i++) {
    const { hash, ...rest } = all[i];
    if (rest.seq !== i + 1) return { ok: false, count: all.length, head: prev, brokenAt: i + 1, reason: "序號不連續（有紀錄被刪除或插入）" };
    if (rest.prev !== prev) return { ok: false, count: all.length, head: prev, brokenAt: rest.seq, reason: "prev 與上一筆不符" };
    if (hashOf(rest) !== hash) return { ok: false, count: all.length, head: prev, brokenAt: rest.seq, reason: "內容與 hash 不符（紀錄被修改）" };
    prev = hash;
  }
  return { ok: true, count: all.length, head: prev };
}

export async function listAudit(p: { limit?: number; before?: number; action?: string; subject?: string } = {}): Promise<AuditEntry[]> {
  const all = await readAll();
  const out: AuditEntry[] = [];
  for (let i = all.length - 1; i >= 0 && out.length < (p.limit ?? 100); i--) {
    const e = all[i];
    if (p.before && e.seq >= p.before) continue;
    if (p.action && !e.action.startsWith(p.action)) continue;
    if (p.subject && !JSON.stringify(e).toLowerCase().includes(p.subject.toLowerCase())) continue;
    out.push(e);
  }
  return out;
}
