import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { getAddress, type Address } from "viem";
import { env } from "./env";

const COOKIE = "cafeca_session";

function key() {
  return new TextEncoder().encode(env.sessionSecret());
}

export async function createSession(address: Address) {
  const token = await new SignJWT({ addr: getAddress(address) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key());
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 7 * 24 * 3600 });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Address | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return getAddress(payload.addr as string);
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<Address> {
  const a = await getSession();
  if (!a) throw new HttpError(401, "請先登入");
  return a;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Route Handler 的共用錯誤處理 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) console.error("[api]", e);
      return Response.json({ error: message }, { status });
    }
  };
}
