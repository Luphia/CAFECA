/**
 * 正式模式（CAFECA_MODE=production）：上線閘門（規格 §16.6 P3-A4）。
 * 正式模式下，以下設定一律拒絕啟動；開發與測試網維持原本行為。
 */
export const productionMode = () => process.env.CAFECA_MODE === "production";

/** 正式模式不允許的設定：[環境變數, 說明] */
const FORBIDDEN: [string, (v: string) => boolean, string][] = [
  ["KYC_PROTOTYPE_AUTO_APPROVE", (v) => v === "1" || v === "true", "原型模式會略過 OCR、活體與人臉比對，全部放行"],
  ["NEXT_PUBLIC_KYC_SIMULATE", (v) => v === "1" || v === "true", "前端活體步驟改為按鈕模擬"],
  ["MOEACA_TEST_ANCHORS", (v) => !!v, "會信任測試 PKI 簽發的工商憑證"],
  ["GCIS_COMPANY_URL", (v) => !!v, "商工登記查詢指向非官方服務"],
  ["KYC_AUTO_APPROVE", (v) => (v === "1" || v === "true") && process.env.KYC_AUTO_CALIBRATED !== "1", "自動核准門檻尚未以真實樣本校準（校準完成後設定 KYC_AUTO_CALIBRATED=1）"],
];

export function launchGateProblems(e: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, bad, why] of FORBIDDEN) if (e[k] !== undefined && bad(e[k]!)) out.push(`${k}：${why}`);
  const origin = e.PUBLIC_ORIGIN ?? "";
  if (!origin.startsWith("https://")) out.push("PUBLIC_ORIGIN 必須是 https 網址（管理後台 Passkey 登入只接受這個來源）");
  if (!e.KYC_REVIEW_TOKEN && !e.CAFECA_ALLOW_NO_BOOTSTRAP) out.push("KYC_REVIEW_TOKEN 未設定（建立第一位管理者需要）；已建立管理者後可設 CAFECA_ALLOW_NO_BOOTSTRAP=1");
  return out;
}
