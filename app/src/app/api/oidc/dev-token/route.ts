import { env } from "@/server/env";
import { issueDevToken } from "@/server/oidc";
import { handle, HttpError } from "@/server/session";

/** 測試網開發者登入：模擬 Google 簽發 id_token（NEXT_PUBLIC_DEV_LOGIN=1 才啟用） */
export const POST = handle(async (req: Request) => {
  if (!env.devLogin) throw new HttpError(404, "未啟用");
  const { email, nonce } = (await req.json()) as { email: string; nonce: string };
  if (!email?.includes("@")) throw new HttpError(400, "請輸入 email");
  return Response.json({ idToken: await issueDevToken(email, nonce ?? "") });
});
