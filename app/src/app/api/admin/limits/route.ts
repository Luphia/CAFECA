import { getAddress, isAddress, type Address } from "viem";
import { effectiveLevel } from "@/server/identity";
import { audit, requireReviewer } from "@/server/kyc-review";
import { LIMIT_REASONS, limitAdmin, limitHistory, limitsOf, setLimitsFor } from "@/server/limits";
import { handle, HttpError } from "@/server/session";
import { read } from "@/server/store";

/**
 * 交易額度管理後台（只給管理者）：查詢帳戶額度與調整紀錄、調升或調降額度。
 * 每次查詢與調整都寫入稽核紀錄；鏈上另有 LimitsSetByAdmin 事件。
 */

async function resolve(q: string): Promise<{ account: Address; handle: string | null }> {
  const s = await read();
  const v = q.trim();
  if (isAddress(v)) {
    const a = getAddress(v);
    return { account: a, handle: s.profiles[a]?.handle ?? null };
  }
  const a = s.handles[v.replace(/^@+/, "").toLowerCase()];
  if (!a) throw new HttpError(404, "找不到這個代稱或地址");
  return { account: getAddress(a), handle: s.profiles[a]?.handle ?? null };
}

export const GET = handle(async (req: Request) => {
  const who = await requireReviewer("limits");
  const q = new URL(req.url).searchParams.get("q");
  const admin = await limitAdmin();
  if (!q) return Response.json({ admin: who, limitAdmin: admin, supported: !!admin, reasons: LIMIT_REASONS });
  const { account, handle: h } = await resolve(q);
  const [limits, level, history] = await Promise.all([limitsOf(account), effectiveLevel(account).catch(() => 0), admin ? limitHistory(account) : []]);
  if (!limits.initialized) throw new HttpError(404, "這個地址不是已開戶的 CAFECA 身分");
  await audit({ who, action: "limits.view", account });
  return Response.json({ admin: who, limitAdmin: admin, supported: !!admin, reasons: LIMIT_REASONS, account, handle: h, level, limits, history });
});

export const POST = handle(async (req: Request) => {
  const who = await requireReviewer("limits");
  const b = (await req.json().catch(() => ({}))) as { account?: string; perTx?: string; daily?: string; reason?: number; note?: string };
  if (!b.account || !isAddress(b.account)) throw new HttpError(400, "帳戶地址錯誤");
  const num = (v: unknown) => typeof v === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(v);
  if (!num(b.perTx) || !num(b.daily)) throw new HttpError(400, "額度格式錯誤");
  if (Number(b.perTx) > Number(b.daily)) throw new HttpError(400, "單筆上限不能高於每日上限");
  const reason = Number(b.reason);
  if (!LIMIT_REASONS[reason]) throw new HttpError(400, "請選擇調整原因");
  const note = (b.note ?? "").trim().slice(0, 200);
  if (!note) throw new HttpError(400, "請填寫備註（例如申請單號）");
  if (!(await limitAdmin())) throw new HttpError(409, "目前部署的 KeyringValidator 是 v1，不支援管理者調整額度；需部署 v2");
  const account = getAddress(b.account);
  const before = await limitsOf(account);
  if (!before.initialized) throw new HttpError(404, "這個地址不是已開戶的 CAFECA 身分");
  const tx = await setLimitsFor(account, b.perTx!, b.daily!, reason);
  await audit({ who, action: "limits.set", account, before: { perTx: before.perTx, daily: before.daily }, after: { perTx: b.perTx, daily: b.daily }, reason, note, tx });
  return Response.json({ tx, limits: await limitsOf(account) });
});
