import { availableClaims, issueCredential } from "@/server/kyc-credential";
import { handle, HttpError, requireSession } from "@/server/session";

/**
 * KYC Credential（規格 §16.3）— 只給錢包自己的頁面（登入同意畫面）呼叫。
 *
 * GET  → 使用者自己可提供的 claims 預覽（姓名、證件類型、國籍），讓同意畫面顯示「實際會給出去的內容」
 * POST { audience, nonce, claims } → 由 KYC 簽章者簽署、綁定 audience 與 SignIn nonce 的 credential
 *
 * 需要錢包的登入 session（SameSite=Lax cookie），並拒絕跨站請求：
 * 第三方網站無法直接向這裡索取 credential，只能透過使用者在同意畫面上逐項同意。
 */

function sameOrigin(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") throw new HttpError(403, "只接受錢包頁面的請求");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && (!host || new URL(origin).host !== host)) throw new HttpError(403, "只接受錢包頁面的請求");
}

function originOf(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin === u ? u : null;
  } catch {
    return null;
  }
}

export const GET = handle(async (req: Request) => {
  sameOrigin(req);
  const me = await requireSession();
  return Response.json(await availableClaims(me), { headers: { "cache-control": "no-store" } });
});

export const POST = handle(async (req: Request) => {
  sameOrigin(req);
  const me = await requireSession();
  const body = (await req.json().catch(() => null)) as { audience?: unknown; nonce?: unknown; claims?: unknown } | null;
  const audience = originOf(body?.audience);
  if (!audience) throw new HttpError(400, "audience 必須是網站的 origin");
  if (typeof body?.nonce !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.nonce)) throw new HttpError(400, "nonce 格式錯誤");
  if (!Array.isArray(body.claims) || body.claims.some((c) => typeof c !== "string")) throw new HttpError(400, "claims 格式錯誤");
  const credential = await issueCredential(me, { audience, nonce: body.nonce, claims: body.claims as string[] }).catch((e: Error) => {
    throw new HttpError(409, e.message);
  });
  return Response.json({ credential }, { headers: { "cache-control": "no-store" } });
});
