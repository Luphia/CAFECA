"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { encodeFunctionData, getAddress, hexToBytes, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi, keyringValidatorAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api, cardSigner, publicClient, saveWallet, submitOp } from "@/lib/client";
import { getCard } from "@/lib/card-sim";
import { execCall } from "@/lib/userop";
import { registerPasskey, type PasskeyInfo } from "@/lib/webauthn";
import { useCardConfirm } from "@/components/card-provider";
import { KycCapture, postKyc, type KycEvidence } from "@/components/kyc-capture";
import { Badge, Button, Field, inputCls, Notice, Panel, TxLink, errMsg, short, useToast } from "@/components/ui";
import { AddressInput } from "@/components/address-input";

type Info = { master: boolean; level: number; guardian: boolean; pending: { readyAt: number } | null; hasCard: boolean };
type PendingLocal = { address: Address; passkey: PasskeyInfo };
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
  const [query, setQuery] = useState(params.get("address") ?? "");
  const [address, setAddress] = useState<Address | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [pk, setPk] = useState<PasskeyInfo | null>(null);
  const [idNumber, setIdNumber] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ tx: Hex; immediate: boolean; readyAt?: number } | null>(null);
  const [ev, setEv] = useState<KycEvidence | null>(null);
  const onEvidence = useCallback((e: KycEvidence | null) => setEv(e), []);
  const [local, setLocal] = useState<PendingLocal | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PK);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setLocal(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const loadInfo = useCallback(async (a: Address) => {
    setNow(Math.floor(Date.now() / 1000));
    const [st, level, pending, guardian, card] = await Promise.all([
      publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "accountState", args: [a] }),
      publicClient.readContract({ address: DEPLOYMENT.attestation, abi: attestationRegistryAbi, functionName: "levelOf", args: [a] }),
      publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [a] }),
      publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "guardianOf", args: [a] }),
      getCard(),
    ]);
    if (!st[2]) throw new Error("這個地址不是 CAFECA 數位身分");
    setInfo({ master: st[1] > 0, level, guardian: guardian !== zeroAddress, pending: pending[0] ? { readyAt: Number(pending[2]) } : null, hasCard: !!card });
  }, []);

  const find = async () => {
    setBusy("find");
    try {
      const q = query.trim();
      const a = isAddress(q) ? getAddress(q) : (await api<{ address: Address }>(`/api/profile?q=${encodeURIComponent(q)}`)).address;
      await loadInfo(a);
      setAddress(a);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const createKey = async () => {
    if (!address) return;
    setBusy("key");
    try {
      // userHandle 存身分地址：日後在這台裝置可直接以 Passkey 登入
      setPk(await registerPasskey(`CAFECA ${short(address)}`, "恢復的新裝置", hexToBytes(address)));
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  /** 還有 CAFECA 實體卡：由卡片簽署，直接把此裝置加回身分 */
  const recoverWithCard = async () => {
    if (!address || !pk) return;
    setBusy("card");
    try {
      const callData = execCall(
        DEPLOYMENT.keyring,
        encodeFunctionData({ abi: keyringValidatorAbi, functionName: "addDailyKey", args: [pk.qx, pk.qy, pk.rpIdHash] }),
      );
      const signer = await cardSigner(address, callData, confirmOnCard);
      const res = await submitOp({ sender: address, validator: DEPLOYMENT.keyring, callData, signer });
      saveWallet({ address, passkeys: [pk], createdAt: Date.now() });
      setDone({ tx: res.txHash, immediate: true });
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  /** 裝置與卡片都遺失：重新拍證件、錄臉部影像，平台備援金鑰發起恢復（48 小時；已綁卡 7 天） */
  const recoverWithGuardian = async () => {
    if (!address || !pk || !ev) return;
    setBusy("kyc");
    try {
      const r = await postKyc<{ txHash: Hex; readyAt: number }>("/api/recovery/guardian", ev, {
        account: address,
        qx: pk.qx,
        qy: pk.qy,
        rpIdHash: pk.rpIdHash,
        idNumber,
      });
      const rec: PendingLocal = { address, passkey: pk };
      localStorage.setItem(PK, JSON.stringify(rec));
      setLocal(rec);
      setDone({ tx: r.txHash, immediate: false, readyAt: r.readyAt });
      await loadInfo(address);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const execute = async (rec: PendingLocal) => {
    setBusy("exec");
    try {
      const callData = execCall(
        DEPLOYMENT.recovery,
        encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "executeRecovery", args: [rec.address] }),
      );
      const res = await submitOp({ sender: rec.address, validator: DEPLOYMENT.recovery, callData, signer: async () => "0x" });
      saveWallet({ address: rec.address, passkeys: [rec.passkey], createdAt: Date.now() });
      localStorage.removeItem(PK);
      toast(<span>恢復完成 <TxLink hash={res.txHash} /></span>, "ok");
      router.replace("/wallet");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-8">
      <div>
        <Link href="/start" className="text-sm text-brand">← 返回</Link>
        <h1 className="mt-3 text-2xl font-bold">恢復數位身分</h1>
        <p className="mt-1 text-sm text-ink-2">
          如果你的 Passkey 有透過 iCloud 鑰匙圈或 Google 密碼管理工具同步，直接「以此裝置的 Passkey 登入」即可；還有其他已登入的裝置，請用「連結既有身分」。以下適用於手邊沒有任何可用裝置的情況。
        </p>
      </div>

      {local && !done && (
        <Panel title="進行中的恢復" action={<Badge tone="warn">等待時間鎖</Badge>}>
          <p className="mb-3 text-sm text-ink-2">身分 {short(local.address)} 的恢復請求已送出。時間鎖到期（48 小時；已綁卡 7 天）後按下執行，即可用這台裝置的新金鑰操作。</p>
          <Button className="w-full" onClick={() => execute(local)} busy={busy === "exec"}>執行恢復</Button>
          <p className="mt-2 text-xs text-ink-3">時間未到時交易會被拒絕（AA22）。</p>
        </Panel>
      )}

      {done && (
        <Panel title={done.immediate ? "恢復完成" : "恢復請求已送出"}>
          <p className="mb-3 text-sm text-ink-2">
            {done.immediate
              ? "卡片已確認，這台裝置的新金鑰已加入你的身分。"
              : `平台備援金鑰已發起恢復，${done.readyAt ? new Date(done.readyAt * 1000).toLocaleString("zh-TW") : "時間鎖到期"} 後可執行。期間轉出凍結，你舊有的任何裝置或實體卡都能取消。到期後回到本頁執行恢復，舊的裝置金鑰會被清除（實體卡保留）。`}
          </p>
          <TxLink hash={done.tx} />
          {done.immediate && <Button className="mt-3 w-full" onClick={() => router.replace("/wallet")}>前往錢包</Button>}
        </Panel>
      )}

      {!done && (
        <Panel title="步驟 1：找到你的身分">
          <div className="flex gap-2">
            <AddressInput value={query} onChange={setQuery} placeholder="身分地址 0x… 或 @代稱" />
            <Button variant="secondary" onClick={find} busy={busy === "find"} disabled={!query.trim()}>查詢</Button>
          </div>
          {address && info && (
            <div className="mt-3 text-sm">
              <div className="font-mono text-xs">{address}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {info.master ? <Badge tone="brand">已綁定 CAFECA 卡</Badge> : <Badge>未綁卡</Badge>}
                {info.level >= 2 ? <Badge tone="ok">L2 實名</Badge> : <Badge>L0</Badge>}
                {info.guardian ? <Badge tone="brand">平台備援已啟用</Badge> : <Badge>無平台備援</Badge>}
                {info.hasCard && <Badge tone="brand">此瀏覽器有卡片</Badge>}
              </div>
              {info.pending && (
                <div className="mt-3">
                  <Notice tone="warn">
                    已有進行中的恢復，{new Date(info.pending.readyAt * 1000).toLocaleString("zh-TW")} {info.pending.readyAt <= now ? "已可執行" : "後可執行"}。
                  </Notice>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

      {address && info && !info.pending && !done && (
        <Panel title="步驟 2：在這台裝置建立新的 FIDO2 金鑰">
          {pk ? <Notice tone="ok">已建立 {pk.keyId.slice(0, 14)}…</Notice> : <Button className="w-full" onClick={createKey} busy={busy === "key"}>建立金鑰</Button>}
        </Panel>
      )}

      {address && info && pk && !info.pending && !done && (
        <Panel title="步驟 3：證明這是你的身分">
          <div className="space-y-4">
            <div className="rounded-xl border border-line p-3">
              <div className="text-sm font-medium">用 CAFECA 實體卡新增此裝置（立即）</div>
              <div className="mt-0.5 text-xs text-ink-2">
                {!info.master ? "此身分尚未綁定卡片" : !info.hasCard ? "卡片（模擬器）不在此瀏覽器；實體卡以 NFC 感應即可" : "卡片螢幕會顯示新裝置的金鑰指紋"}
              </div>
              <Button className="mt-2 w-full" onClick={recoverWithCard} busy={busy === "card"} disabled={!info.master || !info.hasCard}>
                以卡片確認
              </Button>
            </div>

            <div className="rounded-xl border border-line p-3">
              <div className="text-sm font-medium">平台備援金鑰：重新驗證本人（{info.master ? "7 天" : "48 小時"}）</div>
              <div className="mt-0.5 text-xs text-ink-2">
                {!info.guardian
                  ? "此身分沒有完成實名驗證，平台沒有備援金鑰可以協助"
                  : "裝置與卡片都不在身邊時使用：重新拍證件、錄臉部影像，與開戶時的 KYC 紀錄比對"}
              </div>
              {info.guardian && (
                <div className="mt-3 space-y-3">
                  <Field label="身分證字號">
                    <input className={inputCls} value={idNumber} onChange={(e) => setIdNumber(e.target.value.toUpperCase())} placeholder="A123456789" />
                  </Field>
                  <KycCapture onChange={onEvidence} />
                </div>
              )}
              <Button className="mt-3 w-full" variant="secondary" onClick={recoverWithGuardian} busy={busy === "kyc"} disabled={!info.guardian || !idNumber || !ev}>
                送出重新驗證
              </Button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
