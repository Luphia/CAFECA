"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, Panel, Spinner, cx, errMsg, inputCls, short } from "@/components/ui";

type Check = { ok: boolean; detail: string };
type Case = {
  account: string;
  id: string;
  purpose: "onboard" | "recover";
  createdAt: number;
  status: string;
  checks: Record<string, Check>;
  scores?: Record<string, unknown>;
  fields?: Record<string, string | undefined> | null;
  review?: { by: string; at: number; decision: string; note?: string };
  result?: { txHash?: string; recoveryTx?: string; error?: string };
};

const CHECK_LABEL: Record<string, string> = {
  challengeOrder: "動作順序（裝置回報）",
  actionTiming: "動作時間（裝置回報）",
  ocr: "證件 OCR",
  fields: "欄位合理性",
  backSide: "證件反面",
  idFace: "證件人像",
  liveness: "活體動作（伺服器重算）",
  singleFace: "單一人臉",
  speech: "念數字（語音辨識）",
  faceMatch: "人臉比對",
  duplicate: "證號重複",
  sameSubject: "與開戶時同一人",
  models: "模型",
  pipeline: "後台錯誤",
  decision: "決策",
  prototype: "原型放行",
};
const FIELD_LABEL: Record<string, string> = { name: "姓名", birthday: "出生日期", sex: "性別", docType: "證件類型", issueDate: "發證日期", nationality: "國籍", idNumberHash: "統一編號 HMAC" };
const STATUS_TONE: Record<string, "warn" | "ok" | "danger" | "neutral"> = { review: "warn", approved: "ok", rejected: "danger", pending: "neutral", processing: "neutral" };

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error ?? `HTTP ${r.status}`), { status: r.status });
  return j as T;
}

/**
 * KYC 人工複核後台（規格 §14.3「中信心 → 人工複核」）。
 * 只看得到浮水印版證件與臉部影像；每次檢視與決策都寫入 data/kyc/review-log.jsonl。
 */
