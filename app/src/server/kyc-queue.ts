import "server-only";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { recoveryValidatorAbi } from "@/lib/contracts/abis";
import { execCall } from "@/lib/userop";
import { prepareUserOp, sendUserOp } from "./bundler";
import { publicClient } from "./chain";
import { guardianSigner } from "./guardian";
import { attestIdentity, claimsRootOf } from "./identity";
import { runPipeline, sameSubject } from "./kyc-pipeline";
import { read, update, type KycCase } from "./store";

/**
 * KYC 驗證工作佇列：收件後立刻回應，驗證在背景依序執行（模型推論約 10–30 秒）。
 * 伺服器重啟後，狀態仍為 pending／processing 的案件會重新排入。
 */
const g = globalThis as unknown as { __kycQueue?: { items: { account: string; id: string }[]; running: boolean; booted: boolean } };
const q = (g.__kycQueue ??= { items: [], running: false, booted: false });

const keyOf = (s: Awaited<ReturnType<typeof read>>, account: string) => Object.keys(s.kyc).find((k) => k.toLowerCase() === account.toLowerCase());

export async function findCase(account: string, id: string): Promise<KycCase | undefined> {
  const s = await read();
  const k = keyOf(s, account);
  return k ? s.kyc[k].cases?.find((c) => c.id === id) : undefined;
}

export async function saveCase(account: string, c: KycCase, patch?: (rec: NonNullable<Awaited<ReturnType<typeof read>>["kyc"][string]>) => void) {
  await update((s) => {
    const k = keyOf(s, account) ?? getAddress(account);
    const rec = (s.kyc[k] ??= { level: 0, ts: Date.now(), cases: [] });
    rec.cases = [...(rec.cases ?? []).filter((x) => x.id !== c.id), c];
    rec.ts = Date.now();
    patch?.(rec);
  });
}

export function enqueue(account: string, id: string) {
  q.items.push({ account, id });
  void drain();
}

async function boot() {
  if (q.booted) return;
  q.booted = true;
  const s = await read();
  for (const [account, rec] of Object.entries(s.kyc)) {
    for (const c of rec.cases ?? []) if (c.status === "pending" || c.status === "processing") q.items.push({ account, id: c.id });
  }
}

async function drain() {
  await boot();
  if (q.running) return;
  q.running = true;
  try {
    while (q.items.length) {
      const { account, id } = q.items.shift()!;
      const c = await findCase(account, id);
      if (!c || (c.status !== "pending" && c.status !== "processing")) continue;
      const attempts = (c.attempts ?? 0) + 1;
      if (attempts > 2) {
        await saveCase(account, { ...c, status: "review", attempts, checks: { ...c.checks, pipeline: { ok: false, detail: "後台驗證多次中斷，已轉人工複核" } } });
        continue;
      }
      await saveCase(account, { ...c, status: "processing", attempts });
      let out: KycCase;
      try {
        out = await runPipeline(c, account);
      } catch (e) {
        out = { ...c, status: "review", checks: { ...c.checks, pipeline: { ok: false, detail: `後台驗證發生錯誤，已轉人工複核：${(e as Error).message.slice(0, 200)}` } }, processedAt: Date.now() };
      }
      await saveCase(account, out);
      if (out.status === "approved") await finalize(account, out.id).catch((e) => console.error("KYC finalize failed", e));
    }
  } finally {
    q.running = false;
  }
}

/**
 * 核准後的鏈上動作（自動通過與人工核准共用）：
 * - onboard：寫入 L2（v1＋v2），記錄統一編號 HMAC；平台備援金鑰的授權在使用者查詢結果時產生
 * - recover：確認與開戶時是同一人後，以平台備援金鑰發起 initiateRecovery
 */
export async function finalize(account: string, id: string, reviewer?: string) {
  const c = await findCase(account, id);
  if (!c || c.status !== "approved" || c.result?.txHash || c.result?.recoveryTx) return;
  const a = getAddress(account) as Address;
  try {
    if (c.purpose === "onboard") {
      const r = await attestIdentity(a, { level: 2, claimsRoot: claimsRootOf(c), expiry: Math.floor(Date.now() / 1000) + 365 * 86400, jurisdiction: c.fields?.nationality ?? "TW" });
      await saveCase(account, { ...c, result: { txHash: r.v2Tx ?? r.v1Tx } }, (rec) => {
        rec.level = 2;
        if (c.fields?.idNumberHash) rec.idHash = c.fields.idNumberHash;
      });
      return;
    }
    // recover
    const s = await read();
    const rec = s.kyc[keyOf(s, account)!];
    const onboard = rec.cases?.find((x) => x.purpose === "onboard" && x.status === "approved");
    if (!onboard) throw new Error("找不到開戶時的實名紀錄");
    if (!reviewer) {
      const same = await sameSubject(account, onboard, c);
      if (!same.ok) {
        await saveCase(account, { ...c, status: "review", decidedBy: undefined, checks: { ...c.checks, sameSubject: same } });
        return;
      }
      c.checks.sameSubject = same;
    } else {
      c.checks.sameSubject = { ok: true, detail: `人工複核確認為同一人（${reviewer}）` };
    }
    if (!c.recovery) throw new Error("案件沒有新裝置金鑰");
    const callData = execCall(
      DEPLOYMENT.recovery,
      encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "initiateRecovery", args: [c.recovery.qx as Hex, c.recovery.qy as Hex, c.recovery.rpIdHash as Hex, false] }),
    );
    const { userOp, userOpHash } = await prepareUserOp({ sender: a, validator: DEPLOYMENT.recovery, callData });
    userOp.signature = await guardianSigner(a).signMessage({ message: { raw: userOpHash } });
    const res = await sendUserOp(userOp);
    if (!res.success) throw new Error(`恢復請求執行失敗：${res.reason ?? "未知原因"}`);
    const p = await publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [a] });
    await saveCase(account, { ...c, result: { recoveryTx: res.txHash, readyAt: Number(p[2]) } });
  } catch (e) {
    await saveCase(account, { ...c, result: { error: (e as Error).message.slice(0, 300) } });
    throw e;
  }
}

/** 給使用者看的案件狀態（不含分數與欄位） */
export function publicView(c: KycCase) {
  const reasons = Object.values(c.checks).filter((x) => !x.ok).map((x) => x.detail);
  return {
    caseId: c.id,
    status: c.status,
    purpose: c.purpose,
    createdAt: c.createdAt,
    reasons: c.status === "rejected" ? reasons.slice(0, 3) : [],
    result: c.result ?? null,
    /** 使用者送出的內容（證件以 /api/kyc/file 取得，只能看自己的；臉部影片不提供給使用者端） */
    submitted: { actions: c.actions.map((x) => x.action) },
    processedAt: c.processedAt ?? null,
    reviewedAt: c.review?.at ?? null,
  };
}
