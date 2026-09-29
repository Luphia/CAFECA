import { getAddress, isAddress } from "viem";
import { applyEntityByCert, moeacaChallenge } from "@/server/entity";
import { handle, HttpError, requireSession } from "@/server/session";

/**
 * 工商憑證綁定（P1.5）
 * POST { entity }                         → { id, tbs, exp }：要以工商憑證簽署的內容
 * POST { id, signature, certb64? }        → 驗證 PKCS#7 簽章與憑證，通過即簽發法人證明
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const b = (await req.json().catch(() => ({}))) as { entity?: string; id?: string; signature?: string; certb64?: string };
  if (b.id) {
    if (typeof b.signature !== "string" || b.signature.length < 100 || b.signature.length > 200_000) throw new HttpError(400, "簽章格式錯誤");
    return Response.json(await applyEntityByCert(me, { id: b.id, signature: b.signature, certb64: typeof b.certb64 === "string" ? b.certb64 : undefined }));
  }
  if (!b.entity || !isAddress(b.entity)) throw new HttpError(400, "法人帳戶地址錯誤");
  return Response.json(await moeacaChallenge(me, getAddress(b.entity)));
});
