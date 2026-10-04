import { acceptTerms, termsStatus } from "@/server/terms";
import { handle, HttpError, requireSession } from "@/server/session";

/** GET → 目前條款版本與我是否已同意；POST { version, signature } → 以 Passkey 同意（ERC-1271） */
export const GET = handle(async () => Response.json(await termsStatus(await requireSession())));

export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const b = (await req.json().catch(() => ({}))) as { version?: string; signature?: string };
  if (!b.version || !b.signature || !/^0x[0-9a-fA-F]+$/.test(b.signature)) throw new HttpError(400, "參數錯誤");
  await acceptTerms(me, b.version, b.signature as `0x${string}`);
  return Response.json({ ok: true });
});
