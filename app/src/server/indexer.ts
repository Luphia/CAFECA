import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { decodeEventLog, getAddress, parseAbi, type Address, type Hex, type Log } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { publicClient } from "./chain";

/**
 * 伺服器端鏈上事件索引（規格 §16.6 P0-d）
 *
 * Boltchain RPC 的 eth_getLogs 每次最多 10,000 個區塊，瀏覽器不該再從部署區塊掃描整條鏈。
 * 這裡由伺服器持續同步 CAFECA 相關事件，錢包與後台改讀索引 API：
 *   - TWDC Transfer（錢包紀錄、聊天中的轉帳）
 *   - KeyringValidator KeyAdded／KeyRemoved／KeysWiped／LimitsSetByAdmin（Passkey 登入反查身分、額度紀錄）
 *   - IdentityRegistry Attested／Suspended／Revoked（實名狀態歷程）
 *   - RecoveryValidator RecoveryExecuted（恢復後重新簽發或暫停）
 *   - MemberValidator MemberSet／MemberAuthorized／LimitsSetByAdmin、EntityAccountFactory EntityCreated（法人帳戶）
 *
 * 儲存：data/index/events.jsonl（append-only）＋ state.json（同步到哪個區塊）。
 * 每次同步都一次查詢所有合約（每段 ≤ 10,000 區塊），並重掃最後 REORG_DEPTH 個區塊，以 (tx, logIndex) 去重。
 * 部署位址改變（例如重新部署）時自動重建。
 */

const MAX_RANGE = 10_000n;
const REORG_DEPTH = 5n;
const MIN_INTERVAL_MS = 2_000;
const DIR = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "index");

const ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 keyClass)",
  "event KeyRemoved(address indexed account, bytes32 indexed keyId)",
  "event KeysWiped(address indexed account)",
  "event LimitsSetByAdmin(address indexed account, address indexed token, uint128 perTx, uint128 daily, uint8 reason, address admin)",
  "event Attested(address indexed account, uint8 subjectType, uint8 level, uint48 expiry, bytes32 claimsRoot, bytes2 jurisdiction, address signer, uint64 nonce)",
  "event Suspended(address indexed account, uint8 reason, address by, uint64 nonce)",
  "event Revoked(address indexed account, uint8 reason, address by, uint64 nonce)",
  "event RecoveryExecuted(address indexed account, bytes32 newKeyId)",
  "event MemberSet(address indexed entity, address indexed member, uint8 role)",
  "event MemberAuthorized(address indexed entity, address indexed member, bytes32 indexed userOpHash)",
  "event EntityCreated(address indexed entity, address indexed firstAdmin, bytes32 salt)",
]);

/** 每個合約只接受它自己的事件（例如 Transfer 只收 TWDC 的） */
function sources(): Record<string, string[]> {
  const d = DEPLOYMENT;
  const m: Record<string, string[]> = {
    [d.twdc]: ["Transfer"],
    [d.keyring]: ["KeyAdded", "KeyRemoved", "KeysWiped", "LimitsSetByAdmin"],
    [d.recovery]: ["RecoveryExecuted"],
  };
  if (d.identityRegistry) m[d.identityRegistry] = ["Attested", "Suspended", "Revoked"];
  if (d.memberValidator) m[d.memberValidator] = ["MemberSet", "MemberAuthorized", "LimitsSetByAdmin"];
  if (d.entityFactory) m[d.entityFactory] = ["EntityCreated"];
  return Object.fromEntries(Object.entries(m).filter(([a]) => a && a !== "0x0000000000000000000000000000000000000000").map(([a, v]) => [a.toLowerCase(), v]));
}

export type IndexedEvent = {
  /** 事件名稱 */
  e: string;
  /** 發出事件的合約 */
  c: Address;
  b: number;
  /** 區塊時間（毫秒） */
  t: number;
  tx: Hex;
  li: number;
  /** 事件參數（bigint 以十進位字串保存） */
  a: Record<string, string | number | boolean>;
};

type State = { v: 1; fingerprint: string; lastBlock: number };

