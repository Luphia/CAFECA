import { createDisclosure, fetchPackage, requireRp, rpDisclosures } from "@/server/disclosure";
import { handle } from "@/server/session";

/**
 * 依賴方資料調閱 API（伺服器對伺服器，Authorization: Bearer cafeca_rp…）
 * POST { account, fields[], legalBasis{type, ref, text}, reason, caseRef?, deferNoticeUntil?, signIn? | pairwiseId? } → 建立申請
 * GET ?id= → 狀態；放行後附 package（JWE，7 天內可下載）
 * GET → 自己送出的申請列表
 */
export const POST = handle(async (req: Request) => {
  const rp = await requireRp(req);
  const b = await req.json().catch(() => ({}));
  return Response.json(await createDisclosure(rp, b), { status: 201 });
});

export const GET = handle(async (req: Request) => {
  const rp = await requireRp(req);
  const id = new URL(req.url).searchParams.get("id");
  if (id) return Response.json(await fetchPackage(rp, id), { headers: { "cache-control": "no-store" } });
  return Response.json({ disclosures: await rpDisclosures(rp) });
});
