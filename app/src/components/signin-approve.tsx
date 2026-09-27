"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { api } from "@/lib/client";
import { encode1271 } from "@/lib/userop";
import { signWithPasskey } from "@/lib/webauthn";
import { findSignIn, recordSignIn, subscribeSignIns } from "@/lib/signin-history";
import {
  claimsString,
  encodePayload,
  signInHash,
  type Claim,
  type SignInError,
  type SignInMessage,
  type SignInRequest,
  type SignInResponse,
} from "@/lib/signin";
import { CafecaTile } from "./cafeca-logo";
import { PasskeyIcon } from "./icons";
import { useWallet } from "./wallet-provider";
import { Badge, Button, Notice, cx, errMsg, short } from "./ui";

type SiteMeta = { name?: string; icon?: string };

const CLAIM_LABEL: Record<Claim, string> = { kyc_level: "實名驗證等級", handle: "CAFECA 代稱" };

/**
 * 網站自己宣告的名稱與圖示：https://<domain>/.well-known/cafeca-site.json（需開放 CORS）。
 * 由網站自己宣告、CAFECA 不背書，畫面上永遠以網域為主、名稱為輔。
 */
function useSiteMeta(domain: string): SiteMeta | null {
  const [meta, setMeta] = useState<SiteMeta | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    fetch(`${domain}/.well-known/cafeca-site.json`, { signal: ctl.signal, credentials: "omit", redirect: "error" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { name?: unknown; icon?: unknown } | null) => {
        if (!j) return;
        const name = typeof j.name === "string" ? j.name.trim().slice(0, 40) : undefined;
        let icon: string | undefined;
        if (typeof j.icon === "string") {
          try {
            const u = new URL(j.icon, domain);
            if (u.origin === domain) icon = u.href; // 圖示只接受網站自己網域上的檔案
          } catch {
            /* ignore */
          }
        }
        setMeta({ name: name || undefined, icon });
      })
      .catch(() => setMeta({}))
      .finally(() => clearTimeout(t));
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [domain]);
  return meta;
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** 把結果送回網站：只送往請求中的 origin（popup 的 targetOrigin、redirect／response URI 皆已檢查同源） */
async function deliver(req: SignInRequest, payload: SignInResponse | SignInError): Promise<"closed" | "redirected" | "posted"> {
  if (req.mode === "popup") {
    if (!window.opener) throw new Error("找不到原本的網站視窗，請回到網站重新點選登入");
    (window.opener as Window).postMessage(payload, req.domain);
    setTimeout(() => window.close(), 150);
    return "closed";
  }
  if (req.mode === "redirect") {
    const u = new URL(req.redirectUri!);
    u.hash = `cafeca=${encodePayload(payload)}`;
    window.location.replace(u.href);
    return "redirected";
  }
  // post（跨裝置 QR）：no-cors 單向送出，網站後端收到後由原本的頁面輪詢取得結果
  await fetch(req.responseUri!, {
    method: "POST",
    mode: "no-cors",
    credentials: "omit",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(payload),
  });
  return "posted";
}

