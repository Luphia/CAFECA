"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Button, Notice, Panel, Spinner, errMsg, short } from "@/components/ui";

type Res = {
  policy: {
    version: string;
    approved: boolean;
    disclosure: { amlBusinessDays: number; authorityBusinessDays: number; consentDays: number; packageDays: number };
    retention: { supersededCaseDays: number; rejectedCaseDays: number; activeEvidence: string };
  };
  pending: { account: string; caseId: string; why: string; days: number }[];
};

/** 調閱時限與保存期限：目前生效的數值（草案或法遵定案）、即將清除的案件 */
export default function PolicyPage() {
  const [data, setData] = useState<Res | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await adminCall<Res>("/api/admin/maintenance"));
      setNeedLogin(false);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setNeedLogin(true);
      else setErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  if (needLogin) return <AdminLogin title="時限與保存期限" onDone={load} />;
  const p = data?.policy;
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <h1 className="text-2xl font-bold">時限與保存期限</h1>
      {err && <Notice tone="danger">{err}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}
      {!p ? (
        <Spinner className="text-brand" />
      ) : (
        <>
          {p.approved ? (
            <Notice tone="ok">政策版本 {p.version}（法遵已定案）</Notice>
          ) : (
            <Notice tone="warn"><span data-testid="policy-draft">政策版本 {p.version} 是草案預設值，尚待法遵確認；定案後以環境變數設定並設 POLICY_APPROVED=1。</span></Notice>
          )}
          <Panel title="資料調閱時限">
            <table className="w-full text-left text-sm">
              <tbody className="[&_td]:py-1 [&_th]:w-72 [&_th]:py-1 [&_th]:font-normal [&_th]:text-ink-3">
                <tr><th>洗錢防制、當事人同意（同意後）</th><td>{p.disclosure.amlBusinessDays} 個工作天</td></tr>
                <tr><th>司法機關（文書未載期限時）</th><td>{p.disclosure.authorityBusinessDays} 個工作天</td></tr>
                <tr><th>當事人同意請求有效期</th><td>{p.disclosure.consentDays} 天，逾期視為不同意</td></tr>
                <tr><th>資料包可下載期間</th><td>放行後 {p.disclosure.packageDays} 天</td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-3">工作天略過週六、週日，國定假日尚未計入。</p>
          </Panel>
          <Panel title="保存期限">
            <table className="w-full text-left text-sm">
              <tbody className="[&_td]:py-1 [&_th]:w-72 [&_th]:py-1 [&_th]:font-normal [&_th]:text-ink-3">
                <tr><th>未通過的案件（影像、影片、人臉特徵）</th><td>{p.retention.rejectedCaseDays} 天後清除</td></tr>
                <tr><th>被新案件取代的舊案件</th><td>新案件核准 {p.retention.supersededCaseDays} 天後清除</td></tr>
                <tr><th>目前有效的實名證據、調閱與稽核紀錄</th><td>{p.retention.activeEvidence}</td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-3">清除只刪影像、影片與人臉特徵，保留案件紀錄與檔案雜湊；每次清除都寫入稽核紀錄。排程每天執行一次。</p>
          </Panel>
          <Panel title={`即將清除（${data!.pending.length}）`} action={<Button size="sm" variant="secondary" busy={busy} testId="policy-run" onClick={async () => { setBusy(true); setErr(null); try { const r = await adminCall<{ consentExpired: number; casesPurged: number }>("/api/admin/maintenance", {}); setMsg(`已執行：同意請求逾期 ${r.consentExpired} 件、清除案件 ${r.casesPurged} 件`); await load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>立即執行</Button>}>
            {data!.pending.length === 0 ? (
              <p className="text-sm text-ink-3">沒有到期的案件</p>
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid="policy-pending">
                {data!.pending.map((x) => (
                  <li key={x.caseId} className="py-1.5">{short(x.account, 6)} · 案件 {x.caseId} · {x.why === "rejected" ? "未通過" : "已被取代"} · {x.days} 天</li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
