"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Badge, Button, Notice, Panel, Spinner, cx, errMsg, inputCls, short } from "@/components/ui";

type Rec = {
  entity: string;
  displayName?: string;
  applicantHandle: string | null;
  application: {
    id: string;
    ubn: string;
    applicant: string;
    applicantName: string | null;
    at: number;
    path: string;
    status: string;
    gcis: { name: string; status: string; responsible: string; changeDate: string; setupDate: string; location: string; capital: number } | null;
    checks: Record<string, { ok: boolean; detail: string }>;
    letter?: string;
    review?: { by: string; at: number; decision: string; note?: string };
    result?: { txHash?: string; error?: string };
  };
  verified?: { ubn: string; name: string };
  monitor?: { status: string; detail?: string };
};

const TONE: Record<string, "warn" | "ok" | "danger" | "neutral"> = { review: "warn", approved: "ok", rejected: "danger", pending: "neutral" };

/** 法人驗證人工複核：代理人申請（申請人不是登記代表人）需核對授權書 */
export default function EntityReviewPage() {
  const [data, setData] = useState<{ reviewer: string; entities: Rec[] } | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [status, setStatus] = useState("review");
  const [sel, setSel] = useState<Rec | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminCall<{ reviewer: string; entities: Rec[] }>(`/api/admin/entity?status=${status}`));
      setNeedLogin(false);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setNeedLogin(true);
      else setErr(errMsg(e));
    }
  }, [status]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (needLogin) return <AdminLogin title="法人驗證複核" onDone={load} />;

  const decide = async (decision: "approved" | "rejected") => {
    if (!sel) return;
    setBusy(decision);
    setErr(null);
    try {
      await adminCall("/api/admin/entity", { entity: sel.entity, id: sel.application.id, decision, note });
      setSel(null);
      setNote("");
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const a = sel?.application;
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">法人驗證複核</h1>
        <div className="flex items-center gap-2 text-sm">
          {data && <span className="text-ink-3">複核人：{data.reviewer}</span>}
          <select className={cx(inputCls, "h-9 w-auto")} value={status} onChange={(e) => { setSel(null); setStatus(e.target.value); }}>
            <option value="review">待複核</option>
            <option value="approved">已核准</option>
            <option value="rejected">已退件</option>
            <option value="all">全部</option>
          </select>
          <Button size="sm" variant="secondary" onClick={load}>重新整理</Button>
        </div>
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Panel>
          {!data ? (
            <Spinner className="text-brand" />
          ) : data.entities.length === 0 ? (
            <p className="text-sm text-ink-3">沒有申請</p>
          ) : (
            <ul className="divide-y divide-line" data-testid="entity-review-list">
              {data.entities.map((r) => (
                <li key={r.entity}>
                  <button className={cx("w-full py-2.5 text-left", sel?.entity === r.entity && "text-brand")} onClick={() => setSel(r)} data-testid={`entity-case-${r.application.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm">{r.application.gcis?.name ?? r.displayName ?? short(r.entity, 6)}</span>
                      <Badge tone={TONE[r.application.status] ?? "neutral"}>{r.application.status}</Badge>
                    </div>
                    <div className="text-xs text-ink-3">統編 {r.application.ubn} · {r.application.path === "agent" ? "代理人" : "代表人"} · {new Date(r.application.at).toLocaleString("zh-TW")}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {!sel || !a ? (
          <Panel><p className="text-sm text-ink-3">選擇左側申請</p></Panel>
        ) : (
          <Panel title={a.gcis?.name ?? "查無登記"}>
            <div className="space-y-4 text-sm" data-testid="entity-review-detail">
              <div className="font-mono text-xs text-ink-3">法人帳戶 {sel.entity}</div>
              <table className="w-full text-left text-sm">
                <tbody className="[&_td]:py-1 [&_th]:w-32 [&_th]:py-1 [&_th]:font-normal [&_th]:text-ink-3">
                  <tr><th>統一編號</th><td className="font-mono">{a.ubn}</td></tr>
                  <tr><th>公司狀況</th><td>{a.gcis?.status ?? "—"}</td></tr>
                  <tr><th>登記代表人</th><td>{a.gcis?.responsible ?? "—"}</td></tr>
                  <tr><th>申請人證件姓名</th><td>{a.applicantName ?? "—"}{sel.applicantHandle ? `（@${sel.applicantHandle}）` : ""} <span className="font-mono text-xs text-ink-3">{short(a.applicant, 6)}</span></td></tr>
                  <tr><th>所在地</th><td>{a.gcis?.location ?? "—"}</td></tr>
                  <tr><th>核准設立／變更</th><td>{a.gcis ? `${a.gcis.setupDate}／${a.gcis.changeDate}` : "—"}</td></tr>
                  <tr><th>資本額</th><td>{a.gcis ? a.gcis.capital.toLocaleString("zh-TW") : "—"}</td></tr>
                </tbody>
              </table>
              <ul className="space-y-1">
                {Object.entries(a.checks).map(([k, c]) => (
                  <li key={k} className={c.ok ? "text-ok" : "text-danger"}>{c.ok ? "✓" : "✕"} {c.detail}</li>
                ))}
              </ul>
              {a.letter && (
                <div>
                  <div className="mb-1 text-xs text-ink-3">代表人授權書（請核對代表人姓名、簽章或公司大小章、授權對象為申請人、日期）</div>
                  {a.letter.endsWith("pdf") ? (
                    <a className="text-brand underline" href={`/api/admin/entity/file?entity=${sel.entity}`} target="_blank" rel="noreferrer">開啟授權書（PDF）</a>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/admin/entity/file?entity=${sel.entity}`} alt="授權書" className="max-h-[480px] rounded-lg border border-line" data-testid="entity-letter-img" />
                  )}
                </div>
              )}
              {a.review && <Notice>已由 {a.review.by} {a.review.decision === "approved" ? "核准" : "退件"}{a.review.note ? `：${a.review.note}` : ""}</Notice>}
              {a.result?.error && <Notice tone="danger">鏈上簽發失敗：{a.result.error}</Notice>}
              {a.status === "review" && (
                <div className="space-y-2">
                  <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="備註（退件必填，會顯示給申請人）" data-testid="entity-review-note" />
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" onClick={() => decide("rejected")} busy={busy === "rejected"} testId="entity-review-reject">退件</Button>
                    <Button onClick={() => decide("approved")} busy={busy === "approved"} testId="entity-review-approve">核准並簽發法人證明</Button>
                  </div>
                  <p className="text-xs text-ink-3">核准前會再查詢一次商工登記。核准後以 IdentityRegistry v2 簽發 subjectType = 1 的 L2 證明，這個統編不能再綁定其他法人帳戶。</p>
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
