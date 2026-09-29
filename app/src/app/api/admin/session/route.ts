import { bootstrapAdmin, currentStaff, loginChallenge, publicStaff, staffLogin, staffLogout, staffStatus, type PasskeyReg } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";

/**
 * 管理後台登入（Passkey）
 * GET → 目前登入的人員；尚無管理者時 bootstrap = true
 * POST { action: "challenge" } → 登入挑戰
 * POST { action: "login", credentialId, authenticatorData, clientDataJSON, signature } → 驗證並登入
 * POST { action: "bootstrap", token, name, passkey } → 建立第一位管理者（需要 KYC_REVIEW_TOKEN）
 * POST { action: "logout" }
 */
export const GET = handle(async () => {
  const st = await currentStaff();
  return Response.json({ staff: st ? publicStaff(st) : null, ...(await staffStatus()) });
});

export const POST = handle(async (req: Request) => {
  const b = (await req.json().catch(() => ({}))) as { action?: string; token?: string; name?: string; passkey?: PasskeyReg; credentialId?: string; authenticatorData?: string; clientDataJSON?: string; signature?: string };
  if (b.action === "challenge") return Response.json(await loginChallenge());
  if (b.action === "login") return Response.json({ staff: await staffLogin(req, b) });
  if (b.action === "bootstrap") return Response.json({ staff: await bootstrapAdmin(String(b.token ?? ""), String(b.name ?? ""), b.passkey as PasskeyReg) });
  if (b.action === "logout") {
    await staffLogout();
    return Response.json({ ok: true });
  }
  throw new HttpError(400, "action 錯誤");
});
