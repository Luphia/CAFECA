"use client";

import { useState } from "react";
import { encodeFunctionData } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { api } from "@/lib/client";
import { runOp } from "@/lib/actions";
import { pairingCode, type PairLink } from "@/lib/deeplink";
import { execCall } from "@/lib/userop";
import { rpIdHash } from "@/lib/webauthn";
import { useCardConfirm } from "./card-provider";
import { useWallet } from "./wallet-provider";
import { Button, Notice, TxLink, errMsg, useToast } from "./ui";

/**
 * 既有裝置確認加入新裝置：顯示新裝置名稱與 6 位確認碼，使用者比對兩邊一致後以本機金鑰送出 addDailyKey，
 * 再把身分地址回填到配對 session，讓新裝置完成登入。
 */
export function PairApprove({ link, onDone, onCancel }: { link: PairLink; onDone?: () => void; onCancel?: () => void }) {
  const { wallet, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const code = pairingCode(link.qx, link.qy);

  const approve = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      // 新裝置與這台裝置在同一個 RP 網域註冊 passkey，rpIdHash 相同
      const rp = await rpIdHash();
      const call = execCall(
        DEPLOYMENT.keyring,
        encodeFunctionData({ abi: keyringValidatorAbi, functionName: "addDailyKey", args: [link.qx, link.qy, rp] }),
      );
      const res = await runOp(wallet, call, confirmOnCard);
      await api("/api/link/complete", { id: link.session, address: wallet.address });
      toast(<span>已加入「{link.name}」，新裝置會自動完成登入 <TxLink hash={res.txHash} /></span>, "ok");
      setDone(true);
      await refresh();
      onDone?.();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  if (done) return <Notice tone="ok">「{link.name}」已加入你的身分，與這台裝置同級。</Notice>;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line p-3">
        <div className="text-xs text-ink-3">要加入的裝置</div>
        <div className="text-base font-semibold">{link.name}</div>
        <div className="mt-3 text-xs text-ink-3">確認碼</div>
        <div className="font-mono text-3xl font-bold tracking-widest text-brand" data-testid="pair-code">{code}</div>
        <p className="mt-2 text-xs text-ink-2">請確認新裝置畫面上顯示的確認碼與這裡完全相同。不一致代表 QR code 可能被掉包，請不要加入。</p>
      </div>
      <Notice tone="warn">加入後，這台新裝置和你現在的裝置同級：可以轉帳（在額度內）、也能新增或移除其他裝置。只加入你自己的裝置。</Notice>
      <div className="flex gap-2">
        {onCancel && <Button variant="secondary" className="flex-1" onClick={onCancel}>不要加入</Button>}
        <Button className="flex-1" onClick={approve} busy={busy}>確認碼一致，加入</Button>
      </div>
    </div>
  );
}
