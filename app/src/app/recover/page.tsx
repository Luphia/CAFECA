"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT, RecoveryPath } from "@/lib/config";
import { keyringValidatorAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api, publicClient, saveWallet, submitOp } from "@/lib/client";
import { getCard } from "@/lib/card-sim";
import { encodeKeyringSignature, execCall, type TxSummary } from "@/lib/userop";
import { registerPasskey, type PasskeyInfo } from "@/lib/webauthn";
import { IdentityLogin } from "@/components/identity-login";
import { useCardConfirm } from "@/components/card-provider";
import { Badge, Button, Field, inputCls, Notice, Panel, TxLink, errMsg, short, useToast } from "@/components/ui";

type Found = { address: Address; idCommitment: Hex; email: string | null; provider: string; deployed: boolean };
type PendingLocal = { address: Address; passkey: PasskeyInfo; found: Found };
const PK = "cafeca.recovery.pending.v1";

export default function RecoverPage() {
  return (
    <Suspense>
      <Recover />
    </Suspense>
  );
}

function Recover() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const confirmOnCard = useCardConfirm();
  const [found, setFound] = useState<Found | null>(null);
  const [discoverToken, setDiscoverToken] = useState<string | null>(null);
  const [info, setInfo] = useState<{ master: boolean; level: number; pending: { path: number; readyAt: number } | null; hasCard: boolean } | null>(null);
  const [pk, setPk] = useState<PasskeyInfo | null>(null);
  const [path, setPath] = useState<number | null>(null);
  const [idNumber, setIdNumber] = useState("");
  const [nonce, setNonce] = useState<{ value: string; expiry: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ tx: Hex; immediate: boolean } | null>(null);
  const [local, setLocal] = useState<PendingLocal | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PK);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setLocal(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const loadInfo = useCallback(async (address: Address) => {
    const [st, level, pending, card] = await Promise.all([
      publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "accountState", args: [address] }),
      publicClient.readContract({ address: DEPLOYMENT.attestation, abi: [{ type: "function", name: "levelOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint8" }] }] as const, functionName: "levelOf", args: [address] }),
      publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [address] }),
      getCard(),
    ]);
    setInfo({
      master: st[1] > 0,
      level,
      pending: pending[0] !== RecoveryPath.NONE ? { path: pending[0], readyAt: Number(pending[1]) } : null,
      hasCard: !!card,
    });
  }, []);

  const onDiscover = async (idToken: string) => {
    setBusy(true);
    try {
      const d = await api<Found>("/api/oidc/discover", { idToken });
      if (!d.deployed) throw new Error("這個帳號沒有錢包");
      const wanted = params.get("address");
      if (wanted && wanted.toLowerCase() !== d.address.toLowerCase()) toast("注意：登入的帳號與連結中的錢包不同", "danger");
      setFound(d);
      setDiscoverToken(idToken);
      await loadInfo(d.address);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const createKey = async () => {
    setBusy(true);
    try {
      setPk(await registerPasskey(`cafeca-recover-${Date.now().toString(36)}`, "恢復的新裝置"));
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const choose = async (p: number) => {
    if (!found || !pk) return;
    setPath(p);
    const [, n] = await publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "state", args: [found.address] });
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const v = await publicClient.readContract({
      address: DEPLOYMENT.recovery,
      abi: recoveryValidatorAbi,
      functionName: "recoveryNonce",
      args: [found.address, pk.qx, pk.qy, pk.rpIdHash, n, BigInt(expiry)],
    });
    setNonce({ value: "0x" + v.toString(16), expiry });
  };

  const onRecoverToken = async (idToken: string) => {
    if (!found || !pk || !nonce || path === null) return;
    setBusy(true);
    try {
      const { oidc } = await api<{ oidc: { idCommitment: Hex; jwksKeyHash: Hex; expiry: number; proof: Hex } }>("/api/oidc/recover", {
        idToken,
        account: found.address,
        qx: pk.qx,
        qy: pk.qy,
        rpIdHash: pk.rpIdHash,
        expiry: nonce.expiry,
      });
      let kycSig: Hex = "0x";
      if (path === RecoveryPath.R2_REKYC) {
        kycSig = (await api<{ kycSig: Hex }>("/api/kyc/rekyc", {
          idToken: discoverToken,
          account: found.address,
          qx: pk.qx,
          qy: pk.qy,
          rpIdHash: pk.rpIdHash,
          idNumber,
        })).kycSig;
      }
      const req = {
        path,
        qx: pk.qx,
        qy: pk.qy,
        rpIdHash: pk.rpIdHash,
        oidc: { idCommitment: oidc.idCommitment, jwksKeyHash: oidc.jwksKeyHash, expiry: BigInt(oidc.expiry), proof: oidc.proof },
        kycSig,
      };
      const callData = execCall(DEPLOYMENT.recovery, encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "initiateRecovery", args: [req] }));

      const res = await submitOp({
        sender: found.address,
        validator: DEPLOYMENT.recovery,
        callData,
        signer: async (hash) => {
          if (path !== RecoveryPath.R1_CARD) return "0x";
          const s = await publicClient.readContract({
            address: DEPLOYMENT.recovery,
            abi: recoveryValidatorAbi,
            functionName: "recoverySummary",
            args: [found.address, pk.qx, pk.qy],
          });
          const { keyId, sig } = await confirmOnCard({ summaries: [s as TxSummary], challenge: hash, title: "以卡片確認恢復" });
          return encodeKeyringSignature(keyId, sig);
        },
      });

      if (path === RecoveryPath.R1_CARD) {
        saveWallet({ address: found.address, idCommitment: found.idCommitment, provider: found.provider, email: found.email, passkeys: [pk], createdAt: Date.now() });
        setDone({ tx: res.txHash, immediate: true });
      } else {
        const rec: PendingLocal = { address: found.address, passkey: pk, found };
        localStorage.setItem(PK, JSON.stringify(rec));
        setLocal(rec);
        setDone({ tx: res.txHash, immediate: false });
        await loadInfo(found.address);
      }
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const execute = async (rec: PendingLocal) => {
    setBusy(true);
    try {
      const callData = execCall(DEPLOYMENT.recovery, encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "executeRecovery", args: [rec.address] }));
      const res = await submitOp({ sender: rec.address, validator: DEPLOYMENT.recovery, callData, signer: async () => "0x" });
      saveWallet({ address: rec.address, idCommitment: rec.found.idCommitment, provider: rec.found.provider, email: rec.found.email, passkeys: [rec.passkey], createdAt: Date.now() });
      localStorage.removeItem(PK);
      toast(<span>恢復完成 <TxLink hash={res.txHash} /></span>, "ok");
      router.replace("/wallet");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const [now] = useState(() => Math.floor(Date.now() / 1000));

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-8">
      <div>
        <Link href="/" className="text-sm text-brand">← 首頁</Link>
        <h1 className="mt-3 text-2xl font-bold">恢復錢包</h1>
        <p className="mt-1 text-sm text-ink-2">以開戶時的 Google／Apple 帳號證明身分，再依你手上還有什麼，選擇恢復方式。</p>
      </div>

      {local && !done && (
        <Panel title="進行中的恢復" action={<Badge tone="warn">等待時間鎖</Badge>}>
          <p className="mb-3 text-sm text-ink-2">錢包 {short(local.address)} 的恢復請求已送出。時間鎖到期後，按下執行即可用這台裝置的新 Passkey 操作。</p>
          <Button className="w-full" onClick={() => execute(local)} busy={busy}>執行恢復</Button>
          <p className="mt-2 text-xs text-ink-3">若時間未到，交易會被拒絕（AA22）。</p>
        </Panel>
      )}

      {done && (
        <Panel title={done.immediate ? "恢復完成" : "恢復請求已送出"}>
          <p className="mb-3 text-sm text-ink-2">
            {done.immediate
              ? "卡片已確認，新裝置的 Passkey 已加入錢包。"
              : "時間鎖期間錢包轉出凍結，原裝置可以取消。到期後回到本頁執行恢復。"}
          </p>
          <TxLink hash={done.tx} />
          {done.immediate && <Button className="mt-3 w-full" onClick={() => router.replace("/wallet")}>前往錢包</Button>}
        </Panel>
      )}

      {!found && !done && (
        <Panel title="步驟 1：證明你是誰">
          <IdentityLogin onToken={onDiscover} disabled={busy} />
        </Panel>
      )}

      {found && info && !done && (
        <>
          <Panel title="找到你的錢包">
            <div className="text-sm">
              <div className="font-mono text-xs">{found.address}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {info.master ? <Badge tone="brand">主金鑰模式</Badge> : <Badge>標準模式</Badge>}
                {info.level >= 2 && <Badge tone="ok">L2</Badge>}
                {info.hasCard && <Badge tone="brand">此瀏覽器有卡片</Badge>}
              </div>
            </div>
            {info.pending && (
              <div className="mt-3">
                <Notice tone="warn">已有進行中的恢復，{new Date(info.pending.readyAt * 1000).toLocaleString("zh-TW")} {info.pending.readyAt <= now ? "已可執行" : "後可執行"}。</Notice>
              </div>
            )}
          </Panel>

          {!info.pending && (
            <Panel title="步驟 2：在這台裝置建立新 Passkey">
              {pk ? <Notice tone="ok">已建立 {pk.keyId.slice(0, 14)}…</Notice> : <Button className="w-full" onClick={createKey} busy={busy}>建立 Passkey</Button>}
            </Panel>
          )}

          {pk && !info.pending && (
            <Panel title="步驟 3：選擇恢復方式">
              <div className="space-y-2">
                <PathOption
                  active={path === RecoveryPath.R1_CARD}
                  disabled={!info.master || !info.hasCard}
                  title="CAFECA 卡＋登入：立即恢復"
                  desc={!info.master ? "需先綁定卡片" : !info.hasCard ? "卡片（模擬器）不在此瀏覽器" : "卡片螢幕會顯示新裝置的金鑰指紋"}
                  onClick={() => choose(RecoveryPath.R1_CARD)}
                />
                <PathOption
                  active={path === RecoveryPath.R2_REKYC}
                  disabled={info.level < 2}
                  title="重新實名驗證：48 小時"
                  desc={info.level < 2 ? "需有 L2 實名紀錄" : "手機與卡片都遺失時使用，會清除舊金鑰"}
                  onClick={() => choose(RecoveryPath.R2_REKYC)}
                />
                <PathOption
                  active={path === RecoveryPath.R3_OIDC_ONLY}
                  disabled={info.master}
                  title="只用登入：7 天"
                  desc={info.master ? "主金鑰模式下停用，避免 Google 帳號被盜即可接管" : "期間轉出凍結，原裝置可取消"}
                  onClick={() => choose(RecoveryPath.R3_OIDC_ONLY)}
                />
              </div>
              {path === RecoveryPath.R2_REKYC && (
                <div className="mt-3">
                  <Field label="身分證字號（模擬重新 KYC）">
                    <input className={inputCls} value={idNumber} onChange={(e) => setIdNumber(e.target.value.toUpperCase())} placeholder="A123456789" />
                  </Field>
                </div>
              )}
            </Panel>
          )}

          {pk && nonce && path !== null && (
            <Panel title="步驟 4：再次登入以簽署恢復請求">
              <p className="mb-3 text-sm text-ink-2">這次登入的 nonce 綁定「新 Passkey＋恢復序號」，只能用於這一次恢復。</p>
              <IdentityLogin nonce={nonce.value} onToken={onRecoverToken} disabled={busy || (path === RecoveryPath.R2_REKYC && !idNumber)} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

function PathOption({ title, desc, disabled, active, onClick }: { title: string; desc: string; disabled?: boolean; active?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full rounded-xl border p-3 text-left transition disabled:opacity-40 ${active ? "border-brand bg-brand-bg" : "border-line hover:bg-surface-2"}`}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-xs text-ink-2">{desc}</div>
    </button>
  );
}
