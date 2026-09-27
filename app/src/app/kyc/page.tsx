"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api } from "@/lib/client";
import { runOp } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { KycCapture, postKyc, type KycEvidence } from "@/components/kyc-capture";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, Notice, Panel, TxLink, errMsg, short, useToast } from "@/components/ui";

type Guardian = { address: Address; authoritySig: Hex };

export default function KycPage() {
  return (
    <AppShell title="實名驗證">
      <KycBody />
    </AppShell>
  );
}

function KycBody() {
  const { wallet, chain, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const w = wallet!;
  const [ev, setEv] = useState<KycEvidence | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ kycTx: Hex; guardianTx?: Hex } | null>(null);
  const onEvidence = useCallback((e: KycEvidence | null) => setEv(e), []);

  /** 由此裝置的金鑰送出 setGuardian：備援金鑰一經安裝，裝置與卡片都無法移除 */
  const installGuardian = async (g: Guardian) => {
    const call = execCall(DEPLOYMENT.recovery, encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "setGuardian", args: [g.address, g.authoritySig] }));
    const res = await runOp(w, call, confirmOnCard);
    return res.txHash;
  };

  const submit = async () => {
    if (!ev) return;
    setBusy("submit");
    try {
      const r = await postKyc<{ status: string; txHash?: Hex; guardian: Guardian | null }>("/api/kyc", ev);
      if (r.status !== "approved" || !r.txHash) {
        toast(r.status === "review" ? "已送出，需要人工複核，完成後會通知你" : "驗證未通過，請重新拍攝", r.status === "review" ? "neutral" : "danger");
        return;
      }
      toast(<span>實名驗證通過（L2） <TxLink hash={r.txHash} /></span>, "ok");
      let guardianTx: Hex | undefined;
      if (r.guardian) {
        guardianTx = await installGuardian(r.guardian);
        toast(<span>平台備援金鑰已啟用 <TxLink hash={guardianTx} /></span>, "ok");
      }
      setDone({ kycTx: r.txHash, guardianTx });
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const retryGuardian = async () => {
    setBusy("guardian");
    try {
      const g = await api<Guardian>("/api/kyc/guardian", {});
      const tx = await installGuardian(g);
      toast(<span>平台備援金鑰已啟用 <TxLink hash={tx} /></span>, "ok");
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  if (chain.level >= 2 || done) {
    return (
      <>
        <Panel title="實名驗證" action={<Badge tone="ok">L2 已通過</Badge>}>
          <p className="text-sm text-ink-2">
            證件與臉部影像已由 KYC 單位比對。鏈上只記錄等級與欄位的 Merkle root，姓名、證號等原文只存在你的裝置。
          </p>
          {done && <div className="mt-2"><TxLink hash={done.kycTx} /></div>}
        </Panel>

        <Panel title="平台備援金鑰" action={chain.guardian ? <Badge tone="brand">已啟用</Badge> : <Badge tone="warn">未啟用</Badge>}>
          {chain.guardian ? (
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                CAFECA 在硬體安全模組（HSM）為你保管一把獨立的備援金鑰 <span className="font-mono text-xs">{short(chain.guardian, 6)}</span>。你的裝置與卡片都無法移除它；它唯一能做的事，是在你遺失所有裝置、重新通過證件＋臉部驗證後，協助你把新裝置加回身分。
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>不能轉帳、不能調整額度、不能動你的 AI 子錢包或卡片</li>
                <li>發起恢復後需等待 48 小時（已綁卡 7 天），期間轉出凍結，你任何一台裝置都能取消</li>
                <li>萬一備援金鑰外洩，平台以離線根金鑰立即輪替</li>
              </ul>
            </div>
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-2">實名驗證已通過，但備援金鑰還沒安裝到你的身分合約。</p>
              <Button className="w-full" onClick={retryGuardian} busy={busy === "guardian"}>啟用平台備援金鑰</Button>
            </>
          )}
        </Panel>

        <Panel title="下一步">
          <p className="mb-3 text-sm text-ink-2">完成實名的身分可以購買 CAFECA 實體卡：卡片是另一把等級更高、不能被其他金鑰移除的實體金鑰，大額交易要在卡片螢幕上確認。</p>
          <Link href="/card" className="block"><Button className="w-full" variant="secondary">購買 CAFECA 實體卡</Button></Link>
        </Panel>
      </>
    );
  }


  return (
    <>
      <Panel title="為什麼要實名驗證？">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>身分等級提升為 L2，可以向商家、網站證明「我是真人、已成年」而不透露個資</li>
          <li>平台為你託管一把<strong>備援金鑰</strong>：所有裝置都遺失時，重新驗證本人就能找回身分</li>
          <li>可以購買 CAFECA 實體卡</li>
        </ul>
      </Panel>

      <Panel title="證件與臉部影像" action={<Badge tone="warn">測試網</Badge>}>
        <p className="mb-4 text-xs text-ink-3">不需要輸入任何資料：姓名、生日與身分證字號會由系統從證件自動辨識。只能用相機即時拍攝，不能選擇相簿裡的照片。</p>
        <KycCapture onChange={onEvidence} />
      </Panel>

      <Notice>
        證件影像在你的手機上就會加上「僅供 CAFECA 身分驗證使用」浮水印，未加浮水印的原圖不會離開這台裝置。影像只用於本人比對。
      </Notice>

      <Button className="w-full" onClick={submit} busy={busy === "submit"} disabled={!ev}>
        送出實名驗證
      </Button>
    </>
  );
}
