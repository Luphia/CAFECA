"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Badge, Button, Field, Notice, Panel, Spinner, cx, errMsg, inputCls, short } from "@/components/ui";

type Info = {
  admin: string;
  limitAdmin: string | null;
  supported: boolean;
  reasons: Record<string, string>;
  account?: string;
  handle?: string | null;
  level?: number;
  limits?: { perTx: string; daily: string; spentToday: string };
  history?: { block: number; tx: string; perTx: string; daily: string; reason: number; admin: string }[];
};

const fmt = (v: string) => Number(v).toLocaleString("zh-TW", { maximumFractionDigits: 6 });

/** 交易額度管理：使用者不能自行修改額度，只能由管理者在這裡調升或調降（每次都記錄原因與備註） */
export default function LimitsAdminPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ perTx: "", daily: "", reason: "1", note: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async (query?: string) => {
    setErr(null);
    try {
      const r = await adminCall<Info>(`/api/admin/limits${query ? `?q=${encodeURIComponent(query)}` : ""}`);
      setInfo(r);
      setNeedLogin(false);
      if (r.limits) setForm((f) => ({ ...f, perTx: r.limits!.perTx, daily: r.limits!.daily }));
    } catch (e) {
      if ((e as { status?: number }).status === 401) setNeedLogin(true);
      else setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (needLogin) return <AdminLogin title="交易額度管理" onDone={() => load()} />;

  const search = async () => {
    setBusy("search");
    setOk(null);
    await load(q);
    setBusy(null);
  };

  const save = async () => {
    if (!info?.account) return;
    setBusy("save");
    setErr(null);
    setOk(null);
    try {
      const r = await adminCall<{ tx: string; limits: { perTx: string; daily: string } }>("/api/admin/limits", {
        account: info.account,
        perTx: form.perTx,
        daily: form.daily,
        reason: Number(form.reason),
        note: form.note,
      });
      setOk(`已更新：單筆 ${fmt(r.limits.perTx)}／每日 ${fmt(r.limits.daily)} TWDC（交易 ${short(r.tx, 6)}）`);
      setForm((f) => ({ ...f, note: "" }));
      await load(info.account);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const cur = info?.limits;
  const direction = cur && form.perTx && form.daily ? (Number(form.perTx) > Number(cur.perTx) || Number(form.daily) > Number(cur.daily) ? "調升" : Number(form.perTx) < Number(cur.perTx) || Number(form.daily) < Number(cur.daily) ? "調降" : "不變") : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">交易額度管理</h1>
        {info && <span className="text-sm text-ink-3">管理者：{info.admin}</span>}
      </div>
      {info && !info.supported && (
        <Notice tone="warn">目前部署的 KeyringValidator 是 v1，不支援管理者調整額度（使用者端的調整已由 bundler 拒絕）。部署 v2 後才能在這裡調整。</Notice>
      )}
      {err && <Notice tone="danger">{err}</Notice>}
      {ok && <Notice tone="ok">{ok}</Notice>}

      <Panel>
        <div className="flex gap-2">
          <input className={inputCls} placeholder="身分地址 0x… 或 @代稱" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} data-testid="limits-q" />
          <Button onClick={search} busy={busy === "search"} disabled={!q.trim()} testId="limits-search">查詢</Button>
        </div>
      </Panel>

      {!info ? (
        <Spinner className="text-brand" />
      ) : (
        info.account &&
        cur && (
          <>
            <Panel title={info.handle ? `@${info.handle}` : short(info.account, 6)} action={<Badge tone={info.level! >= 2 ? "ok" : "neutral"}>L{info.level}</Badge>}>
              <div className="mb-3 font-mono text-xs text-ink-3">{info.account}</div>
              <div className="grid grid-cols-3 gap-3 text-sm" data-testid="limits-current">
                {[
                  ["單筆上限", cur.perTx],
                  ["每日上限", cur.daily],
                  ["今日已用", cur.spentToday],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-line px-3 py-2.5">
                    <div className="text-xs text-ink-3">{k}</div>
                    <div className="font-semibold">{fmt(v)} TWDC</div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="調整額度" action={direction && direction !== "不變" ? <Badge tone={direction === "調升" ? "warn" : "brand"}>{direction}</Badge> : undefined}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="單筆上限（TWDC）">
                  <input className={inputCls} value={form.perTx} onChange={(e) => setForm({ ...form, perTx: e.target.value })} inputMode="decimal" data-testid="limits-pertx" />
                </Field>
                <Field label="每日上限（TWDC）">
                  <input className={inputCls} value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} inputMode="decimal" data-testid="limits-daily" />
                </Field>
                <Field label="原因">
                  <select className={inputCls} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} data-testid="limits-reason">
                    {Object.entries(info.reasons).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field label="備註（申請單號等，必填）">
                  <input className={inputCls} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} data-testid="limits-note" />
                </Field>
              </div>
              <Button className="mt-3 w-full" onClick={save} busy={busy === "save"} disabled={!info.supported || !form.note.trim() || direction === "不變"} testId="limits-save">
                送出調整
              </Button>
              <p className="mt-2 text-xs text-ink-3">調整會以管理者身分送出鏈上交易，並寫入稽核紀錄。超過日常額度的交易，使用者仍需要實體卡確認。</p>
            </Panel>

            <Panel title="調整紀錄（鏈上）">
              {!info.history?.length ? (
                <p className="text-sm text-ink-3">沒有紀錄</p>
              ) : (
                <ul className="divide-y divide-line text-sm" data-testid="limits-history">
                  {info.history.map((h) => (
                    <li key={h.tx} className={cx("flex items-center justify-between gap-3 py-2")}>
                      <span>
                        單筆 {fmt(h.perTx)}／每日 {fmt(h.daily)}
                        <span className="ml-2 text-xs text-ink-3">{info.reasons[h.reason] ?? h.reason}</span>
                      </span>
                      <span className="font-mono text-xs text-ink-3">#{h.block} · {short(h.tx, 4)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )
      )}
    </div>
  );
}
