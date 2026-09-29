import type { JWK } from "jose";
import { createRelyingParty, listRelyingParties, setRpActive } from "@/server/disclosure";
import { requireReviewer } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";

/**
 * 依賴方登記（資料調閱 API）
 * GET  → 依賴方列表
 * POST { name, ubn?, domains[], contact, encJwk } → 建立，回傳一次性顯示的 API 金鑰
 * POST { id, active } → 停用或恢復
 */
export const GET = handle(async () => {
  const who = await requireReviewer("admin");
  return Response.json({ reviewer: who, relyingParties: await listRelyingParties() });
});

export const POST = handle(async (req: Request) => {
  const who = await requireReviewer("admin");
  const b = (await req.json().catch(() => ({}))) as { id?: string; active?: boolean; name?: string; ubn?: string; domains?: string[]; contact?: string; encJwk?: JWK | string };
  if (b.id) {
    if (typeof b.active !== "boolean") throw new HttpError(400, "active 必須是 true 或 false");
    await setRpActive(who, b.id, b.active);
    return Response.json({ ok: true });
  }
  let jwk = b.encJwk;
  if (typeof jwk === "string") {
    try {
      jwk = JSON.parse(jwk) as JWK;
    } catch {
      throw new HttpError(400, "加密公鑰必須是 JSON 格式的 JWK");
    }
  }
  const r = await createRelyingParty(who, { name: b.name ?? "", ubn: b.ubn, domains: Array.isArray(b.domains) ? b.domains : [], contact: b.contact ?? "", encJwk: (jwk ?? {}) as JWK });
  return Response.json(r);
});
