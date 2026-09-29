"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { api } from "@/lib/client";
import { encode1271 } from "@/lib/userop";
import { entity1271 } from "@/lib/entity";
import { signWithPasskey } from "@/lib/webauthn";
import { findSignIn, recordSignIn, subscribeSignIns } from "@/lib/signin-history";
import { newChannel, storeChannel } from "@/lib/channel-store";
import { CREDENTIAL_CLAIMS, DOC_TYPE_LABEL, type CredentialClaim, type DocType, type KycCredential } from "@/lib/kyc-credential";
import {
  channelString,
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
import { Badge, Button, Notice, Switch, cx, errMsg, short } from "./ui";

type SiteMeta = { name?: string; icon?: string };

const CLAIM_LABEL: Record<Claim, string> = {
  kyc_level: "實名驗證等級",
  handle: "CAFECA 代稱",
  legal_name: "證件姓名",
  doc_type: "證件類型",
  nationality: "國籍",
  pairwise_id: "同一人識別碼",
  entity_ubn: "公司統一編號",
  entity_name: "公司登記名稱",
};

const ENTITY_ONLY = ["entity_ubn", "entity_name"];
const PERSON_ONLY = ["handle", "legal_name", "doc_type", "nationality", "pairwise_id"];

type MyEntity = { entity: Address; role: number; displayName: string | null; verified: { ubn: string; name: string } | null; monitor: { status: string } | null };

const isCred = (c: string): c is CredentialClaim => (CREDENTIAL_CLAIMS as readonly string[]).includes(c);

type Available = {
  active: boolean;
  legal_name: string | null;
  doc_type: DocType | null;
  nationality: string | null;
  pairwise_id: boolean;
  entity_ubn: string | null;
  entity_name: string | null;
};
const NO_AVAIL: Available = { active: false, legal_name: null, doc_type: null, nationality: null, pairwise_id: false, entity_ubn: null, entity_name: null };

const NATION: Record<string, string> = { TW: "中華民國（臺灣）" };

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

export function useNow() {
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
  // 實名等級與代稱預設提供；姓名、證件類型、國籍、同一人識別碼屬於個人資料，預設關閉，由使用者逐項開啟
  const [grant, setGrant] = useState<Record<Claim, boolean>>(() => ({
    kyc_level: request.claims?.includes("kyc_level") ?? false,
    handle: request.claims?.includes("handle") ?? false,
    legal_name: false,
    doc_type: false,
    nationality: false,
    pairwise_id: false,
    entity_ubn: false,
    entity_name: false,
  }));
  // 以個人或以公司身分登入：公司帳戶由你以成員身分代為簽署（MemberValidator）
  const [entities, setEntities] = useState<MyEntity[]>([]);
  const [subject, setSubject] = useState<Address>(w.address);
  useEffect(() => {
    api<{ supported: boolean; entities: MyEntity[] }>("/api/entity")
      .then((r) => setEntities(r.entities ?? []))
      .catch(() => undefined);
  }, [w.address]);
  const asEntity = subject.toLowerCase() !== w.address.toLowerCase();
  const subjectEntity = entities.find((e) => e.entity.toLowerCase() === subject.toLowerCase());
  const wantsCred = !!request.claims?.some(isCred);
  const [availFor, setAvailFor] = useState<{ subject: string; v: Available } | null>(null);
  useEffect(() => {
    if (!wantsCred) return;
    let alive = true;
    api<Available>(`/api/kyc/credential${asEntity ? `?account=${subject}` : ""}`)
      .then((v) => alive && setAvailFor({ subject, v }))
      .catch(() => alive && setAvailFor({ subject, v: NO_AVAIL }));
    return () => {
      alive = false;
    };
  }, [wantsCred, subject, asEntity]);
  const avail = availFor?.subject === subject ? availFor.v : null;
  const credValue = (c: CredentialClaim): string | null => {
    if (!avail?.active) return null;
    if (c === "entity_ubn") return avail.entity_ubn;
    if (c === "entity_name") return avail.entity_name;
    if (c === "legal_name") return avail.legal_name;
    if (c === "doc_type") return avail.doc_type ? DOC_TYPE_LABEL[avail.doc_type] : null;
    if (c === "nationality") return avail.nationality ? `${avail.nationality} ${NATION[avail.nationality] ?? ""}`.trim() : null;
    return avail.pairwise_id ? "只給這個網站、無法跨站比對" : null;
  };
  const [allowChannel, setAllowChannel] = useState(!!request.channel);
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
      let granted = (Object.keys(grant) as Claim[]).filter((c) => grant[c] && request.claims?.includes(c) && !(asEntity ? PERSON_ONLY : ENTITY_ONLY).includes(c));
      // 個人資料由 KYC 簽章者簽成 credential（綁定這個網站與這次登入的 nonce）；沒有資料的項目不列入同意範圍
      let credential: KycCredential | null = null;
      const credWanted = granted.filter(isCred);
      if (credWanted.length) {
        credential = (
          await api<{ credential: KycCredential | null }>("/api/kyc/credential", { audience: request.domain, nonce: request.nonce, claims: credWanted, ...(asEntity ? { account: subject } : {}) })
        ).credential;
        const disclosed = credential?.message.disclosed.split(",") ?? [];
        granted = granted.filter((c) => !isCred(c) || disclosed.includes(c));
      }
      // 簽章通道：錢包產生自己的通道金鑰，通道 id 與雙方公鑰一起寫進登入簽章
      const ch =
        request.channel && allowChannel && !asEntity
          ? await newChannel(w.address, request.domain, request.channel.pub, request.channel.ttl!, request.issuedAt, meta?.name)
          : null;
      const message: SignInMessage = {
        domain: request.domain,
        uri: request.uri,
        nonce: request.nonce,
        issuedAt: request.issuedAt,
        expiresAt: request.expiresAt,
        statement: request.statement ?? "",
        claims: claimsString(granted),
        channel: channelString(ch && { id: ch.id, sitePub: ch.sitePub, walletPub: ch.walletPub, expiresAt: ch.expiresAt }),
      };
      const hash = signInHash(subject, CHAIN_ID, message);
      let signature: Hex;
      if (asEntity) {
        signature = await entity1271(w, subject, hash);
      } else {
        const { keyId, sig } = await signWithPasskey(hash, w.passkeys);
        signature = encode1271(DEPLOYMENT.keyring, keyId, sig);
      }
      const res: SignInResponse = {
        v: 1,
        type: "cafeca:auth",
        account: subject,
        chainId: CHAIN_ID,
        message,
        signature,
        claims: granted.includes("handle") ? { handle } : {},
        state: request.state,
        ...(ch ? { channel: { id: ch.id, walletPub: ch.walletPub, expiresAt: ch.expiresAt } } : {}),
        ...(credential ? { credential } : {}),
      };
      if (ch) storeChannel(ch); // 簽署完成才保存；redirect 模式會立刻離開頁面，所以要在送出前存好
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
        這個網站想確認你是 CAFECA 身分 <span className="font-mono">{short(subject, 6)}</span> {asEntity ? "的成員" : "的擁有者"}。登入只會產生一個簽章，<strong>不會轉帳、不會授權任何代幣，網站也無法用它代替你做任何事</strong>。
      </p>

      {entities.length > 0 && (
        <div className="space-y-1.5" data-testid="signin-as">
          <div className="text-xs font-medium text-ink-3">登入身分</div>
          {[{ entity: w.address, label: "個人", sub: short(w.address, 6), disabled: false }, ...entities.map((e) => ({ entity: e.entity, label: e.displayName ?? "公司帳戶", sub: e.verified ? `統編 ${e.verified.ubn}` : "尚未驗證", disabled: false }))].map((o) => (
            <label key={o.entity} className={cx("flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm", subject.toLowerCase() === o.entity.toLowerCase() ? "border-brand bg-brand-bg" : "border-line")}>
              <input type="radio" name="signin-as" className="accent-[var(--brand)]" checked={subject.toLowerCase() === o.entity.toLowerCase()} onChange={() => setSubject(o.entity)} data-testid={`signin-as-${o.entity === w.address ? "self" : o.entity}`} />
              <span className="min-w-0 flex-1">
                {o.entity === w.address ? "以個人身分" : `以「${o.label}」身分`}
                <span className="block font-mono text-[11px] text-ink-3">{o.sub}</span>
              </span>
            </label>
          ))}
          {asEntity && <p className="text-[11px] text-ink-3">由你以公司成員的身分代公司簽署，網站看到的帳戶是公司帳戶 <span className="font-mono">{short(subject, 6)}</span>。</p>}
        </div>
      )}

      {request.statement && (
        <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm">
          <div className="mb-0.5 text-[11px] text-ink-3">網站說明</div>
          {request.statement}
        </div>
      )}

      {!!request.claims?.length && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-ink-3">網站要求提供（逐項選擇）</div>
          {request.claims.map((c) => {
            const cred = isCred(c);
            const na = (asEntity ? PERSON_ONLY : ENTITY_ONLY).includes(c);
            const value = cred && !na ? credValue(c) : null;
            const off = na || (cred && !value);
            return (
              <div key={c} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5 text-sm">
                <span className="min-w-0">
                  {CLAIM_LABEL[c]}
                  <span className="ml-2 text-xs text-ink-3" data-testid={`claim-value-${c}`}>
                    {na
                      ? asEntity ? "公司帳戶不提供" : "以公司身分登入時才有"
                      : c === "kyc_level"
                      ? asEntity ? (subjectEntity?.verified && subjectEntity.monitor?.status === "ok" ? "法人已驗證" : "法人未驗證") : chain.level >= 2 ? "L2 已實名" : chain.level === 1 ? "L1" : "未實名"
                      : c === "handle"
                        ? handle ? `@${handle}` : "尚未設定"
                        : !avail
                          ? "讀取中…"
                          : value ?? (avail.active ? "沒有資料" : "需要有效的 L2 實名")}
                  </span>
                </span>
                <Switch
                  checked={grant[c] && !off}
                  disabled={off}
                  onChange={(v) => setGrant((g) => ({ ...g, [c]: v }))}
                  label={`提供${CLAIM_LABEL[c]}`}
                  testId={`claim-${c}`}
                />
              </div>
            );
          })}
          <p className="text-[11px] text-ink-3">
            {wantsCred
              ? "實名等級由網站向鏈上查詢。姓名、證件類型、國籍與同一人識別碼預設不提供，開啟的項目會由 CAFECA 簽章後交給這個網站，只能用在這次登入；生日、證號與住址一律不提供。"
              : "實名等級由網站直接向鏈上查詢，不會提供姓名、生日或證號。"}
          </p>
        </div>
      )}

      {request.channel && asEntity && <Notice>以公司身分登入時不開啟簽章通道；需要代公司付款時，請在錢包的「公司帳戶」操作。</Notice>}
      {request.channel && !asEntity && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5 text-sm">
          <span className="min-w-0">
            <span className="font-medium">開啟簽章通道</span>
            <span className="mt-0.5 block text-xs text-ink-3">
              允許這個網站之後請你簽署訊息或付款，有效到 {new Date((request.issuedAt + (request.channel.ttl ?? 0)) * 1000).toLocaleDateString("zh-TW")}。每一次都會在這裡顯示網站的說明與實際內容，由你確認後才會簽署；隨時可以在「安全」頁關閉。
            </span>
          </span>
          <Switch checked={allowChannel} onChange={setAllowChannel} label="開啟簽章通道" testId="allow-channel" />
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
