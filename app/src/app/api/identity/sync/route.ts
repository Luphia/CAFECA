import { syncRecoveries } from "@/server/identity-sync";
import { handle } from "@/server/session";

/**
 * POST /api/identity/sync：處理尚未處理的 RecoveryExecuted 事件（重新簽發或暫停 v2 證明）。
 * 只根據鏈上事件與後台 KYC 紀錄動作、可重複呼叫，因此不需要驗證呼叫者；建議排程每幾分鐘呼叫一次。
 */
export const POST = handle(async () => Response.json(await syncRecoveries()));
