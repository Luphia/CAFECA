import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import type { Address, Hex } from "viem";
import { cafecaAccountAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { env } from "@/server/env";
import { createSession, handle, HttpError } from "@/server/session";
import { loginHash } from "@/server/login";

export const POST = handle(async (req: Request) => {
  const { signature } = (await req.json()) as { signature: Hex };
  const jar = await cookies();
  const token = jar.get("cafeca_login")?.value;
  if (!token) throw new HttpError(400, "登入挑戰已過期");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.sessionSecret()));
  const addr = payload.addr as Address;
  const hash = loginHash(addr, payload.nonce as Hex, payload.exp as number);
  const magic = await publicClient
    .readContract({ address: addr, abi: cafecaAccountAbi, functionName: "isValidSignature", args: [hash, signature] })
    .catch(() => "0x");
  if (magic !== "0x1626ba7e") throw new HttpError(401, "簽章驗證失敗");
  jar.delete("cafeca_login");
  await createSession(addr);
  return Response.json({ address: addr });
});
