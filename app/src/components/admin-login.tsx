"use client";

import { useState } from "react";
import { Button, Notice, Panel, errMsg, inputCls } from "./ui";

export async function adminCall<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error ?? `HTTP ${r.status}`), { status: r.status });
  return j as T;
}

/** 管理後台登入（KYC_REVIEW_TOKEN＋管理者姓名；KYC 複核與交易額度共用） */
export function AdminLogin({ title, onDone }: { title: string; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-sm space-y-4 px-5 py-16">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Panel>
        <div className="space-y-3">
          <input className={inputCls} placeholder="管理者姓名" value={name} onChange={(e) => setName(e.target.value)} data-testid="reviewer-name" />
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
                await adminCall("/api/admin/kyc/login", { token, name });
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
          <p className="text-xs text-ink-3">所有檢視與操作都會記錄管理者姓名。</p>
        </div>
      </Panel>
    </div>
  );
}