let events: IndexedEvent[] = [];
let seen = new Set<string>();
let state: State | null = null;
let loaded: Promise<void> | null = null;
let syncing: Promise<number> | null = null;
let lastSync = 0;
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const fingerprint = () => JSON.stringify(sources()) + ":" + DEPLOYMENT.startBlock + ":" + DEPLOYMENT.chainId;
const key = (tx: string, li: number) => `${tx}:${li}`;

async function load() {
  const fp = fingerprint();
  try {
    const st = JSON.parse(await fs.readFile(path.join(DIR(), "state.json"), "utf8")) as State;
    if (st.v !== 1 || st.fingerprint !== fp) throw new Error("deployment changed");
    const text = await fs.readFile(path.join(DIR(), "events.jsonl"), "utf8").catch(() => "");
    const list: IndexedEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        list.push(JSON.parse(line));
      } catch {
        /* 最後一行可能寫到一半 */
      }
    }
    events = list;
    seen = new Set(list.map((x) => key(x.tx, x.li)));
    state = st;
  } catch {
    events = [];
    seen = new Set();
    state = { v: 1, fingerprint: fp, lastBlock: DEPLOYMENT.startBlock - 1 };
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(path.join(DIR(), "events.jsonl"), "");
    await saveState();
  }
}

async function saveState() {
  await fs.mkdir(DIR(), { recursive: true });
  await fs.writeFile(path.join(DIR(), "state.json.tmp"), JSON.stringify(state));
  await fs.rename(path.join(DIR(), "state.json.tmp"), path.join(DIR(), "state.json"));
}

function plain(v: unknown): string | number | boolean {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

async function fetchRange(lo: bigint, hi: bigint) {
  const src = sources();
  const logs = (await publicClient.getLogs({ address: Object.keys(src) as Address[], fromBlock: lo, toBlock: hi })) as Log[];
  const out: Omit<IndexedEvent, "t">[] = [];
  for (const l of logs) {
    const allow = src[l.address.toLowerCase()];
    if (!allow) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }) as unknown as typeof ev;
    } catch {
      continue;
    }
    if (!allow.includes(ev.eventName)) continue;
    out.push({
      e: ev.eventName,
      c: getAddress(l.address),
      b: Number(l.blockNumber),
      tx: l.transactionHash!,
      li: Number(l.logIndex),
      a: Object.fromEntries(Object.entries(ev.args).map(([k, v]) => [k, typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : plain(v)])),
    });
  }
  return out;
}

const blockTs = new Map<number, number>();
async function tsOf(b: number) {
  let t = blockTs.get(b);
  if (t === undefined) {
    t = Number((await publicClient.getBlock({ blockNumber: BigInt(b) })).timestamp) * 1000;
    blockTs.set(b, t);
    if (blockTs.size > 5000) blockTs.delete(blockTs.keys().next().value!);
  }
  return t;
}

async function runSync(): Promise<number> {
  await (loaded ??= load());
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  const start = BigInt(Math.max(DEPLOYMENT.startBlock, state!.lastBlock + 1 - Number(REORG_DEPTH)));
  if (head < start) return state!.lastBlock;
  for (let lo = start; lo <= head; lo += MAX_RANGE) {
    const hi = lo + MAX_RANGE - 1n < head ? lo + MAX_RANGE - 1n : head;
    const fresh = (await fetchRange(lo, hi)).filter((x) => !seen.has(key(x.tx, x.li)));
    const withTs: IndexedEvent[] = [];
    for (const x of fresh) withTs.push({ ...x, t: await tsOf(x.b) });
    if (withTs.length) {
      await fs.appendFile(path.join(DIR(), "events.jsonl"), withTs.map((x) => JSON.stringify(x)).join("\n") + "\n");
      for (const x of withTs) {
        seen.add(key(x.tx, x.li));
        events.push(x);
      }
    }
    state!.lastBlock = Number(hi);
    await saveState();
  }
  return state!.lastBlock;
}

/**
 * 同步到最新區塊（多個呼叫共用同一次同步；2 秒內不重複同步）。
 * 第一次呼叫時也會啟動背景同步（每 5 秒），讓 API 大多直接讀到最新資料。
 */
