import { decideConsent, myDisclosures } from "@/server/disclosure";
import { handle, HttpError, requireSession } from "@/server/session";

/**
 * 我的資料被調閱的紀錄（司法機關要求暫緩通知的，到期後才會出現）
 * GET → 列表（待我同意的附上要以 Passkey 簽署的訊息）
 * POST { id, decision: "approve"|"deny", signature } → 回覆同意請求（ERC-1271 簽章）
 */
export const GET = handle(async () => {
  const me = await requireSession();
  return Response.json({ disclosures: await myDisclosures(me) });
});

export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const b = (await req.json().catch(() => ({}))) as { id?: string; decision?: string; signature?: string };
  if (!b.id || (b.decision !== "approve" && b.decision !== "deny")) throw new HttpError(400, "參數錯誤");
  if (!b.signature || !/^0x[0-9a-fA-F]+$/.test(b.signature)) throw new HttpError(400, "缺少簽章");
  await decideConsent(me, b.id, b.decision, b.signature as `0x${string}`);
  return Response.json({ ok: true });
});
