import { cookies } from "next/headers";
import { SignJWT } from "jose";
import { getAddress, isAddress, toHex } from "viem";
import { loginHash } from "@/server/login";
import { env } from "@/server/env";
import { handle, HttpError } from "@/server/session";

/** 登入挑戰：帳戶以 passkey 對雜湊做 ERC-1271 簽章 */
export const GET = handle(async (req: Request) => {
  const address = new URL(req.url).searchParams.get("address") ?? "";
  if (!isAddress(address)) throw new HttpError(400, "地址格式錯誤");
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = Math.floor(Date.now() / 1000) + 300;
  const token = await new SignJWT({ addr: getAddress(address), nonce, exp })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(env.sessionSecret()));
  (await cookies()).set("cafeca_login", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 300 });
  return Response.json({ hash: loginHash(getAddress(address), nonce, exp) });
});
