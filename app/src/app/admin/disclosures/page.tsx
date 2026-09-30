"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Badge, Button, Notice, Panel, Spinner, cx, errMsg, inputCls, short } from "@/components/ui";

type D = {
  id: string;
  rp: string;
  rpName?: string;
  account: string;
  handle?: string | null;
  fields: string[];
  legalBasis: { type: string; ref: string; text: string };
  caseRef?: string;
  reason: string;
  relationship: { type: string; detail: string };
  noticeDeferredUntil?: number;
  status: "consent" | "review" | "approved1" | "released" | "rejected";
  consent?: { status: string; at?: number; expiresAt?: number };
  approvals: { who: string; at: number; fields: string[]; note?: string }[];
  rejection?: { by: string; at: number; reason: string };
  release?: { at: number; by: string; expiresAt: number; fetched: number[] };
  dueAt?: number;
  respondBy?: number;
  overdue?: boolean;
  createdAt: number;
};

const LABEL: Record<string, string> = {
  legal_name: "證件姓名",
  birthday: "出生日期",
  sex: "性別",
  doc_type: "證件類型",
  nationality: "國籍",
  issue_date: "發證日期",
  kyc_history: "實名驗證歷程",
  doc_images: "證件影像（浮水印版）",
  entity: "法人資料",
};
const BASIS: Record<string, string> = { court: "法院", prosecutor: "檢察機關", police: "司法警察", aml: "洗錢防制", consent: "當事人同意" };
const ST: Record<D["status"], { t: string; tone: "warn" | "ok" | "danger" | "neutral" }> = {
  consent: { t: "等待當事人同意", tone: "neutral" },
  review: { t: "待第一位核准", tone: "warn" },
  approved1: { t: "待第二位放行", tone: "warn" },
  released: { t: "已放行", tone: "ok" },
  rejected: { t: "已退件", tone: "danger" },
};

