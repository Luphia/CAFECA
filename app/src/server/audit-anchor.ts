import "server-only";
import type { Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { auditAnchorAbi } from "@/lib/contracts/abis";
import { readAuditEntries, verifyAudit, writeAudit } from "./audit";
import { operatorTx, publicClient } from "./chain";
import { read, update } from "./store";

/**
 * 稽核紀錄每日上鏈（規格 §16.6 P3-A6）：把 (筆數, 最新 hash) 寫進 AuditAnchor。
 * hash 鏈本身只能證明「沒有被改一筆」；有了鏈上錨點，連整份重寫（重新計算所有 hash）也驗得出來：
 * 第 count 筆的 hash 必須等於當天上鏈的 head。
 */

export async function anchorAudit(who: string) {
  const addr = DEPLOYMENT.auditAnchor;
  if (!addr) return { skipped: "尚未部署 AuditAnchor" };
  const v = await verifyAudit();
  if (!v.ok) {
    await writeAudit({ who, action: "audit.anchor.refused", brokenAt: v.brokenAt, reason: v.reason });
    return { refused: `稽核紀錄 hash 鏈斷裂（第 ${v.brokenAt} 筆），不上鏈` };
  }
  const last = Number(await publicClient.readContract({ address: addr, abi: auditAnchorAbi, functionName: "lastCount" }));
  if (v.count <= last) return { skipped: "沒有新的紀錄" };
  const rc = await operatorTx({ address: addr, abi: auditAnchorAbi, functionName: "anchor", args: [`0x${v.head}` as Hex, BigInt(v.count)] } as never);
  const a = { count: v.count, head: v.head, tx: rc.transactionHash, block: Number(rc.blockNumber), at: Date.now() };
  await update((s) => {
    s.auditAnchors ??= [];
    s.auditAnchors.push(a);
  });
  await writeAudit({ who, action: "audit.anchor", count: a.count, head: a.head, tx: a.tx });
  return a;
}

/** 以鏈上的 Anchored 事件核對目前的稽核紀錄（最近 30 次） */
export async function verifyAnchors() {
  const addr = DEPLOYMENT.auditAnchor;
  if (!addr) return { deployed: false as const, anchors: [], ok: true };
  const entries = await readAuditEntries();
  const list = ((await read()).auditAnchors ?? []).slice(-30);
  const anchors = [];
  let ok = true;
  for (const a of list) {
    let onchain: { head: string; count: number } | null = null;
    try {
      const r = await publicClient.getTransactionReceipt({ hash: a.tx as Hex });
      const log = r.logs.find((l) => l.address.toLowerCase() === addr.toLowerCase());
      if (log) onchain = { head: log.topics[1]!.slice(2), count: Number(BigInt(log.data.slice(0, 66))) };
    } catch {
      onchain = null;
    }
    const local = entries[a.count - 1]?.hash ?? null;
    const match = !!onchain && onchain.count === a.count && onchain.head === local;
    if (!match) ok = false;
    anchors.push({ ...a, onchain: !!onchain, match });
  }
  const lastCount = Number(await publicClient.readContract({ address: addr, abi: auditAnchorAbi, functionName: "lastCount" }).catch(() => 0n));
  return { deployed: true as const, address: addr, lastCount, anchors: anchors.reverse(), ok };
}

