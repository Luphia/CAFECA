"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Badge, Button, Notice, Panel, Spinner, errMsg, inputCls } from "@/components/ui";

type Rp = { id: string; name: string; ubn: string | null; domains: string[]; contact: string; active: boolean; createdAt: number; createdBy: string; dpa: { version: string; signedAt: string } | null };

/** 依賴方登記：資料調閱 API 的使用者（交易所、合作網站）；API 金鑰只在建立時顯示一次 */
export default function RelyingPartyPage() {
  const [data, setData] = useState<{ reviewer: string; relyingParties: Rp[] } | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [form, setForm] = useState({ name: "", ubn: "", domains: "", contact: "", encJwk: "", dpaVersion: "", dpaSignedAt: "" });
  const [created, setCreated] = useState<{ rp: Rp; apiKey: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminCall<{ reviewer: string; relyingParties: Rp[] }>("/api/admin/rp"));
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

  if (needLogin) return <AdminLogin title="依賴方登記" onDone={load} />;

  const create = async () => {
    setBusy("create");
    setErr(null);
    try {
      const r = await adminCall<{ rp: Rp; apiKey: string }>("/api/admin/rp", { ...form, domains: form.domains.split(/[\s,]+/).filter(Boolean) });
      setCreated(r);
      setForm({ name: "", ubn: "", domains: "", contact: "", encJwk: "", dpaVersion: "", dpaSignedAt: "" });
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (r: Rp) => {
    setBusy(r.id);
    try {
      await adminCall("/api/admin/rp", { id: r.id, active: !r.active });
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-5 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">依賴方登記</h1>
        {data && <span className="text-sm text-ink-3">操作人：{data.reviewer}</span>}
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
      {created && (
        <Notice tone="ok">
          <div className="space-y-1">
            <div>已建立「{created.rp.name}」。API 金鑰只顯示這一次，請以安全管道交給對方：</div>
            <code className="block break-all rounded bg-surface-2 p-2 text-xs" data-testid="rp-api-key">{created.apiKey}</code>
          </div>
        </Notice>
      )}
      <Panel title="新增依賴方">
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={inputCls} placeholder="名稱（例：某某交易所）" value={form.name} onChange={set("name")} data-testid="rp-name" />
          <input className={inputCls} placeholder="統一編號（選填）" value={form.ubn} onChange={set("ubn")} data-testid="rp-ubn" />
          <input className={inputCls} placeholder="網域，逗號分隔（與 Sign in with CAFECA 的 domain 相同）" value={form.domains} onChange={set("domains")} data-testid="rp-domains" />
          <input className={inputCls} placeholder="法遵聯絡人與信箱" value={form.contact} onChange={set("contact")} data-testid="rp-contact" />
          <input className={inputCls} placeholder="資料處理約定（DPA）版本，例：CAFECA-DPA-2026.1" value={form.dpaVersion} onChange={set("dpaVersion")} data-testid="rp-dpa-version" />
          <input className={inputCls} type="date" value={form.dpaSignedAt} onChange={set("dpaSignedAt")} data-testid="rp-dpa-date" aria-label="DPA 簽署日期" />
          <textarea className={`${inputCls} h-24 font-mono text-xs sm:col-span-2`} placeholder='加密公鑰 JWK（P-256），例：{"kty":"EC","crv":"P-256","x":"…","y":"…"}；對方可用 npm run rp -- keygen 產生' value={form.encJwk} onChange={set("encJwk")} data-testid="rp-jwk" />
        </div>
        <div className="mt-3 flex justify-end">
          <Button onClick={create} busy={busy === "create"} testId="rp-create">建立並發給 API 金鑰</Button>
        </div>
      </Panel>
      <Panel title="已登記">
        {!data ? (
          <Spinner className="text-brand" />
        ) : data.relyingParties.length === 0 ? (
          <p className="text-sm text-ink-3">還沒有依賴方</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="rp-list">
            {data.relyingParties.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge tone={r.active ? "ok" : "neutral"}>{r.active ? "啟用" : "停用"}</Badge>
                    {r.dpa ? <Badge>DPA {r.dpa.version}（{r.dpa.signedAt}）</Badge> : <Badge tone="danger">未登記 DPA，API 停用</Badge>}
                  </div>
                  <div className="truncate text-xs text-ink-3">
                    <span className="font-mono">{r.id}</span> · {r.ubn ? `統編 ${r.ubn} · ` : ""}
                    {r.domains.join("、")} · {r.contact} · {r.createdBy} 建立於 {new Date(r.createdAt).toLocaleDateString("zh-TW")}
                  </div>
                </div>
                <Button size="sm" variant="secondary" busy={busy === r.id} onClick={() => toggle(r)}>{r.active ? "停用" : "恢復"}</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
