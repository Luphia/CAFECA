import { inviteInfo, joinStaff, type PasskeyReg } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";

/** 受邀人員加入：GET ?code= 查看邀請；POST { code, passkey } 登記 Passkey 並登入 */
export const GET = handle(async (req: Request) => {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) throw new HttpError(400, "缺少邀請碼");
  return Response.json(await inviteInfo(code));
});

export const POST = handle(async (req: Request) => {
  const b = (await req.json().catch(() => ({}))) as { code?: string; passkey?: PasskeyReg };
  if (!b.code) throw new HttpError(400, "缺少邀請碼");
  return Response.json({ staff: await joinStaff(b.code, b.passkey as PasskeyReg) });
});
