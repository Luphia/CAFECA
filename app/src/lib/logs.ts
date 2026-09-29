/**
 * eth_getLogs 分段查詢。
 * Boltchain RPC 每次 eth_getLogs 最多 10,000 個區塊（超過會回 "block range too large (max 10000)"），
 * 所以所有從 DEPLOYMENT.startBlock 起算的事件查詢都要切段。
 */

export const MAX_LOG_RANGE = 10_000n;
const PARALLEL = 4;

function windows(from: bigint, to: bigint, newestFirst: boolean): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  if (to < from) return out;
  if (newestFirst) {
    for (let hi = to; hi >= from; hi -= MAX_LOG_RANGE) {
      const lo = hi - MAX_LOG_RANGE + 1n > from ? hi - MAX_LOG_RANGE + 1n : from;
      out.push([lo, hi]);
      if (lo === from) break;
    }
  } else {
    for (let lo = from; lo <= to; lo += MAX_LOG_RANGE) out.push([lo, lo + MAX_LOG_RANGE - 1n < to ? lo + MAX_LOG_RANGE - 1n : to]);
  }
  return out;
}

/** 完整掃描 [from, to]（每段 ≤ 10,000 區塊，同時最多 4 段） */
export async function logsInRange<T>(fetch: (lo: bigint, hi: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  const ws = windows(from, to, false);
  const out: T[] = [];
  for (let i = 0; i < ws.length; i += PARALLEL) {
    const parts = await Promise.all(ws.slice(i, i + PARALLEL).map(([lo, hi]) => fetch(lo, hi)));
    for (const p of parts) out.push(...p);
  }
  return out;
}

/** 由新到舊掃描，累積到至少 want 筆（或掃到 from）就停止；適合「最近 N 筆紀錄」 */
export async function recentLogs<T>(fetch: (lo: bigint, hi: bigint) => Promise<T[]>, from: bigint, to: bigint, want: number): Promise<T[]> {
  const ws = windows(from, to, true);
  const out: T[] = [];
  for (let i = 0; i < ws.length && out.length < want; i += PARALLEL) {
    const parts = await Promise.all(ws.slice(i, i + PARALLEL).map(([lo, hi]) => fetch(lo, hi)));
    for (const p of parts) out.push(...p);
  }
  return out;
}
