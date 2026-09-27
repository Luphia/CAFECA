"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, Req, TWDC_DECIMALS } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, preview, publicClient, smartSigner, submitOp } from "@/lib/client";
import { execCall } from "@/lib/userop";
import { buildDeeplink } from "@/lib/deeplink";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { AddrLink, Badge, Button, EyeToggle, Field, HIDDEN_AMOUNT, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, short, useToast } from "@/components/ui";

type Activity = { hash: Hex; from: Address; to: Address; value: bigint; block: bigint };

export default function WalletPage() {
  return (
    <AppShell title="錢包">
      <WalletBody />
    </AppShell>
  );
}

function WalletBody() {
  const { wallet, chain, refresh, showBalance, setShowBalance } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [tab, setTab] = useState<"none" | "send" | "receive">("none");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [hint, setHint] = useState<{ req: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string>("");
  const [limit, setLimit] = useState<{ perTx: bigint; daily: bigint; spent: bigint } | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const address = wallet!.address;

  const loadLimits = useCallback(async () => {
    const [[perTx, daily], [spent, windowStart]] = await Promise.all([
      publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "limits", args: [DEPLOYMENT.twdc, address] }),
      publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "spent", args: [DEPLOYMENT.twdc, address] }),
    ]);
    const inWindow = Date.now() / 1000 < Number(windowStart) + 86400;
    setLimit({ perTx, daily, spent: inWindow ? spent : 0n });
  }, [address]);

  const loadActivity = useCallback(async () => {
    try {
      const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
      const fromBlock = BigInt(DEPLOYMENT.startBlock);
      const [out, inc] = await Promise.all([
        publicClient.getLogs({ address: DEPLOYMENT.twdc, event: ev, args: { from: address }, fromBlock }),
        publicClient.getLogs({ address: DEPLOYMENT.twdc, event: ev, args: { to: address }, fromBlock }),
      ]);
      const all = [...out, ...inc]
        .map((l) => ({ hash: l.transactionHash!, from: l.args.from!, to: l.args.to!, value: l.args.value!, block: l.blockNumber! }))
        .sort((a, b) => Number(b.block - a.block));
      setActivity(all.slice(0, 20));
    } catch (e) {
      console.warn("getLogs failed", e);
    }
  }, [address]);

  useEffect(() => {
    // 讀取鏈上資料（外部系統同步）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLimits().catch(() => undefined);
    loadActivity();
  }, [loadLimits, loadActivity, chain.twdc]);

  // 收款 QR：CAFECA pay 深連結（手機相機掃描即開啟付款畫面；其他錢包仍可從連結中讀出地址）
  const payLink = buildDeeplink({ action: "pay", to: address });
  useEffect(() => {
    QRCode.toDataURL(payLink, { margin: 1, width: 220 }).then(setQr).catch(() => undefined);
  }, [payLink]);

  // 由 pay 深連結開啟：預填收款人與金額（不自動送出）
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pto = q.get("to");
    if (!pto) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setTo(pto);
    const amt = q.get("amt");
    if (amt && /^\d+$/.test(amt)) setAmount(formatUnits(BigInt(amt), TWDC_DECIMALS));
    setTab("send");
    /* eslint-enable react-hooks/set-state-in-effect */
    window.history.replaceState(null, "", "/wallet");
  }, []);

  const resolveTo = async (): Promise<Address> => {
    const q = to.trim();
    if (isAddress(q)) return getAddress(q);
    const r = await api<{ address: Address }>(`/api/profile?q=${encodeURIComponent(q)}`);
    return r.address;
  };

  const buildCall = async () => {
    const dest = await resolveTo();
    const value = parseUnits(amount || "0", TWDC_DECIMALS);
    if (value <= 0n) throw new Error("請輸入金額");
    return execCall(DEPLOYMENT.twdc, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, value] }));
  };

  // 即時預覽：這筆轉帳需要手機還是卡片
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        if (!amount || !to) return setHint(null);
        const pv = await preview(address, await buildCall());
        setHint({ req: pv.req });
      } catch {
        setHint(null);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, to]);

  const send = async () => {
    setBusy(true);
    try {
      const callData = await buildCall();
      const { signer, needs } = await smartSigner(address, callData, wallet!.passkeys, confirmOnCard);
      toast(needs === "card" ? "大額轉帳：請用 CAFECA 卡確認" : "請用 Passkey 簽署");
      const res = await submitOp({ sender: address, validator: DEPLOYMENT.keyring, callData, signer });
      toast(<span>轉帳完成 <TxLink hash={res.txHash} /></span>, "ok");
      setAmount("");
      setTab("none");
      await refresh();
      await loadLimits();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const faucet = async () => {
    setBusy(true);
    try {
      const r = await api<{ txHash: Hex }>("/api/faucet", { address });
      toast(<span>已領取 50,000 TWDC <TxLink hash={r.txHash} /></span>, "ok");
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="brand-gradient rise relative overflow-hidden rounded-3xl p-5 text-white shadow-lg">
        <div className="flex items-center gap-1 text-sm opacity-90">
          TWDC 餘額
          <EyeToggle shown={showBalance} onToggle={() => setShowBalance(!showBalance)} />
        </div>
        <div className="mt-1 text-[34px] font-bold tracking-tight" data-testid="balance">
          {!chain.loaded ? "—" : showBalance ? fmtTwdc(chain.twdc) : HIDDEN_AMOUNT}
        </div>
        <div className="mt-1 text-xs opacity-80">
          BOLT {!chain.loaded ? "—" : showBalance ? Number(formatEther(chain.bolt)).toFixed(4) : HIDDEN_AMOUNT}（gas 由平台贊助，不需持有）
        </div>
        <button
          className="mt-4 rounded-full bg-white/20 px-3 py-1 font-mono text-xs backdrop-blur hover:bg-white/30"
          onClick={() => {
            navigator.clipboard.writeText(address);
            toast("已複製地址", "ok");
          }}
        >
          {short(address, 6)} ⧉
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button variant={tab === "send" ? "primary" : "secondary"} onClick={() => setTab(tab === "send" ? "none" : "send")}>轉帳</Button>
        <Button variant={tab === "receive" ? "primary" : "secondary"} onClick={() => setTab(tab === "receive" ? "none" : "receive")}>收款</Button>
        <Button variant="secondary" onClick={faucet} busy={busy && tab === "none"}>領測試幣</Button>
      </div>

      {tab === "send" && (
        <Panel title="轉帳 TWDC" className="rise">
          <div className="space-y-3">
            <Field label="收款人" hint="代稱（例：@alice）或 0x 地址">
              <input className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} placeholder="@alice 或 0x…" />
            </Field>
            <Field label="金額">
              <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </Field>
            {hint && (
              <Notice tone={hint.req === Req.MASTER ? "brand" : hint.req === Req.REJECT ? "danger" : "neutral"}>
                {hint.req === Req.DAILY && "在日常額度內，用手機 Passkey 即可。"}
                {hint.req === Req.MASTER && "超過日常額度：需要 CAFECA 卡在螢幕上確認金額與收款人。"}
                {hint.req === Req.REJECT && "超過標準模式的額度上限。綁定 CAFECA 卡後可進行大額轉帳。"}
              </Notice>
            )}
            <Button className="w-full" onClick={send} busy={busy} disabled={!to || !amount}>送出</Button>
          </div>
        </Panel>
      )}

      {tab === "receive" && (
        <Panel title="收款" className="rise">
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr && <img src={qr} alt="錢包地址 QR code" className="size-48 rounded-xl bg-white p-2" />}
            <div className="break-all text-center font-mono text-xs text-ink-2">{address}</div>
          </div>
        </Panel>
      )}

      {limit && (
        <Panel title="今日額度（TWDC）" action={chain.masterMode ? <Badge tone="brand">超額可用卡片</Badge> : <Badge>超額將被拒絕</Badge>}>
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-ink-2">已用 {fmtTwdc(limit.spent)} / {fmtTwdc(limit.daily)}</span>
            <span className="text-ink-2">單筆上限 {fmtTwdc(limit.perTx)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="brand-gradient h-full" style={{ width: `${limit.daily > 0n ? Math.min(100, Number((limit.spent * 100n) / limit.daily)) : 0}%` }} />
          </div>
        </Panel>
      )}

      <Panel title="最近紀錄">
        {activity.length === 0 ? (
          <p className="text-sm text-ink-3">還沒有 TWDC 轉帳紀錄</p>
        ) : (
          <ul className="divide-y divide-line">
            {activity.map((a) => {
              const out = a.from.toLowerCase() === address.toLowerCase();
              return (
                <li key={a.hash + a.to} className="flex items-center justify-between py-2.5">
                  <div>
                    <div className="text-sm font-medium">{out ? "轉出" : "收到"}</div>
                    <div className="flex items-center gap-2">
                      <AddrLink address={out ? a.to : a.from} />
                      <TxLink hash={a.hash} label="交易" />
                    </div>
                  </div>
                  <div className={out ? "font-semibold text-ink" : "font-semibold text-ok"}>
                    {out ? "−" : "+"}
                    {fmtTwdc(a.value)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