export function SignInApprove({ request }: { request: SignInRequest }) {
  const { wallet, handle: sessionHandle, chain } = useWallet();
  const w = wallet!;
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  useEffect(() => {
    api<{ handle: string | null }>(`/api/profile?q=${w.address}`).then((r) => setLookedUp(r.handle)).catch(() => undefined);
  }, [w.address]);
  const handle = sessionHandle ?? lookedUp;
  const meta = useSiteMeta(request.domain);
  const now = useNow();
  const host = useMemo(() => new URL(request.domain).host, [request.domain]);
  const first = useSyncExternalStore(
    subscribeSignIns,
    () => !findSignIn(w.address, request.domain),
    () => false,
  );
  const [grant, setGrant] = useState<Record<Claim, boolean>>(() => ({
    kyc_level: request.claims?.includes("kyc_level") ?? false,
    handle: request.claims?.includes("handle") ?? false,
  }));
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"posted" | "denied" | null>(null);

  const left = request.expiresAt - now;
  const expired = left <= 0;
  const insecure = request.domain.startsWith("http:");

  const approve = async () => {
    setBusy("approve");
    setError(null);
    try {
      if (!chain.deployed && chain.loaded) throw new Error("身分合約尚未部署，無法簽署登入");
      const granted = (Object.keys(grant) as Claim[]).filter((c) => grant[c] && request.claims?.includes(c));
      const message: SignInMessage = {
        domain: request.domain,
        uri: request.uri,
        nonce: request.nonce,
        issuedAt: request.issuedAt,
        expiresAt: request.expiresAt,
        statement: request.statement ?? "",
        claims: claimsString(granted),
      };
      const hash = signInHash(w.address, CHAIN_ID, message);
      const { keyId, sig } = await signWithPasskey(hash, w.passkeys);
      const res: SignInResponse = {
        v: 1,
        type: "cafeca:auth",
        account: w.address,
        chainId: CHAIN_ID,
        message,
        signature: encode1271(DEPLOYMENT.keyring, keyId, sig),
        claims: granted.includes("handle") ? { handle } : {},
        state: request.state,
      };
      recordSignIn(w.address, request.domain, message.claims, meta?.name);
      const r = await deliver(request, res);
      if (r === "posted") setDone("posted");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const deny = async () => {
    setBusy("deny");
    try {
      await deliver(request, { v: 1, type: "cafeca:auth", error: "access_denied", nonce: request.nonce, state: request.state });
      setDone("denied");
    } catch {
      setDone("denied");
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div className="space-y-3 text-center" data-testid="signin-done">
        <div className="text-4xl">{done === "posted" ? "✓" : "✕"}</div>
        <div className="text-lg font-semibold">{done === "posted" ? "已登入" : "已拒絕登入"}</div>
        <p className="text-sm text-ink-2">
          {done === "posted" ? `請回到原本的裝置，${host} 會自動完成登入。` : `已通知 ${host}。`}這個頁面可以關閉了。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="signin-approve">
      <div className="flex items-center gap-3">
        {meta?.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={meta.icon} alt="" className="size-12 rounded-xl border border-line object-cover" />
        ) : (
          <div className="grid size-12 place-items-center rounded-xl border border-line bg-surface-2 text-lg font-semibold text-ink-2">
            {host[0]?.toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-lg font-semibold" data-testid="signin-domain">{host}</div>
          <div className="truncate text-xs text-ink-3">{meta?.name ? `網站自稱「${meta.name}」` : "網站未提供名稱"}</div>
        </div>
        {first ? <Badge tone="warn">第一次連線</Badge> : <Badge tone="ok">曾登入</Badge>}
      </div>

      <p className="text-sm text-ink-2">
        這個網站想確認你是 CAFECA 身分 <span className="font-mono">{short(w.address, 6)}</span> 的擁有者。登入只會產生一個簽章，<strong>不會轉帳、不會授權任何代幣，網站也無法用它代替你做任何事</strong>。
      </p>

      {request.statement && (
        <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm">
          <div className="mb-0.5 text-[11px] text-ink-3">網站說明</div>
          {request.statement}
        </div>
      )}

      {!!request.claims?.length && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-ink-3">網站要求提供（可取消勾選）</div>
          {request.claims.map((c) => (
            <label key={c} className="flex items-center justify-between rounded-xl border border-line px-3 py-2 text-sm">
              <span>
                {CLAIM_LABEL[c]}
                <span className="ml-2 text-xs text-ink-3">
                  {c === "kyc_level" ? (chain.level >= 2 ? "L2 已實名" : chain.level === 1 ? "L1" : "未實名") : handle ? `@${handle}` : "尚未設定"}
                </span>
              </span>
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand)]"
                checked={grant[c]}
                onChange={(e) => setGrant((g) => ({ ...g, [c]: e.target.checked }))}
                data-testid={`claim-${c}`}
              />
            </label>
          ))}
          <p className="text-[11px] text-ink-3">實名等級由網站直接向鏈上查詢，不會提供姓名、生日或證號。</p>
        </div>
      )}

      {request.mode === "post" && (
        <Notice tone="warn">
          這是跨裝置登入。請確認<strong>你本人</strong>正在另一台裝置上瀏覽 <span className="font-mono">{host}</span>，而且 QR code 是你自己剛剛打開的；如果是別人傳給你、或出現在其他網站上的 QR code，請按拒絕。
        </Notice>
      )}
      {insecure && <Notice tone="warn">這個網站使用未加密的 http 連線（僅限本機開發）。</Notice>}
      {chain.recoveryPending && <Notice tone="danger">你的身分正在進行恢復程序，網站可能會拒絕這次登入。</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}

      <div className={cx("text-center text-xs", expired ? "text-danger" : "text-ink-3")}>
        {expired ? "登入請求已過期，請回到網站重新登入" : `請在 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 內完成`}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={deny} busy={busy === "deny"} disabled={!!busy} testId="signin-deny">
          拒絕
        </Button>
        <Button onClick={approve} busy={busy === "approve"} disabled={!!busy || expired} testId="signin-approve-btn">
          <PasskeyIcon className="size-5" /> 登入
        </Button>
      </div>
      <div className="flex items-center justify-center gap-1.5 text-[11px] text-ink-3">
        <CafecaTile className="size-3.5" rounded="rounded" /> Sign in with CAFECA · 網站不需向 CAFECA 註冊
      </div>
    </div>
  );
}
