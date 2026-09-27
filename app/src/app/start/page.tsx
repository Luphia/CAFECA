"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { concat, encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { deviceDirectoryAbi, identityAccountFactoryAbi } from "@/lib/contracts/abis";
import { api, knownIdentities, loginWithDevicePasskey, passkeySigner, publicClient, saveWallet, submitOp } from "@/lib/client";
import { ensureDeviceKey } from "@/lib/chat-crypto";
import { execCall } from "@/lib/userop";
import { registerPasskey } from "@/lib/webauthn";
import { CardFront } from "@/components/cafeca-card";
import { PasskeyIcon } from "@/components/icons";
import { CafecaMarkGradient } from "@/components/cafeca-logo";
import { useWallet } from "@/components/wallet-provider";
import { Button, Notice, Panel, Spinner, TxLink, errMsg, short, useToast } from "@/components/ui";

const noop = () => () => {};

export default function Onboarding() {
  const { wallet, hydrated, refreshSession } = useWallet();
  const router = useRouter();
  const toast = useToast();
  const known = useSyncExternalStore(noop, () => knownIdentities().length > 0, () => false);
  const [busy, setBusy] = useState<"login" | "create" | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [tx, setTx] = useState<Hex | null>(null);

  useEffect(() => {
    if (hydrated && wallet) router.replace("/wallet");
  }, [hydrated, wallet, router]);

  const log = (s: string) => setProgress((p) => [...p, s]);

  /** 此裝置已有 FIDO2 金鑰：直接用它登入 */
  const login = async () => {
    setBusy("login");
    try {
      const found = await loginWithDevicePasskey();
      if (!found) {
        toast("這把 Passkey 沒有對應的 CAFECA 身分。可以建立新身分，或到「恢復」頁找回既有身分。", "danger");
        return;
      }
      saveWallet({ address: found.address, passkeys: [found.passkey], createdAt: Date.now() });
      toast("已找到你的身分，請再用 Passkey 解鎖一次", "ok");
      router.replace("/wallet");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  /** 建立新身分：FIDO2 金鑰即身分根，地址由公鑰決定，瀏覽器直接部署身分合約 */
  const create = async () => {
    setBusy("create");
    setProgress([]);
    try {
      log("在此裝置建立 FIDO2 金鑰…");
      const pk = await registerPasskey(`CAFECA 數位身分 ${new Date().toLocaleDateString("zh-TW")}`, "此裝置");
      const address = (await publicClient.readContract({
        address: DEPLOYMENT.factory,
        abi: identityAccountFactoryAbi,
        functionName: "getAddress",
        args: [pk.qx, pk.qy],
      })) as Address;
      log(`身分地址 ${address}`);
      const initCode = concat([
        DEPLOYMENT.factory,
        encodeFunctionData({ abi: identityAccountFactoryAbi, functionName: "createAccount", args: [pk.qx, pk.qy, pk.rpIdHash] }),
      ]);
      const dev = await ensureDeviceKey();
      const callData = execCall(
        DEPLOYMENT.deviceDirectory,
        encodeFunctionData({ abi: deviceDirectoryAbi, functionName: "registerDevice", args: [dev.deviceId, dev.pub] }),
      );
      log("請用剛建立的金鑰簽署，部署身分合約（gas 由平台贊助）…");
      const res = await submitOp({ sender: address, validator: DEPLOYMENT.keyring, callData, initCode, signer: passkeySigner([pk]) });
      setTx(res.txHash);
      log("身分合約已部署 ✓");
      saveWallet({ address, passkeys: [pk], deviceId: dev.deviceId, createdAt: Date.now() });
      log("領取測試用 TWDC…");
      await api("/api/faucet", { address }).catch(() => undefined);
      toast("數位身分已建立，請再用 Passkey 解鎖一次", "ok");
      await refreshSession();
      router.replace("/wallet");
    } catch (e) {
      toast(errMsg(e), "danger");
      log("失敗：" + errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const loginBtn = (
    <Button key="login" className="w-full" variant={known ? "primary" : "secondary"} onClick={login} busy={busy === "login"} disabled={!!busy}>
      <PasskeyIcon className="size-5" /> 以此裝置的 Passkey 登入
    </Button>
  );
  const createBtn = (
    <Button key="create" className="w-full" variant={known ? "secondary" : "primary"} onClick={create} busy={busy === "create"} disabled={!!busy}>
      建立新的數位身分
    </Button>
  );

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-10 pt-10">
      <div className="mb-8">
        <Link href="/" className="inline-flex items-center gap-2">
          <CafecaMarkGradient className="size-7" />
          <span className="text-gradient text-sm font-semibold tracking-[0.3em]">CAFECA</span>
        </Link>
        <h1 className="mt-2 text-[28px] font-bold leading-tight">你的數位身分證，也是錢包</h1>
        <p className="mt-2 text-[15px] text-ink-2">
          不需要帳號密碼，也不需要第三方登入：你裝置上的 FIDO2 金鑰就是你的身分。
        </p>
      </div>

      <div className="relative mx-auto mb-8 w-full max-w-[340px]">
        <CardFront className="-rotate-3" holder="YOUR NAME" />
      </div>

      {!DEPLOYMENT.deployed && (
        <div className="mb-4">
          <Notice tone="warn">合約尚未部署到 Boltchain 測試網。請在專案目錄執行 npm run deploy。</Notice>
        </div>
      )}

      <Panel className="rise">
        <div className="space-y-3">{known ? [loginBtn, createBtn] : [createBtn, loginBtn]}</div>
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          建立身分時，裝置會以指紋或臉部辨識產生一把私鑰，私鑰不會離開裝置的安全晶片。身分地址由這把金鑰的公鑰決定；之後可以加入其他裝置一起管理，完成實名驗證後還會有平台備援金鑰，也可以購買
          CAFECA 實體卡。
        </p>

        {progress.length > 0 && (
          <div className="mt-4 space-y-1 rounded-xl bg-surface-2 p-3 text-xs text-ink-2">
            {progress.map((p, i) => (
              <div key={i}>{p.startsWith("身分地址 ") ? `身分地址 ${short(p.slice(5), 6)}` : p}</div>
            ))}
            {busy === "create" && <Spinner className="mt-1 text-brand" />}
            {tx && <div>交易：<TxLink hash={tx} /></div>}
          </div>
        )}
      </Panel>

      <div className="mt-4 space-y-2 text-center text-sm">
        <Link href="/link" className="block text-ink-2 hover:text-brand">已經有身分？連結既有身份</Link>
        <Link href="/recover" className="block text-ink-2 hover:text-brand">裝置都不見了？恢復身分</Link>
        <Link href="/" className="block text-xs text-ink-3 hover:text-brand">什麼是數位身分證？</Link>
      </div>
    </div>
  );
}
