import "server-only";
import { timingSafeEqual } from "crypto";
import { sweepDisclosures } from "./disclosure";
import { runRetention } from "./retention";
import { HttpError } from "./session";

/** 排程工作：同意請求逾期失效、保存期限清除。CRON_SECRET 設定後，排程呼叫須帶 x-cafeca-cron 標頭 */
export function requireCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const got = Buffer.from(req.headers.get("x-cafeca-cron") ?? "");
  const want = Buffer.from(secret);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "缺少或錯誤的排程密鑰");
}

export async function runMaintenance(who: string) {
  const [d, r] = [await sweepDisclosures(), await runRetention(who)];
  return { consentExpired: d.expired, casesPurged: r.purged };
}
