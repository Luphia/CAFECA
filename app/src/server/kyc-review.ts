import "server-only";
import { createHash, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { writeAudit } from "./audit";
import { env } from "./env";
import { HttpError } from "./session";

/**
 * KYC 人工複核後台的身分：以 KYC_REVIEW_TOKEN 登入，並填寫複核人姓名（寫入每一筆決策與稽核紀錄）。
 * 正式版應改為公司 SSO＋雙人覆核。
 */
const COOKIE = "cafeca_kyc_review";
const key = () => new TextEncoder().encode(env.sessionSecret() + ":kyc-review");

export async function reviewerLogin(token: string, name: string) {
  const expected = env.kycReviewToken();
  if (!expected) throw new HttpError(503, "尚未設定 KYC_REVIEW_TOKEN，人工複核後台停用");
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, "密碼錯誤");
  const who = name.trim().slice(0, 40);
  if (!who) throw new HttpError(400, "請填寫複核人姓名");
  const jwt = await new SignJWT({ who }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(key());
  (await cookies()).set(COOKIE, jwt, { httpOnly: true, sameSite: "strict", path: "/", maxAge: 8 * 3600 });
  await audit({ who, action: "login" });
  return who;
}

export async function requireReviewer(): Promise<string> {
  const t = (await cookies()).get(COOKIE)?.value;
  if (!t || !env.kycReviewToken()) throw new HttpError(401, "請先登入複核後台");
  try {
    const { payload } = await jwtVerify(t, key());
    return String(payload.who);
  } catch {
    throw new HttpError(401, "請先登入複核後台");
  }
}

/** 稽核紀錄：寫入 hash-chained 的 data/audit/audit.jsonl（見 server/audit.ts） */
export async function audit(e: Record<string, unknown>) {
  const { who, action, ...rest } = e as { who?: string; action?: string };
  await writeAudit({ who: String(who ?? "system"), action: String(action ?? "unknown"), ...rest });
}
