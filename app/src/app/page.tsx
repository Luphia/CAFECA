"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENT } from "@/lib/config";
import { deviceDirectoryAbi, identityAccountFactoryAbi } from "@/lib/contracts/abis";
import { api, passkeySigner, publicClient, recoverPasskeyForAccount, saveWallet, submitOp } from "@/lib/client";
import { ensureDeviceKey } from "@/lib/chat-crypto";
import { execCall } from "@/lib/userop";
import { registerPasskey } from "@/lib/webauthn";
import { CardFront } from "@/components/cafeca-card";
import { IdentityLogin } from "@/components/identity-login";
import { useWallet } from "@/components/wallet-provider";
import { Button, Notice, Panel, Spinner, TxLink, errMsg, short, useToast } from "@/components/ui";

/** 登入前產生的一次性金鑰：OIDC nonce 綁定它，登入後由它授權「此身分綁定此 passkey」 */
type Ephemeral = { pk: Hex; address: Address; expiry: number; nonce: string };

type Identity = {
  idToken: string;
  provider: string;
  email: string | null;
  idCommitment: Hex;
  address: Address;
  deployed: boolean;
};

export default function Onboarding() {
  const { wallet, hydrated, refreshSession } = useWallet();
  const router = useRouter();
  const toast = useToast();
  const [eph, setEph] = useState<Ephemeral | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<Hex | null>(null);

  useEffect(() => {
    if (hydrated && wallet) router.replace("/wallet");
  }, [hydrated, wallet, router]);

  // 1. 產生 ephemeral 金鑰並算出登入 nonce（只存在記憶體，離開頁面即丟棄）
  useEffect(() => {
    if (!DEPLOYMENT.deployed) return;
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    publicClient
      .readContract({ address: DEPLOYMENT.factory, abi: identityAccountFactoryAbi, functionName: "bindNonce", args: [address, BigInt(expiry)] })
      .then((n) => setEph({ pk, address, expiry, nonce: "0x" + n.toString(16) }))
      .catch((e) => toast("無法連線到 Boltchain：" + errMsg(e), "danger"));
  }, [toast]);

  const log = (s: string) => setProgress((p) => [...p, s]);

  // 2. 以 Google／Apple 建立身分
  const onToken = async (idToken: string) => {
    setBusy(true);
    try {
      const d = await api<Omit<Identity, "idToken">>("/api/oidc/discover", { idToken });
      setIdentity({ ...d, idToken });
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  // 3a. 新身分：在此裝置建立 FIDO2 金鑰，ephemeral 授權綁定，部署身分合約
  const createKeyAndAccount = async () => {
    if (!identity || !eph) return;
    setBusy(true);
    setProgress([]);
    try {
      log("在此裝置建立 FIDO2 金鑰（Passkey）…");
      const pk = await registerPasskey(identity.email ?? `cafeca-${Date.now().toString(36)}`, "此裝置");
      const digest = await publicClient.readContract({
        address: DEPLOYMENT.factory,
        abi: identityAccountFactoryAbi,
        functionName: "bindAuthorizationDigest",
        args: [identity.idCommitment, pk.qx, pk.qy, pk.rpIdHash],
      });
      const ephemeralSig = await privateKeyToAccount(eph.pk).sign({ hash: digest });
      log("產生身分綁定證明…");
      const bind = await api<{ address: Address; initCode: Hex }>("/api/oidc/bind", {
        idToken: identity.idToken,
        ephemeral: eph.address,
        expiry: eph.expiry,
        qx: pk.qx,
        qy: pk.qy,
        rpIdHash: pk.rpIdHash,
        ephemeralSig,
      });
      const dev = await ensureDeviceKey();
      const callData = execCall(
        DEPLOYMENT.deviceDirectory,
        encodeFunctionData({ abi: deviceDirectoryAbi, functionName: "registerDevice", args: [dev.deviceId, dev.pub] }),
      );
      log("請用剛建立的 Passkey 簽署，部署身分合約（gas 由平台贊助）…");
      const res = await submitOp({
        sender: bind.address,
        validator: DEPLOYMENT.keyring,
        callData,
        initCode: bind.initCode,
        signer: passkeySigner([pk]),
      });
      setTx(res.txHash);
      log("身分合約已部署 ✓");
      saveWallet({
        address: bind.address,
        idCommitment: identity.idCommitment,
        provider: identity.provider,
        email: identity.email,
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

  // 3b. 既有身分：用此裝置已註冊的 Passkey 登入
  const loginWithPasskey = async () => {
    if (!identity) return;
    setBusy(true);
    try {
      const found = await recoverPasskeyForAccount(identity.address);
      if (!found) {
        toast("此裝置沒有這個錢包的 Passkey，請使用恢復流程", "danger");
        router.push(`/recover?address=${identity.address}`);
        return;
      }
      saveWallet({
        address: identity.address,
        idCommitment: identity.idCommitment,
        provider: identity.provider,
        email: identity.email,
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
        <p className="mt-2 text-[15px] text-ink-2">先以 Google／Apple 建立身分，再於裝置上建立 FIDO2 金鑰操作身分合約。</p>
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
        <ol className="space-y-6">
          <li>
            <Step n={1} done={!!identity} title="以 Google／Apple 建立身分" desc="你的身分承諾與錢包地址由登入帳號決定；鏈上不會出現 email。" />
            {!identity && (
              <div className="mt-3">
                {eph ? <IdentityLogin nonce={eph.nonce} onToken={onToken} disabled={busy} /> : DEPLOYMENT.deployed && <Spinner className="text-brand" />}
              </div>
            )}
            {identity && (
              <div className="mt-2 rounded-xl bg-surface-2 p-3 text-sm">
                <div className="font-medium">{identity.email ?? "已驗證"}</div>
                <div className="font-mono text-xs text-ink-3">錢包地址 {short(identity.address, 6)}</div>
              </div>
            )}
          </li>

          <li>
            <Step
              n={2}
              done={!!tx}
              title={identity?.deployed ? "用此裝置的 FIDO2 金鑰登入" : "在此裝置建立 FIDO2 金鑰"}
              desc={
                identity?.deployed
                  ? "這個身分已經有錢包，請用先前在此裝置註冊的 Passkey 確認。"
                  : "私鑰留在裝置的安全晶片；它將成為操作你身分合約的第一把金鑰。"
              }
            />
            {identity && !identity.deployed && !tx && (
              <Button className="mt-3 w-full" onClick={createKeyAndAccount} busy={busy}>
                建立 FIDO2 金鑰並開通錢包
              </Button>
            )}
            {identity?.deployed && (
              <div className="mt-3 space-y-2">
                <Button className="w-full" onClick={loginWithPasskey} busy={busy}>以 Passkey 登入</Button>
                <Link href={`/recover?address=${identity.address}`} className="block text-center text-sm text-ink-2 hover:text-brand">
                  此裝置沒有 Passkey？恢復錢包
                </Link>
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
        {identity && !tx && (
          <button className="mt-4 text-sm text-ink-3" onClick={() => setIdentity(null)} disabled={busy}>
            換一個帳號
          </button>
        )}
      </Panel>

      <Link href="/recover" className="mt-4 block text-center text-sm text-ink-2 hover:text-brand">遺失裝置？恢復錢包</Link>
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
