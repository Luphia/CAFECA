import { isAddress } from "viem";
import { finalize, findCase, saveCase } from "@/server/kyc-queue";
import { audit, requireReviewer } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";
import { read } from "@/server/store";

/** GET：待複核（或指定狀態）的案件；POST：核准或退件 */
export const GET = handle(async (req: Request) => {
  const who = await requireReviewer();
  const status = new URL(req.url).searchParams.get("status") ?? "review";
  const s = await read();
  const list = Object.entries(s.kyc)
    .flatMap(([account, r]) => (r.cases ?? []).map((c) => ({ account, ...c })))
    .filter((c) => status === "all" || c.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
  return Response.json({ reviewer: who, cases: list });
});

export const POST = handle(async (req: Request) => {
  const who = await requireReviewer();
  const { account, caseId, decision, note } = (await req.json()) as { account: string; caseId: string; decision: "approved" | "rejected"; note?: string };
  if (!isAddress(account) || !["approved", "rejected"].includes(decision)) throw new HttpError(400, "參數錯誤");
  const c = await findCase(account, caseId);
  if (!c) throw new HttpError(404, "找不到案件");
  if (c.status !== "review") throw new HttpError(409, `案件狀態為 ${c.status}，只能處理待複核的案件`);
  const review = { by: who, at: Date.now(), decision, note: note?.slice(0, 500) };
  await saveCase(account, { ...c, status: decision, decidedBy: "reviewer", review });
  await audit({ who, action: "decide", account, caseId, decision, note: review.note });
  if (decision === "approved") await finalize(account, caseId, who);
  return Response.json({ ok: true, case: await findCase(account, caseId) });
});