export default function KycReviewPage() {
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [status, setStatus] = useState("review");
  const [cases, setCases] = useState<Case[] | null>(null);
  const [sel, setSel] = useState<Case | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ reviewer: string; cases: Case[] }>(`/api/admin/kyc?status=${status}`);
      setReviewer(r.reviewer);
      setCases(r.cases);
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

  if (needLogin) return <Login onDone={load} />;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">KYC 人工複核</h1>
        <div className="flex items-center gap-2 text-sm">
          {reviewer && <span className="text-ink-3">複核人：{reviewer}</span>}
          <select className={cx(inputCls, "h-9 w-auto")} value={status} onChange={(e) => { setSel(null); setStatus(e.target.value); }} data-testid="review-filter">
            <option value="review">待複核</option>
            <option value="pending">排隊中</option>
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
          {!cases ? (
            <Spinner className="text-brand" />
          ) : cases.length === 0 ? (
            <p className="text-sm text-ink-3">沒有案件</p>
          ) : (
            <ul className="divide-y divide-line" data-testid="review-list">
              {cases.map((c) => (
                <li key={c.id}>
                  <button className={cx("w-full py-2.5 text-left", sel?.id === c.id && "text-brand")} onClick={() => setSel(c)} data-testid={`case-${c.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm">{short(c.account, 6)}</span>
                      <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Badge>
                    </div>
                    <div className="text-xs text-ink-3">
                      {c.purpose === "recover" ? "恢復" : "開戶"} · {new Date(c.createdAt).toLocaleString("zh-TW")} · 未通過 {Object.values(c.checks).filter((x) => !x.ok).length} 項
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {sel ? <Detail c={sel} onDone={() => { setSel(null); load(); }} /> : <Panel><p className="text-sm text-ink-3">選擇左側案件</p></Panel>}
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-sm space-y-4 px-5 py-16">
      <h1 className="text-2xl font-bold">KYC 人工複核</h1>
      <Panel>
        <div className="space-y-3">
          <input className={inputCls} placeholder="複核人姓名" value={name} onChange={(e) => setName(e.target.value)} data-testid="reviewer-name" />
          <input className={inputCls} placeholder="KYC_REVIEW_TOKEN" type="password" value={token} onChange={(e) => setToken(e.target.value)} data-testid="reviewer-token" />
          {err && <Notice tone="danger">{err}</Notice>}
          <Button
            className="w-full"
            busy={busy}
            testId="reviewer-login"
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await call("/api/admin/kyc/login", { token, name });
                onDone();
              } catch (e) {
                setErr(errMsg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            登入
          </Button>
          <p className="text-xs text-ink-3">所有檢視與決策都會記錄複核人姓名。</p>
        </div>
      </Panel>
    </div>
  );
}

function Detail({ c, onDone }: { c: Case; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const f = (kind: string) => `/api/admin/kyc/file?account=${c.account}&case=${c.id}&kind=${kind}`;
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(decision);
    setErr(null);
    try {
      await call("/api/admin/kyc", { account: c.account, caseId: c.id, decision, note });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4" data-testid="review-detail">
      <Panel title={`${c.purpose === "recover" ? "恢復" : "開戶"}案件 ${c.id}`} action={<Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Badge>}>
        <div className="mb-3 font-mono text-xs text-ink-3">{c.account}</div>
        <div className="grid gap-3 md:grid-cols-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={f("front")} alt="證件正面（浮水印版）" className="w-full rounded-xl border border-line" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={f("back")} alt="證件反面（浮水印版）" className="w-full rounded-xl border border-line" />
          <video src={f("face")} controls className="w-full rounded-xl border border-line bg-black" />
        </div>
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="自動檢查">
          <ul className="space-y-1.5 text-sm">
            {Object.entries(c.checks).map(([k, v]) => (
              <li key={k} className="flex gap-2">
                <span className={v.ok ? "text-ok" : "text-danger"}>{v.ok ? "✓" : "✕"}</span>
                <span>
                  <span className="font-medium">{CHECK_LABEL[k] ?? k}</span>
                  <span className="block text-xs text-ink-3">{v.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <div className="space-y-4">
          <Panel title="擷取欄位">
            {c.fields ? (
              <dl className="space-y-1 text-sm">
                {Object.entries(c.fields).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-ink-3">{FIELD_LABEL[k] ?? k}</dt>
                    <dd className={cx("text-right", k === "idNumberHash" && "truncate font-mono text-xs")}>{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-ink-3">沒有擷取到欄位</p>
            )}
          </Panel>
          <Panel title="分數">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {Object.entries(c.scores ?? {}).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="font-mono">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>
      </div>
      {c.review && <Notice>已由 {c.review.by} 於 {new Date(c.review.at).toLocaleString("zh-TW")} {c.review.decision === "approved" ? "核准" : "退件"}{c.review.note ? `：${c.review.note}` : ""}</Notice>}
      {c.result?.error && <Notice tone="danger">鏈上處理失敗：{c.result.error}</Notice>}
      {c.status === "review" && (
        <Panel title="決策">
          <textarea className={cx(inputCls, "h-20 py-2")} placeholder="備註（退件原因會記錄在案件中）" value={note} onChange={(e) => setNote(e.target.value)} data-testid="review-note" />
          {err && <div className="mt-2"><Notice tone="danger">{err}</Notice></div>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="danger" onClick={() => decide("rejected")} busy={busy === "rejected"} disabled={!!busy} testId="review-reject">退件</Button>
            <Button onClick={() => decide("approved")} busy={busy === "approved"} disabled={!!busy} testId="review-approve">核准並寫入 L2</Button>
          </div>
          <p className="mt-2 text-xs text-ink-3">{c.purpose === "recover" ? "核准恢復案件＝確認與開戶時是同一人，會以平台備援金鑰發起恢復（48 小時／有卡 7 天時間鎖）。" : "核准後寫入實名證明（v1＋v2），使用者端會接著安裝平台備援金鑰。"}</p>
        </Panel>
      )}
    </div>
  );
}
