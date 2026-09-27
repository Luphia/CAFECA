import "server-only";
import type { KycCase } from "./store";

/**
 * 後台 KYC 驗證流程（團隊自建，規格 §14.3、§14.6）
 *
 * 正式實作的每一步：
 *   extractFields   PaddleOCR＋國民身分證版面模板 → 姓名、出生年月日、統一編號（檢查碼）、發證日期／類別
 *   verifyDocument  翻拍／列印／合成偵測（裝置端特徵＋後台分類器）
 *   verifyLiveness  伺服器端重跑 MediaPipe：6 個動作依序出現、時間戳一致；Whisper 核對念出的數字
 *   matchFace       影片正臉與證件照比對
 *   decide          分數加權：高信心 approved、中信心 review（人工）、低信心 rejected
 *
 * 原型：尚未接上模型，只沿用收件時的結構檢查，並標示為「待後台驗證」後放行，讓錢包流程可以走完。
 * 上線前必須把 PROTOTYPE_AUTO_APPROVE 關掉，改由上述流程決定。
 */
export const PROTOTYPE_AUTO_APPROVE = process.env.KYC_PROTOTYPE_AUTO_APPROVE !== "0";

export async function runPipeline(c: KycCase): Promise<KycCase> {
  const checks = { ...c.checks };
  checks.ocr = { ok: false, detail: "待後台 OCR 擷取（尚未接上模型）" };
  checks.liveness = { ok: false, detail: "待後台重跑姿態估計與語音辨識" };
  checks.faceMatch = { ok: false, detail: "待後台人臉比對" };
  checks.recapture = { ok: false, detail: "待後台翻拍偵測" };
  const structural = c.checks.challengeOrder?.ok && c.checks.actionTiming?.ok;
  return {
    ...c,
    checks,
    fields: null,
    status: structural ? (PROTOTYPE_AUTO_APPROVE ? "approved" : "review") : "rejected",
  };
}

/** 恢復身分：新案件與開戶案件是否為同一人（正式版：人臉比對＋證件統一編號 HMAC 相同） */
export async function sameSubject(prev: KycCase, next: KycCase): Promise<{ ok: boolean; detail: string }> {
  void prev;
  void next;
  return PROTOTYPE_AUTO_APPROVE
    ? { ok: true, detail: "原型：待後台人臉比對，暫時放行" }
    : { ok: false, detail: "需人工複核" };
}
