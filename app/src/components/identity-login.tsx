"use client";

import { useEffect, useRef, useState } from "react";
import { PUBLIC } from "@/lib/config";
import { api } from "@/lib/client";
import { Button, inputCls, Notice, errMsg } from "./ui";

type GoogleId = {
  accounts: {
    id: {
      initialize: (o: { client_id: string; nonce?: string; callback: (r: { credential: string }) => void; auto_select?: boolean }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
    };
  };
};
type AppleId = {
  auth: {
    init: (o: Record<string, unknown>) => void;
    signIn: () => Promise<{ authorization: { id_token: string } }>;
  };
};
declare global {
  interface Window {
    google?: GoogleId;
    AppleID?: AppleId;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`無法載入 ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * Google／Apple 登入（id_token 的 nonce 由呼叫端提供：綁定 passkey 公鑰或恢復請求）
 * 另有測試網開發者登入（NEXT_PUBLIC_DEV_LOGIN=1）
 */
export function IdentityLogin({
  nonce,
  onToken,
  disabled,
}: {
  nonce?: string;
  onToken: (idToken: string) => void | Promise<void>;
  disabled?: boolean;
}) {
  const googleRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!PUBLIC.googleClientId || disabled) return;
    let cancelled = false;
    loadScript("https://accounts.google.com/gsi/client")
      .then(() => {
        if (cancelled || !window.google || !googleRef.current) return;
        window.google.accounts.id.initialize({
          client_id: PUBLIC.googleClientId,
          nonce,
          callback: (r) => onTokenRef.current(r.credential),
        });
        googleRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(googleRef.current, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
          locale: "zh-TW",
          width: 320,
        });
      })
      .catch((e) => setErr(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, [nonce, disabled]);

  const apple = async () => {
    setErr(null);
    try {
      await loadScript("https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/zh_TW/appleid.auth.js");
      window.AppleID!.auth.init({
        clientId: PUBLIC.appleClientId,
        scope: "email",
        redirectURI: window.location.origin,
        usePopup: true,
        nonce,
      });
      const r = await window.AppleID!.auth.signIn();
      await onTokenRef.current(r.authorization.id_token);
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const dev = async () => {
    setErr(null);
    setBusy(true);
    try {
      const { idToken } = await api<{ idToken: string }>("/api/oidc/dev-token", { email, nonce: nonce ?? "" });
      await onTokenRef.current(idToken);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const none = !PUBLIC.googleClientId && !PUBLIC.appleClientId && !PUBLIC.devLogin;

  return (
    <div className={disabled ? "pointer-events-none opacity-50" : ""}>
      <div className="flex flex-col items-center gap-3">
        {PUBLIC.googleClientId && <div ref={googleRef} className="min-h-[44px]" />}
        {PUBLIC.appleClientId && (
          <Button variant="secondary" className="w-full max-w-[320px] !rounded-full" onClick={apple}>
            <span aria-hidden></span> 使用 Apple 帳號繼續
          </Button>
        )}
      </div>
      {PUBLIC.devLogin && (
        <div className="mt-4 rounded-xl border border-dashed border-line p-3">
          <div className="mb-2 text-xs font-medium text-warn">測試網開發者登入（模擬 Google id_token）</div>
          <div className="flex gap-2">
            <input className={inputCls} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button variant="secondary" onClick={dev} busy={busy} disabled={!email.includes("@")}>
              登入
            </Button>
          </div>
        </div>
      )}
      {none && <Notice tone="warn">尚未設定 Google／Apple Client ID。請在 .env.local 設定 NEXT_PUBLIC_GOOGLE_CLIENT_ID，或開啟 NEXT_PUBLIC_DEV_LOGIN=1。</Notice>}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}