export async function syncIndex(opts: { force?: boolean } = {}): Promise<number> {
  if (!timer && process.env.NODE_ENV !== "test") {
    timer = setInterval(() => syncIndex().catch(() => undefined), 5_000);
    timer.unref?.();
  }
  if (syncing) return syncing;
  if (!opts.force && state && Date.now() - lastSync < MIN_INTERVAL_MS) return state.lastBlock;
  syncing = runSync()
    .then((b) => {
      lastError = null;
      return b;
    })
    .catch((e: Error) => {
      lastError = e.message.slice(0, 300);
      throw e;
    })
    .finally(() => {
      syncing = null;
      lastSync = Date.now();
    });
  return syncing;
}

/** 讀取前先同步；RPC 暫時失敗時仍回傳已索引的資料 */
async function ready() {
  await syncIndex().catch(() => undefined);
  await (loaded ??= load());
}

export async function indexStatus() {
  await ready();
  const head = await publicClient.getBlockNumber({ cacheTime: 0 }).catch(() => null);
  return { lastBlock: state!.lastBlock, head: head === null ? null : Number(head), events: events.length, lastSync, lastError, startBlock: DEPLOYMENT.startBlock };
}

const eq = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b;

export type TransferRow = { hash: Hex; logIndex: number; from: Address; to: Address; value: string; block: number; ts: number };

/** 帳戶的 TWDC 轉帳（新到舊）；before 為分頁游標（區塊號，不含） */
export async function transfersOf(account: Address, limit = 50, before?: number): Promise<{ transfers: TransferRow[]; lastBlock: number }> {
  await ready();
  const me = account.toLowerCase();
  const out: TransferRow[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const x = events[i];
    if (x.e !== "Transfer" || (before !== undefined && x.b >= before)) continue;
    if (!eq(x.a.from, me) && !eq(x.a.to, me)) continue;
    out.push({ hash: x.tx, logIndex: x.li, from: x.a.from as Address, to: x.a.to as Address, value: String(x.a.value), block: x.b, ts: x.t });
  }
  // events 依寫入順序（大致依區塊）；同一批內依區塊、logIndex 由新到舊排序
  out.sort((p, q) => q.block - p.block || q.logIndex - p.logIndex);
  return { transfers: out, lastBlock: state!.lastBlock };
}

/** 曾經加入這把金鑰、而且之後沒有被移除或清除的帳戶（呼叫端仍應以 getKey 確認） */
export async function accountsOfKey(keyId: Hex): Promise<Address[]> {
  await ready();
  const k = keyId.toLowerCase();
  const alive = new Map<string, Address>();
  for (const x of events) {
    if (x.c.toLowerCase() !== DEPLOYMENT.keyring.toLowerCase()) continue;
    const acct = String(x.a.account ?? "").toLowerCase();
    if (x.e === "KeyAdded" && eq(x.a.keyId, k)) alive.set(acct, x.a.account as Address);
    else if (x.e === "KeyRemoved" && eq(x.a.keyId, k)) alive.delete(acct);
    else if (x.e === "KeysWiped") alive.delete(acct);
  }
  return [...alive.values()];
}

/** 任意事件查詢（後台用）：依事件名稱與參數篩選，新到舊 */
export async function queryEvents(p: { names: string[]; contract?: Address; where?: Record<string, string>; afterBlock?: number; limit?: number }): Promise<IndexedEvent[]> {
  await ready();
  const out: IndexedEvent[] = [];
  const lim = p.limit ?? 200;
  for (let i = events.length - 1; i >= 0 && out.length < lim; i--) {
    const x = events[i];
    if (!p.names.includes(x.e)) continue;
    if (p.contract && x.c.toLowerCase() !== p.contract.toLowerCase()) continue;
    if (p.afterBlock !== undefined && x.b <= p.afterBlock) continue;
    if (p.where && !Object.entries(p.where).every(([k, v]) => eq(x.a[k], v.toLowerCase()) || String(x.a[k]) === v)) continue;
    out.push(x);
  }
  return out.sort((a, b) => b.b - a.b || b.li - a.li);
}

export function indexedHead(): number | null {
  return state?.lastBlock ?? null;
}
