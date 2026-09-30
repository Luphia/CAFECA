"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Button, Notice, Panel, Spinner, TxLink, errMsg, inputCls } from "@/components/ui";

type Entry = { seq: number; at: string; who: string; action: string; hash: string; [k: string]: unknown };
type Anchor = { count: number; head: string; tx: string; block: number; at: number; onchain: boolean; match: boolean };
type Res = {
  reviewer: string;
  chain: { ok: boolean; count: number; head: string; brokenAt?: number; reason?: string };
  anchors: { deployed: boolean; address?: string; lastCount?: number; anchors: Anchor[]; ok: boolean };
  entries: Entry[];
};

/** 稽核紀錄：hash-chained，每次開啟都重新驗證整條鏈 */
export default function AuditPage() {
  const [data, setData] = useState<Res | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [q, setQ] = useState({ action: "", subject: "" });
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ action: q.action, subject: q.subject });
      setData(await adminCall<Res>(`/api/admin/audit?${p}`));
      setNeedLogin(false);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setNeedLogin(true);
      else setErr(errMsg(e));
    }
  }, [q]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (needLogin) return <AdminLogin title="稽核紀錄" onDone={load} />;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-5 py-8">
      <h1 className="text-2xl font-bold">稽核紀錄</h1>
      {err && <Notice tone="danger">{err}</Notice>}
      {data &&
        (data.chain.ok ? (
          <Notice tone="ok"><span data-testid="audit-chain">hash 鏈完整：{data.chain.count} 筆，最新 {data.chain.head.slice(0, 16)}…</span></Notice>
        ) : (
          <Notice tone="danger"><span data-testid="audit-chain">hash 鏈斷裂：第 {data.chain.brokenAt} 筆，{data.chain.reason}</span></Notice>
        ))}
      {data && (
        <Panel
          title="鏈上錨點"
          action={data.anchors.deployed ? <Button size="sm" variant="secondary" testId="audit-anchor-now" onClick={async () => { try { await adminCall("/api/admin/audit", {}); await load(); } catch (e) { setErr(errMsg(e)); } }}>立即上鏈</Button> : undefined}
        >
          {!data.anchors.deployed ? (
            <p className="text-sm text-ink-3">尚未部署 AuditAnchor（npm run deploy -- --anchor）。</p>
          ) : (
            <div className="space-y-2 text-sm">
              {data.anchors.ok ? (
                <p className="text-ok" data-testid="audit-anchors">✓ 目前的紀錄與鏈上 {data.anchors.anchors.length} 個錨點都相符（鏈上最新：第 {data.anchors.lastCount} 筆）</p>
              ) : (
                <p className="text-danger" data-testid="audit-anchors">✕ 有錨點與目前的紀錄不符：紀錄在上鏈之後被改寫</p>
              )}
              <ul className="divide-y divide-line text-xs">
                {data.anchors.anchors.slice(0, 10).map((a) => (
                  <li key={a.tx} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className={a.match ? "text-ok" : "text-danger"}>{a.match ? "相符" : "不符"}</span>
                    <span>第 {a.count} 筆</span>
                    <span className="font-mono">{a.head.slice(0, 16)}…</span>
                    <span className="text-ink-3">{new Date(a.at).toLocaleString("zh-TW")}</span>
                    <TxLink hash={a.tx as `0x${string}`} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      )}
      <Panel>
        <form className="mb-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); setQ({ action: String(f.get("action")), subject: String(f.get("subject")) }); }}>
          <input name="action" className={`${inputCls} h-9 w-44`} placeholder="動作前綴（disclosure.）" defaultValue={q.action} />
          <input name="subject" className={`${inputCls} h-9 w-72`} placeholder="帳戶、案件 id、複核人" defaultValue={q.subject} />
          <Button size="sm" variant="secondary" type="submit">查詢</Button>
        </form>
        {!data ? (
          <Spinner className="text-brand" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="audit-table">
              <thead className="text-ink-3"><tr><th className="py-1 pr-3">#</th><th className="pr-3">時間</th><th className="pr-3">操作人</th><th className="pr-3">動作</th><th>內容</th></tr></thead>
              <tbody className="divide-y divide-line">
                {data.entries.map((e) => {
                  const rest = Object.fromEntries(Object.entries(e).filter(([k]) => !["seq", "at", "who", "action", "prev", "hash"].includes(k)));
                  return (
                    <tr key={e.seq} className="align-top">
                      <td className="py-1.5 pr-3 font-mono">{e.seq}</td>
                      <td className="pr-3 whitespace-nowrap">{new Date(e.at).toLocaleString("zh-TW")}</td>
                      <td className="pr-3">{e.who}</td>
                      <td className="pr-3 font-mono">{e.action}</td>
                      <td className="break-all font-mono text-ink-2">{JSON.stringify(rest)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
