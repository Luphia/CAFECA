import { adminDisclosureDetail, adminDisclosures, approveDisclosure, rejectDisclosure } from "@/server/disclosure";
import { requireReviewer } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";

/**
 * 資料調閱覆核（雙人）
 * GET ?status=open|consent|review|approved1|released|rejected|all → 列表
 * GET ?id= → 申請內容與將提供的資料預覽（寫入稽核紀錄）
 * POST { id, action: "approve", fields[], note? } → 第一位核准；第二位（不同人）再按一次即放行
 * POST { id, action: "reject", reason } → 退件
 */
export const GET = handle(async (req: Request) => {
  const who = await requireReviewer("disclosure");
  const q = new URL(req.url).searchParams;
  const id = q.get("id");
  if (id) return Response.json({ reviewer: who, ...(await adminDisclosureDetail(who, id)) });
  return Response.json({ reviewer: who, disclosures: await adminDisclosures(q.get("status") ?? "open") });
});

export const POST = handle(async (req: Request) => {
  const who = await requireReviewer("disclosure");
  const b = (await req.json().catch(() => ({}))) as { id?: string; action?: string; fields?: string[]; note?: string; reason?: string };
  if (!b.id) throw new HttpError(400, "缺少 id");
  if (b.action === "approve") return Response.json(await approveDisclosure(who, b.id, Array.isArray(b.fields) ? b.fields : [], b.note?.trim().slice(0, 300) || undefined));
  if (b.action === "reject") {
    await rejectDisclosure(who, b.id, b.reason ?? "");
    return Response.json({ status: "rejected" });
  }
  throw new HttpError(400, "action 必須是 approve 或 reject");
});
