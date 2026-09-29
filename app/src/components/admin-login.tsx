"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { b64urlDecode, b64urlEncode, registerPasskey } from "@/lib/webauthn";
import { Button, Notice, Panel, Spinner, errMsg, inputCls } from "./ui";

export async function adminCall<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j as { error?: string }).error ?? `HTTP ${r.status}`), { status: r.status });
  return j as T;
}

export type StaffView = { id: string; name: string; who: string; roles: string[] };

/** 以管理後台人員的 Passkey 登入（WebAuthn assertion 交給伺服器驗證） */
export async function staffPasskeyLogin(): Promise<StaffView> {
  const { challenge } = await adminCall<{ challenge: string }>("/api/admin/session", { action: "challenge" });
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: b64urlDecode(challenge) as BufferSource, rpId: location.hostname, userVerification: "required", timeout: 120_000 },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("已取消");
  const r = cred.response as AuthenticatorAssertionResponse;
  const { staff } = await adminCall<{ staff: StaffView }>("/api/admin/session", {
    action: "login",
    credentialId: b64urlEncode(new Uint8Array(cred.rawId)),
    authenticatorData: b64urlEncode(new Uint8Array(r.authenticatorData)),
    clientDataJSON: b64urlEncode(new Uint8Array(r.clientDataJSON)),
    signature: b64urlEncode(new Uint8Array(r.signature)),
  });
  return staff;
}

/** 在這台裝置建立管理後台專用的 Passkey（與錢包的 Passkey 分開） */
export async function newStaffPasskey(name: string) {
  const p = await registerPasskey(`CAFECA 管理後台 · ${name}`, navigator.platform || "Passkey");
  return { credentialId: p.credentialId, qx: p.qx, qy: p.qy, label: p.label };
}

/** 管理後台登入：每位人員以自己的 Passkey 登入；尚無管理者時以 KYC_REVIEW_TOKEN 建立第一位管理者 */
export function AdminLogin({ title, onDone }: { title: string; onDone: () => void }) {
  const [bootstrap, setBootstrap] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminCall<{ bootstrap: boolean }>("/api/admin/session")
      .then((r) => setBootstrap(r.bootstrap))
      .catch(() => setBootstrap(false));
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm space-y-4 px-5 py-16">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Panel>
        {bootstrap === null ? (
          <Spinner className="text-brand" />
        ) : bootstrap ? (
          <div className="space-y-3" data-testid="staff-bootstrap">
            <Notice>還沒有任何管理者。以部署時產生的 KYC_REVIEW_TOKEN 建立第一位管理者，並在這台裝置建立你的 Passkey。建立後這個密碼就不能再登入。</Notice>
            <input className={inputCls} placeholder="你的姓名" value={name} onChange={(e) => setName(e.target.value)} data-testid="bootstrap-name" />
            <input className={inputCls} placeholder="KYC_REVIEW_TOKEN" type="password" value={token} onChange={(e) => setToken(e.target.value)} data-testid="bootstrap-token" />
            {err && <Notice tone="danger">{err}</Notice>}
            <Button
              className="w-full"
              busy={busy}
              testId="bootstrap-submit"
              onClick={() => run(async () => adminCall("/api/admin/session", { action: "bootstrap", token, name, passkey: await newStaffPasskey(name) }))}
            >
              建立 Passkey 並成為管理者
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {err && <Notice tone="danger">{err}</Notice>}
            <Button className="w-full" busy={busy} testId="staff-login" onClick={() => run(staffPasskeyLogin)}>
              以 Passkey 登入
            </Button>
            <p className="text-xs text-ink-3">請選擇「CAFECA 管理後台」的 Passkey。沒有帳號請向管理者索取邀請連結。所有檢視與操作都會記錄在你的帳號下。</p>
          </div>
        )}
      </Panel>
      <p className="text-center text-xs text-ink-3">
        <Link href="/admin" className="underline">管理後台首頁</Link>
      </p>
    </div>
  );
}
