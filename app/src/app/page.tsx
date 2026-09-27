"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { deviceDirectoryAbi, identityAccountFactoryAbi } from "@/lib/contracts/abis";
import { api, passkeySigner, publicClient, recoverPasskeyForAccount, saveWallet, submitOp } from "@/lib/client";
import { ensureDeviceKey } from "@/lib/chat-crypto";
import { execCall } from "@/lib/userop";
import { registerPasskey, type PasskeyInfo } from "@/lib/webauthn";
import { CardFront } from "@/components/cafeca-card";
import { IdentityLogin } from "@/components/identity-login";
import { useWallet } from "@/components/wallet-provider";
import { Button, Notice, Panel, Spinner, TxLink, errMsg, useToast } from "@/components/ui";

type Mode = "welcome" | "create" | "login";

export default function Onboarding() {
  const { wallet, hydrated, refreshSession } = useWallet();
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("welcome");

  // 建立流程狀態
  const [pk, setPk] = useState<PasskeyInfo | null>(null);
  const [nonce, setNonce] = useState<{ value: string; expiry: number } | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<Hex | null>(null);

  useEffect(() => {
    if (hydrated && wallet) router.replace("/wallet");
  }, [hydrated, wallet, router]);

  const log = (s: string) => setProgress((p) => [...p, s]);

  // 1. 建立 passkey，並算出綁定這把公鑰的 OIDC nonce
  const createPasskey = async () => {
    setBusy(true);
    try {
      const info = await registerPasskey(`cafeca-${Date.now().toString(36)}`, "此裝置");
      setPk(info);
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const n = await publicClient.readContract({
        address: DEPLOYMENT.factory,
        abi: identityAccountFactoryAbi,
        functionName: "bindNonce",
        args: [info.qx, info.qy, info.rpIdHash, BigInt(expiry)],
      });
      setNonce({ value: "0x" + n.toString(16), expiry });
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  // 2. 登入 Google／Apple（nonce 綁定 passkey）→ 3. 部署帳戶＋登記聊天裝置（同一筆 UserOp）
  const onBindToken = async (idToken: string) => {
    if (!pk || !nonce) return;
    setBusy(true);
    setProgress([]);
    try {
      log("驗證身分並產生綁定證明…");
      const bind = await api<{ address: Address; idCommitment: Hex; email: string | null; provider: string; initCode: Hex }>(
        "/api/oidc/bind",
        { idToken, qx: pk.qx, qy: pk.qy, rpIdHash: pk.rpIdHash, expiry: nonce.expiry },
      );
      log(`帳戶地址 ${bind.address}`);
      const dev = await ensureDeviceKey();
      const callData = execCall(
        DEPLOYMENT.deviceDirectory,
        encodeFunctionData({ abi: deviceDirectoryAbi, functionName: "registerDevice", args: [dev.deviceId, dev.pub] }),
      );
      log("請用 Passkey 簽署開戶交易（gas 由平台贊助）…");
      const res = await submitOp({
        sender: bind.address,
        validator: DEPLOYMENT.keyring,
        callData,
        initCode: bind.initCode,
        signer: passkeySigner([pk]),
      });
      setTx(res.txHash);
      log("開戶完成 ✓");
      saveWallet({
        address: bind.address,
        idCommitment: bind.idCommitment,
        provider: bind.provider,
        email: bind.email,
        passkeys: [pk],
        deviceId: dev.deviceId,
        createdAt: Date.now(),
      });
      log("領取測試用 TWDC…");
      await api("/api/faucet", { address: bind.address }).catch(() => undefined);
      toast("錢包已建立，請再用 Passkey 解鎖一次", "ok");
      await refreshSession();
      router.replace("/wallet");
    } catch (e) {
      toast(errMsg(e), "danger");
      log("失敗：" + errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // 登入既有帳戶：先由 id_token 找到帳戶，再用此裝置的 passkey 比對鏈上金鑰
  const onLoginToken = async (idToken: string) => {
    setBusy(true);
    try {
      const d = await api<{ address: Address; deployed: boolean; idCommitment: Hex; email: string | null; provider: string }>(
        "/api/oidc/discover",
        { idToken },
      );
      if (!d.deployed) {
        toast("這個帳號還沒有錢包，請先建立", "danger");
        setMode("create");
        return;
      }
      const found = await recoverPasskeyForAccount(d.address);
      if (!found) {
        toast("此裝置沒有這個錢包的 Passkey，請使用恢復流程", "danger");
        router.push(`/recover?address=${d.address}`);
        return;
      }
      saveWallet({
        address: d.address,
        idCommitment: d.idCommitment,
        provider: d.provider,
        email: d.email,
        passkeys: [found],
        createdAt: Date.now(),
      });
      router.replace("/wallet");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-10">
      <div className="mb-8">
        <div className="text-gradient text-sm font-semibold tracking-[0.3em]">CAFECA</div>
        <h1 className="mt-2 text-[28px] font-bold leading-tight">你的數位身分證，也是錢包</h1>
        <p className="mt-2 text-[15px] text-ink-2">Google／Apple 登入開戶，Passkey 與 CAFECA 卡操作。聊天、支付、AI 子錢包都在這裡。</p>
      </div>

      <div className="relative mx-auto mb-8 w-full max-w-[340px]">
        <CardFront className="-rotate-3" holder="YOUR NAME" />
      </div>

      {!DEPLOYMENT.deployed && (
        <div className="mb-4">
          <Notice tone="warn">合約尚未部署到 Boltchain 測試網。請在專案目錄執行 npm run deploy。</Notice>
        </div>
      )}

      {mode === "welcome" && (
        <div className="space-y-3">
          <Button className="w-full" onClick={() => setMode("create")}>建立新錢包</Button>
          <Button className="w-full" variant="secondary" onClick={() => setMode("login")}>我已經有錢包</Button>
          <Link href="/recover" className="block pt-2 text-center text-sm text-ink-2 hover:text-brand">遺失裝置？恢復錢包</Link>
        </div>
      )}

      {mode === "create" && (
        <Panel title="建立新錢包" className="rise">
          <ol className="space-y-5">
            <li>
              <Step n={1} done={!!pk} title="在此裝置建立 Passkey" desc="私鑰留在裝置的安全晶片，之後用指紋或臉部辨識簽署交易。" />
              {!pk && (
                <Button className="mt-3 w-full" onClick={createPasskey} busy={busy}>建立 Passkey</Button>
              )}
            </li>
            <li>
              <Step n={2} done={!!tx} title="以 Google／Apple 驗證身分" desc="登入的 nonce 綁定剛才的 Passkey 公鑰，被攔截的登入憑證也無法拿去綁別的裝置。" />
              {pk && nonce && !tx && (
                <div className="mt-3">
                  <IdentityLogin nonce={nonce.value} onToken={onBindToken} disabled={busy} />
                </div>
              )}
            </li>
          </ol>
          {progress.length > 0 && (
            <div className="mt-5 space-y-1 rounded-xl bg-surface-2 p-3 text-xs text-ink-2">
              {progress.map((p, i) => (
                <div key={i}>{p}</div>
              ))}
              {busy && <Spinner className="mt-1 text-brand" />}
              {tx && <div>交易：<TxLink hash={tx} /></div>}
            </div>
          )}
          <button className="mt-4 text-sm text-ink-3" onClick={() => setMode("welcome")}>返回</button>
        </Panel>
      )}

      {mode === "login" && (
        <Panel title="登入既有錢包" className="rise">
          <p className="mb-4 text-sm text-ink-2">用開戶時的 Google／Apple 帳號登入，接著用此裝置的 Passkey 確認。</p>
          <IdentityLogin onToken={onLoginToken} disabled={busy} />
          {busy && <Spinner className="mt-3 text-brand" />}
          <button className="mt-4 text-sm text-ink-3" onClick={() => setMode("welcome")}>返回</button>
        </Panel>
      )}
    </div>
  );
}

function Step({ n, title, desc, done }: { n: number; title: string; desc: string; done: boolean }) {
  return (
    <div className="flex gap-3">
      <div className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${done ? "bg-ok text-white" : "bg-brand-bg text-brand"}`}>
        {done ? "✓" : n}
      </div>
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-sm text-ink-2">{desc}</div>
      </div>
    </div>
  );
}
