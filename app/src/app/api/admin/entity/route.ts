import { getAddress, isAddress } from "viem";
import { finalizeEntity, gcisLookup } from "@/server/entity";
import { audit, requireReviewer } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";
import { read, update } from "@/server/store";

/** 法人驗證人工複核（代理人申請）：列表、核准、退件 */
export const GET = handle(async (req: Request) => {
  const who = await requireReviewer("kyc");
  const status = new URL(req.url).searchParams.get("status") ?? "review";
  const s = await read();
  const list = Object.values(s.entities ?? {})
    .filter((r) => r.application && (status === "all" || r.application.status === status))
    .sort((a, b) => (b.application?.at ?? 0) - (a.application?.at ?? 0))
    .map((r) => ({ ...r, applicantHandle: r.application ? (s.profiles[r.application.applicant]?.handle ?? null) : null }));
  return Response.json({ reviewer: who, entities: list });
});

export const POST = handle(async (req: Request) => {
  const who = await requireReviewer("kyc");
  const b = (await req.json().catch(() => ({}))) as { entity?: string; id?: string; decision?: string; note?: string };
  if (!b.entity || !isAddress(b.entity)) throw new HttpError(400, "法人帳戶地址錯誤");
  if (b.decision !== "approved" && b.decision !== "rejected") throw new HttpError(400, "決定錯誤");
  const note = (b.note ?? "").trim().slice(0, 300);
  if (b.decision === "rejected" && !note) throw new HttpError(400, "退件請填寫原因");
  const entity = getAddress(b.entity);
  // 核准前重新查一次商工登記
  const cur = (await read()).entities?.[entity.toLowerCase()];
  if (!cur?.application || cur.application.id !== b.id || cur.application.status !== "review") throw new HttpError(409, "案件狀態已改變，請重新整理");
  const fresh = b.decision === "approved" ? await gcisLookup(cur.application.ubn) : cur.application.gcis;
  if (b.decision === "approved" && (!fresh || fresh.status !== "核准設立")) throw new HttpError(409, `商工登記狀況已改變：${fresh?.status ?? "查無資料"}`);
  await update((s) => {
    const a = s.entities![entity.toLowerCase()].application!;
    a.status = b.decision as "approved" | "rejected";
    a.gcis = fresh;
    a.review = { by: who, at: Date.now(), decision: b.decision as "approved" | "rejected", note: note || undefined };
  });
  await audit({ who, action: "entity.decide", entity, application: b.id, decision: b.decision, note });
  if (b.decision === "approved") await finalizeEntity(entity, who);
  return Response.json({ ok: true, result: (await read()).entities![entity.toLowerCase()].application?.result ?? null });
});