/** 資料調閱雙人覆核：第一位核准欄位，第二位（不同人）放行；每次檢視與決策都寫入稽核紀錄 */
export default function DisclosureReviewPage() {
  const [data, setData] = useState<{ reviewer: string; disclosures: D[] } | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [status, setStatus] = useState("open");
  const [detail, setDetail] = useState<{ disclosure: D; preview: Record<string, unknown> } | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminCall<{ reviewer: string; disclosures: D[] }>(`/api/admin/disclosures?status=${status}`));
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

  if (needLogin) return <AdminLogin title="資料調閱覆核" onDone={load} />;

  const open = async (id: string) => {
    setErr(null);
    try {
      const r = await adminCall<{ disclosure: D; preview: Record<string, unknown> }>(`/api/admin/disclosures?id=${id}`);
      setDetail(r);
      setFields(r.disclosure.approvals[0]?.fields ?? r.disclosure.fields);
      setNote("");
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const act = async (action: "approve" | "reject") => {
    if (!detail) return;
    setBusy(action);
    setErr(null);
    try {
      await adminCall("/api/admin/disclosures", { id: detail.disclosure.id, action, fields, note, reason: note });
      await open(detail.disclosure.id);
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const d = detail?.disclosure;
  const first = d?.approvals[0];
  const selfFirst = !!first && first.who === data?.reviewer;
  const allowed = d ? (d.status === "approved1" ? first!.fields : d.fields) : [];
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">資料調閱覆核</h1>
        <div className="flex items-center gap-2 text-sm">
          {data && <span className="whitespace-nowrap text-ink-3">複核人：{data.reviewer}</span>}
          <select className={cx(inputCls, "h-9 w-auto")} value={status} onChange={(e) => { setDetail(null); setStatus(e.target.value); }}>
            <option value="open">進行中</option>
            <option value="released">已放行</option>
            <option value="rejected">已退件</option>
            <option value="all">全部</option>
          </select>
          <Button size="sm" variant="secondary" onClick={load}>重新整理</Button>
        </div>
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Panel>
          {!data ? (
            <Spinner className="text-brand" />
          ) : data.disclosures.length === 0 ? (
            <p className="text-sm text-ink-3">沒有申請</p>
          ) : (
            <ul className="divide-y divide-line" data-testid="disclosure-review-list">
              {data.disclosures.map((x) => (
                <li key={x.id}>
                  <button className={cx("w-full py-2.5 text-left", d?.id === x.id && "text-brand")} onClick={() => open(x.id)} data-testid={`dr-case-${x.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm">{x.rpName}</span>
                      <Badge tone={ST[x.status].tone}>{ST[x.status].t}</Badge>
                    </div>
                    <div className="text-xs text-ink-3">{BASIS[x.legalBasis.type]} · {x.handle ? `@${x.handle}` : short(x.account, 6)} · {new Date(x.createdAt).toLocaleString("zh-TW")}</div>
                    {x.dueAt && ["review", "approved1"].includes(x.status) && (
                      <div className={cx("text-xs", x.overdue ? "text-danger" : "text-ink-2")} data-testid={`dr-due-${x.id}`}>
                        {x.overdue ? "已逾期：" : "回應期限："}{new Date(x.dueAt).toLocaleDateString("zh-TW")}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {!d ? (
          <Panel><p className="text-sm text-ink-3">選擇左側申請</p></Panel>
        ) : (
          <Panel title={`${d.id}`}>
            <div className="space-y-4 text-sm" data-testid="dr-detail">
              <table className="w-full text-left">
                <tbody className="[&_td]:py-1 [&_th]:w-32 [&_th]:py-1 [&_th]:align-top [&_th]:font-normal [&_th]:text-ink-3">
                  <tr><th>狀態</th><td><Badge tone={ST[d.status].tone}>{ST[d.status].t}</Badge></td></tr>
                  <tr><th>帳戶</th><td className="font-mono text-xs">{d.account}{detail.disclosure.handle ? ` (@${detail.disclosure.handle})` : ""}</td></tr>
                  <tr><th>法律依據</th><td>{BASIS[d.legalBasis.type]}{d.legalBasis.ref ? `（${d.legalBasis.ref}）` : ""}<div className="whitespace-pre-wrap text-ink-2">{d.legalBasis.text}</div></td></tr>
                  <tr><th>案號</th><td>{d.caseRef ?? "—"}</td></tr>
                  <tr><th>原因</th><td className="whitespace-pre-wrap">{d.reason}</td></tr>
                  <tr><th>客戶關係</th><td>{d.relationship.detail}</td></tr>
                  <tr><th>當事人同意</th><td>{d.consent ? `${d.consent.status}${d.consent.at ? ` · ${new Date(d.consent.at).toLocaleString("zh-TW")}` : ""}` : "不需要"}</td></tr>
                  <tr><th>回應期限</th><td>{d.dueAt ? `${new Date(d.dueAt).toLocaleString("zh-TW")}${d.respondBy ? "（文書所載）" : "（依政策）"}` : d.consent?.expiresAt ? `等待當事人同意，${new Date(d.consent.expiresAt).toLocaleString("zh-TW")} 前未回覆即失效` : "—"}</td></tr>
                  <tr><th>通知當事人</th><td>{d.noticeDeferredUntil ? `暫緩至 ${new Date(d.noticeDeferredUntil).toLocaleDateString("zh-TW")}` : "立即"}</td></tr>
                  {d.approvals.map((a, i) => (
                    <tr key={i}><th>{i === 0 ? "第一位核准" : "第二位放行"}</th><td>{a.who} · {new Date(a.at).toLocaleString("zh-TW")} · {a.fields.map((f) => LABEL[f]).join("、")}{a.note ? `（${a.note}）` : ""}</td></tr>
                  ))}
                  {d.release && <tr><th>下載</th><td>{d.release.fetched.length} 次 · {new Date(d.release.expiresAt).toLocaleString("zh-TW")} 前有效</td></tr>}
                  {d.rejection && <tr><th>退件</th><td>{d.rejection.by}：{d.rejection.reason}</td></tr>}
                </tbody>
              </table>
              <div>
                <div className="mb-1 text-xs text-ink-3">將提供的資料（依目前核准的欄位預覽；證件影像只列雜湊）</div>
                <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 text-xs" data-testid="dr-preview">{JSON.stringify(detail.preview, null, 2)}</pre>
              </div>
              {(d.status === "review" || d.status === "approved1") && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-3">
                    {allowed.map((f) => (
                      <label key={f} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={fields.includes(f)} onChange={(e) => setFields(e.target.checked ? [...fields, f] : fields.filter((x) => x !== f))} data-testid={`dr-field-${f}`} />
                        {LABEL[f]}
                      </label>
                    ))}
                  </div>
                  <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="備註（退件必填）" data-testid="dr-note" />
                  {selfFirst && d.status === "approved1" && <Notice tone="warn">你是第一位核准人，必須由另一位複核人員放行。</Notice>}
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" onClick={() => act("reject")} busy={busy === "reject"} testId="dr-reject">退件</Button>
                    <Button onClick={() => act("approve")} busy={busy === "approve"} disabled={selfFirst && d.status === "approved1"} testId="dr-approve">{d.status === "review" ? "核准勾選的欄位" : "放行"}</Button>
                  </div>
                  <p className="text-xs text-ink-3">核對法律依據文件真偽（必要時回電發文機關）、欄位是否為調查所必要。放行後依賴方 7 天內可下載以其公鑰加密的資料包。</p>
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
