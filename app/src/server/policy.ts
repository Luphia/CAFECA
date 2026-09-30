import "server-only";

/**
 * 調閱時限與保存期限（規格 §16.6 P3-B4／B5）。
 * 目前的數值是給法律顧問審閱的草案預設值；法遵定案後以環境變數設定，並設 POLICY_APPROVED=1、POLICY_VERSION=<定案版本>。
 */
const n = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export function policy() {
  return {
    version: process.env.POLICY_VERSION ?? "draft-2026-09",
    approved: process.env.POLICY_APPROVED === "1",
    disclosure: {
      /** 洗錢防制與當事人同意（同意後）：幾個工作天內回應 */
      amlBusinessDays: n("DISCLOSURE_SLA_AML_DAYS", 5),
      /** 司法機關：文書未載期限時，幾個工作天內回應 */
      authorityBusinessDays: n("DISCLOSURE_SLA_AUTHORITY_DAYS", 5),
      /** 當事人同意請求：幾天未回覆即失效 */
      consentDays: n("DISCLOSURE_CONSENT_DAYS", 7),
      /** 放行後資料包可下載的天數 */
      packageDays: n("DISCLOSURE_PACKAGE_DAYS", 7),
    },
    retention: {
      /** 已被較新核准案件取代的舊案件：證件影像、臉部影片與人臉特徵保存天數 */
      supersededCaseDays: n("RETENTION_SUPERSEDED_CASE_DAYS", 180),
      /** 未通過的案件：證件影像、臉部影片與人臉特徵保存天數 */
      rejectedCaseDays: n("RETENTION_REJECTED_CASE_DAYS", 180),
      /** 有效的實名證據、調閱紀錄、稽核紀錄：目前不自動刪除（待法遵訂定帳戶關閉後的保存年限） */
      activeEvidence: "不自動刪除",
    },
  };
}

/** 加上 N 個工作天（略過週六、週日；國定假日尚未計入） */
export function addBusinessDays(from: number, days: number): number {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = new Date(d.getTime() + 8 * 3600_000).getUTCDay(); // 台灣時間
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.getTime();
}
