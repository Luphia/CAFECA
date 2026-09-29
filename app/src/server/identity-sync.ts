import "server-only";
import { getAddress, parseAbiItem, type Address } from "viem";
import { DEPLOYMENT, IdentityReason, IdentityStatus } from "@/lib/config";
import { publicClient } from "./chain";
import { attestIdentity, changeIdentityStatus, claimsRootOf, identityState } from "./identity";
import { read, update } from "./store";

const RECOVERY_EXECUTED = parseAbiItem("event RecoveryExecuted(address indexed account, bytes32 newKeyId)");
/** 恢復請求時重新驗證的案件，在這段時間內執行恢復才算數（時間鎖 48 小時／有卡 7 天，再留緩衝） */
const REVERIFY_WINDOW_MS = 14 * 24 * 3600 * 1000;

let running: Promise<SyncResult> | null = null;
let lastRun = 0;

export type SyncResult = { from: number; to: number; processed: { account: Address; action: "reattest" | "suspend" | "skip"; tx?: string }[] };

/**
 * 身分恢復之後的證明處理（規格 §16.2）：
 * - 恢復請求時已重新即時拍證件＋6 動作活體，且後台確認是同一人 → 以該案件重新簽發 v2 證明（nonce 遞增）
 * - 找不到有效的重新驗證 → 暫停（REASON_RECOVERED），使用者到 /kyc 重新驗證後自動解除
 * 依賴方可同時監聽 RecoveryValidator.RecoveryExecuted 與 IdentityRegistry 的事件。
 * 可重複呼叫（每個事件只處理一次），由恢復頁面在執行恢復後觸發，也可由排程定期呼叫 POST /api/identity/sync。
 */
export function syncRecoveries(): Promise<SyncResult> {
  if (running) return running;
  if (Date.now() - lastRun < 5_000) return Promise.resolve({ from: 0, to: 0, processed: [] });
  running = run().finally(() => {
    running = null;
    lastRun = Date.now();
  });
  return running;
}

async function run(): Promise<SyncResult> {
  if (!DEPLOYMENT.identityRegistry) return { from: 0, to: 0, processed: [] };
  const s = await read();
  const from = (s.identitySync?.lastBlock ?? DEPLOYMENT.startBlock - 1) + 1;
  const head = Number(await publicClient.getBlockNumber());
  const processed: SyncResult["processed"] = [];
  let done = from - 1;
  for (let lo = from; lo <= head; lo += 10_000) {
    const hi = Math.min(head, lo + 9_999);
    const logs = await publicClient.getLogs({ address: DEPLOYMENT.recovery, event: RECOVERY_EXECUTED, fromBlock: BigInt(lo), toBlock: BigInt(hi) });
    for (const l of logs) {
      const account = getAddress(l.args.account!);
      const block = Number(l.blockNumber);
      const r = await handleRecovery(account, block);
      processed.push({ account, ...r });
      await update((st) => {
        st.identitySync = {
          lastBlock: block - 1, // 同一區塊內的其他事件下次還會被掃到；已處理的會因狀態而跳過
          log: [...(st.identitySync?.log ?? []), { account, block, ...r, at: Date.now() }].slice(-200),
        };
      });
    }
    done = hi;
    await update((st) => {
      st.identitySync = { lastBlock: done, log: st.identitySync?.log ?? [] };
    });
  }
  return { from, to: done, processed };
}

async function handleRecovery(account: Address, block: number): Promise<{ action: "reattest" | "suspend" | "skip"; tx?: string }> {
  const st = await identityState(account);
  if (!st || st.status === IdentityStatus.NONE || st.status === IdentityStatus.REVOKED) return { action: "skip" };
  // 同一次恢復已處理過：證明是在恢復之後才簽發的
  const blk = await publicClient.getBlock({ blockNumber: BigInt(block) });
  if (st.issuedAt >= Number(blk.timestamp) || st.status === IdentityStatus.SUSPENDED) return { action: "skip" };

  const rec = Object.entries((await read()).kyc).find(([k]) => k.toLowerCase() === account.toLowerCase())?.[1];
  const recent = rec?.cases
    ?.filter((c) => c.purpose === "recover" && c.status === "approved" && c.checks.sameSubject?.ok)
    .filter((c) => Number(blk.timestamp) * 1000 - c.createdAt < REVERIFY_WINDOW_MS && c.createdAt <= Number(blk.timestamp) * 1000)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (recent) {
    const r = await attestIdentity(account, {
      subjectType: st.subjectType as 0 | 1,
      level: 2,
      claimsRoot: claimsRootOf(recent),
      expiry: Math.floor(Date.now() / 1000) + 365 * 86400,
      jurisdiction: "TW",
    });
    return { action: "reattest", tx: r.v2Tx };
  }
  const tx = await changeIdentityStatus(account, "suspend", IdentityReason.RECOVERED);
  return { action: "suspend", tx: tx ?? undefined };
}
