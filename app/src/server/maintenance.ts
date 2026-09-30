import "server-only";
import { timingSafeEqual } from "crypto";
import { anchorAudit } from "./audit-anchor";
import { sweepDisclosures } from "./disclosure";
import { runRetention } from "./retention";
import { HttpError } from "./session";

/** 排程工作：同意請求逾期失效、保存期限清除、稽核紀錄上鏈。CRON_SECRET 設定後，排程呼叫須帶 x-cafeca-cron 標頭 */
export function requireCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const got = Buffer.from(req.headers.get("x-cafeca-cron") ?? "");
  const want = Buffer.from(secret);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "缺少或錯誤的排程密鑰");
}

export async function runMaintenance(who: string) {
  const d = await sweepDisclosures();
  const r = await runRetention(who);
  // 最後才上鏈，當天的清除紀錄也包含在錨點內
  const a = await anchorAudit(who).catch((e: Error) => ({ error: e.message }));
  return { consentExpired: d.expired, casesPurged: r.purged, anchor: a };
}
