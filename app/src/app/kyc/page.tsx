"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api, saveWallet } from "@/lib/client";
import { runOp } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { KycCapture, postKyc, type KycEvidence } from "@/components/kyc-capture";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, Field, inputCls, Notice, Panel, TxLink, errMsg, short, useToast } from "@/components/ui";

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
  const [form, setForm] = useState({ name: "", idNumber: "", birthday: "" });
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
      const r = await postKyc<{ leaves: NonNullable<typeof w.kycLeaves>; txHash: Hex; guardian: Guardian | null }>("/api/kyc", ev, form);
      saveWallet({ ...w, kycLeaves: r.leaves });
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

  const valid = form.name && /^[A-Z][12]\d{8}$/.test(form.idNumber) && form.birthday && ev;

  return (
    <>
      <Panel title="為什麼要實名驗證？">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>身分等級提升為 L2，可以向商家、網站證明「我是真人、已成年」而不透露個資</li>
          <li>平台為你託管一把<strong>備援金鑰</strong>：所有裝置都遺失時，重新驗證本人就能找回身分</li>
          <li>可以購買 CAFECA 實體卡</li>
        </ul>
      </Panel>

      <Panel title="證件資料" action={<Badge tone="warn">測試網模擬 KYC</Badge>}>
        <div className="space-y-3">
          <Field label="姓名（英文，與證件相同）">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })} placeholder="CHEN HUNG-JEN" />
          </Field>
          <Field label="身分證字號">
            <input className={inputCls} value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value.toUpperCase() })} placeholder="A123456789" />
          </Field>
          <Field label="生日">
            <input className={inputCls} type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
          </Field>
        </div>
      </Panel>

      <Panel title="證件與臉部影像">
        <KycCapture onChange={onEvidence} />
      </Panel>

      <Notice>
        影像只用於本人比對。此原型不保存原始影像，只記錄雜湊值；正式版由持照 KYC 單位依個資法規保存與銷毀。
      </Notice>

      <Button className="w-full" onClick={submit} busy={busy === "submit"} disabled={!valid}>
        送出實名驗證
      </Button>
    </>
  );
}
