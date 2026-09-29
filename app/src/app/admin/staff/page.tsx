"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall } from "@/components/admin-login";
import { Badge, Button, Notice, Panel, Spinner, errMsg, inputCls } from "@/components/ui";

type S = {
  id: string;
  name: string;
  who: string;
  roles: string[];
  active: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  passkeys: { credentialId: string; label: string; addedAt: number; lastUsedAt: number | null }[];
};
type Res = { me: string; roles: { key: string; label: string }[]; staff: S[] };

/** 人員管理：邀請、角色、Passkey、停用（admin） */
export default function StaffPage() {
  const [data, setData] = useState<Res | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [link, setLink] = useState<{ who: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await adminCall<Res>("/api/admin/staff"));
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
  if (needLogin) return <AdminLogin title="人員管理" onDone={load} />;

  const act = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      const r = await adminCall<{ code?: string }>("/api/admin/staff", body);
      if (r.code) setLink({ who: String(body.name ?? data?.staff.find((s) => s.id === body.staffId)?.name ?? ""), url: `${location.origin}/admin/join?code=${r.code}` });
      await load();
      return true;
    } catch (e) {
      setErr(errMsg(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-5 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">人員管理</h1>
        {data && <span className="whitespace-nowrap text-sm text-ink-3">{data.me}</span>}
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
      {link && (
        <Notice tone="ok">
          <div className="space-y-1">
            <div>給 {link.who} 的邀請連結（72 小時內有效、只能使用一次、只顯示這一次），請以安全管道傳送：</div>
            <code className="block break-all rounded bg-surface-2 p-2 text-xs" data-testid="staff-invite-link">{link.url}</code>
          </div>
        </Notice>
      )}
      <Panel title="邀請人員">
        <div className="space-y-3">
          <input className={inputCls} placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} data-testid="invite-name" />
          <div className="flex flex-wrap gap-3 text-sm">
            {data?.roles.map((r) => (
              <label key={r.key} className="flex items-center gap-1.5">
                <input type="checkbox" checked={roles.includes(r.key)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.key] : roles.filter((x) => x !== r.key))} data-testid={`invite-role-${r.key}`} />
                {r.label}
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <Button busy={busy === "invite"} testId="invite-submit" onClick={async () => { if (await act("invite", { action: "invite", name, roles })) { setName(""); setRoles([]); } }}>產生邀請連結</Button>
          </div>
          <p className="text-xs text-ink-3">職能分離：管理者角色不會自動擁有複核或調閱權限；資料調閱需要至少兩位不同的人員具備「資料調閱核准」。</p>
        </div>
      </Panel>
      <Panel title="人員">
        {!data ? (
          <Spinner className="text-brand" />
        ) : (
          <ul className="divide-y divide-line" data-testid="staff-list">
            {data.staff.map((s) => (
              <li key={s.id} className="space-y-2 py-3 text-sm" data-testid={`staff-${s.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.who}</span>
                    <Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "啟用" : "停用"}</Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" busy={busy === s.id + "k"} onClick={() => act(s.id + "k", { action: "invite", staffId: s.id })}>新增 Passkey</Button>
                    <Button size="sm" variant="secondary" busy={busy === s.id} testId={`staff-toggle-${s.id}`} onClick={() => act(s.id, { action: "active", staffId: s.id, active: !s.active })}>{s.active ? "停用" : "恢復"}</Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  {data.roles.map((r) => (
                    <label key={r.key} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={s.roles.includes(r.key)}
                        onChange={(e) => act(s.id, { action: "roles", staffId: s.id, roles: e.target.checked ? [...s.roles, r.key] : s.roles.filter((x) => x !== r.key) })}
                        data-testid={`staff-role-${s.id}-${r.key}`}
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
                <div className="text-xs text-ink-3">
                  建立 {new Date(s.createdAt).toLocaleDateString("zh-TW")} · 最近登入 {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString("zh-TW") : "—"} · Passkey：
                  {s.passkeys.map((k) => (
                    <span key={k.credentialId} className="ml-1">
                      {k.label}
                      {s.passkeys.length > 1 && (
                        <button className="ml-1 text-danger underline" onClick={() => act(s.id, { action: "removeKey", staffId: s.id, credentialId: k.credentialId })}>移除</button>
                      )}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
