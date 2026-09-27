"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, EXPLORER, Req, TWDC_DECIMALS } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, preview, publicClient, smartSigner, submitOp } from "@/lib/client";
import { execCall } from "@/lib/userop";
import { buildDeeplink } from "@/lib/deeplink";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { AddrLink, Badge, Button, cx, EyeToggle, Field, HIDDEN_AMOUNT, inputCls, Notice, Panel, Spinner, TxLink, errMsg, fmtTwdc, short, useToast } from "@/components/ui";
import { AgentsPanel } from "@/components/agents-panel";
import { AddressInput } from "@/components/address-input";

type Activity = { hash: Hex; from: Address; to: Address; value: bigint; block: bigint };

export default function WalletPage() {
  return (
    <AppShell title="錢包">
      <WalletBody />
    </AppShell>
  );
}

function WalletBody() {
  const { wallet, chain, handle, refresh, showBalance, setShowBalance } = useWallet();
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
  const [assetIdx, setAssetIdx] = useState(0);
  const [view, setView] = useState<"assets" | "agents">("assets");
  const carouselRef = useRef<HTMLDivElement>(null);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.get("view") === "agents") setView("agents");
    const pto = q.get("to");
    if (!pto) return;
    setTo(pto);
    const amt = q.get("amt");
    if (amt && /^\d+$/.test(amt)) setAmount(formatUnits(BigInt(amt), TWDC_DECIMALS));
    setTab("send");
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

  const asset = ASSETS[assetIdx];
  const balanceOf = (sym: AssetSym) => (sym === "TWDC" ? chain.twdc : chain.bolt);
  const fmtAsset = (sym: AssetSym, v: bigint) =>
    sym === "TWDC" ? fmtTwdc(v) : Number(formatEther(v)).toLocaleString("zh-TW", { maximumFractionDigits: 4 });
  const usedPct = limit && limit.daily > 0n ? Math.min(100, Number((limit.spent * 100n) / limit.daily)) : 0;

  const onCarouselScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const i = Math.round(el.scrollLeft / (el.clientWidth * 0.86));
    if (i !== assetIdx && i >= 0 && i < ASSETS.length) {
      setAssetIdx(i);
      if (ASSETS[i].sym !== "TWDC" && tab === "send") setTab("none");
    }
  };
  const goAsset = (i: number) => {
    carouselRef.current?.scrollTo({ left: i * carouselRef.current.clientWidth * 0.86, behavior: "smooth" });
  };

  return (
    <>
      {/* 問候列 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-ink-3">{handle ? `嗨，@${handle}` : "嗨，歡迎回來"}</div>
          <div className="text-[22px] font-bold leading-tight">我的資產</div>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-line bg-surface/70 px-1.5 py-1 text-ink-2">
          <EyeToggle shown={showBalance} onToggle={() => setShowBalance(!showBalance)} className="hover:bg-surface-2" />
        </div>
      </div>

      {/* 資產卡片：左右滑動切換幣種 */}
      <div>
        <div
          ref={carouselRef}
          onScroll={onCarouselScroll}
          className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-4 pb-1"
          aria-label="資產"
        >
          {ASSETS.map((a) => (
            <div
              key={a.sym}
              className={cx(
                "relative w-[86%] shrink-0 snap-center overflow-hidden rounded-[28px] p-5 text-white",
                a.sym === "TWDC" ? "pill-gradient" : "glass",
              )}
            >
              <div className="pointer-events-none absolute -right-10 -top-12 size-44 rounded-full bg-white/10 blur-sm" />
              <div className="pointer-events-none absolute -bottom-16 right-10 size-40 rounded-full bg-white/5" />
              <div className="relative flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="grid size-9 place-items-center rounded-full bg-white/20 text-sm font-bold">{a.glyph}</span>
                  <div>
                    <div className="text-sm font-semibold">{a.sym} 餘額</div>
                    <div className="text-[11px] opacity-75">{a.name}</div>
                  </div>
                </div>
                <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px]">{a.tag}</span>
              </div>
              <div className="relative mt-5 text-[34px] font-bold tracking-tight" data-testid={a.sym === "TWDC" ? "balance" : `balance-${a.sym}`}>
                {!chain.loaded ? "—" : showBalance ? fmtAsset(a.sym, balanceOf(a.sym)) : HIDDEN_AMOUNT}
                <span className="ml-1.5 text-base font-medium opacity-80">{a.sym}</span>
              </div>
              <button
                className="relative mt-4 rounded-full bg-white/15 px-3 py-1 font-mono text-xs backdrop-blur hover:bg-white/25"
                onClick={() => {
                  navigator.clipboard.writeText(address);
                  toast("已複製地址", "ok");
                }}
              >
                {short(address, 6)} ⧉
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-center gap-1.5">
          {ASSETS.map((a, i) => (
            <button
              key={a.sym}
              aria-label={`切換到 ${a.sym}`}
              onClick={() => goAsset(i)}
              className={cx("h-1.5 rounded-full transition-all", i === assetIdx ? "w-6 bg-brand" : "w-1.5 bg-ink-3/50")}
            />
          ))}
        </div>
      </div>

      {/* 快速動作 */}
      <div className="grid grid-cols-4 gap-2">
        <ActionTile label="轉帳" active={tab === "send"} icon="M5 12h14M13 6l6 6-6 6" onClick={() => {
          if (asset.sym !== "TWDC") return toast("BOLT 只用來支付 gas，由平台全額贊助，不需要轉帳", "neutral");
          setView("assets");
          setTab(tab === "send" ? "none" : "send");
        }} />
        <ActionTile label="收款" active={tab === "receive"} icon="M12 4v12M6 10l6 6 6-6M5 20h14" onClick={() => {
          setView("assets");
          setTab(tab === "receive" ? "none" : "receive");
        }} />
        <ActionTile label="AI 子錢包" active={view === "agents"} icon="M12 3v3M5 9h14v10H5zM9 13h.01M15 13h.01M9 16h6" onClick={() => setView(view === "agents" ? "assets" : "agents")} />
        <ActionTile label="領測試幣" busy={busy && tab === "none"} icon="M12 3v18M3 12h18" onClick={faucet} />
      </div>

      {/* 分頁：資產／AI 子錢包 */}
      <div className="grid grid-cols-2 rounded-full border border-line bg-surface/70 p-1 text-sm">
        {(["assets", "agents"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cx("rounded-full py-2 font-medium transition", view === v ? "pill-gradient text-white" : "text-ink-3 hover:text-ink-2")}
          >
            {v === "assets" ? "資產" : "AI 子錢包"}
          </button>
        ))}
      </div>

      {view === "agents" ? (
        <AgentsPanel />
      ) : (
        <>
          {tab === "send" && (
            <Panel title="轉帳 TWDC" className="rise">
              <div className="space-y-3">
                <Field label="收款人" hint="代稱（例：@alice）、0x 地址，或按右側圖示掃描收款 QR">
                  <AddressInput value={to} onChange={setTo} onScanAmount={(v) => setAmount(formatUnits(v, TWDC_DECIMALS))} placeholder="@alice 或 0x…" />
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
                {qr && <img src={qr} alt="收款 QR code" className="size-48 rounded-2xl bg-white p-2" />}
                <p className="text-center text-xs text-ink-3">對方用手機相機掃描即可開啟付款畫面</p>
                <div className="break-all text-center font-mono text-xs text-ink-2">{address}</div>
              </div>
            </Panel>
          )}

          {asset.sym === "TWDC" ? (
            <>
              {limit && (
                <section className="flex items-center gap-4 rounded-3xl border border-line bg-surface p-4">
                  <Ring pct={usedPct} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <div className="text-[15px] font-semibold">今日額度</div>
                      {chain.masterMode ? <Badge tone="brand">超額可用卡片</Badge> : <Badge>超額將被拒絕</Badge>}
                    </div>
                    <div className="mt-1 text-sm text-ink-2">已用 {fmtTwdc(limit.spent)} / {fmtTwdc(limit.daily)} TWDC</div>
                    <div className="text-xs text-ink-3">單筆上限 {fmtTwdc(limit.perTx)} TWDC</div>
                  </div>
                </section>
              )}

              <Panel title="最近紀錄">
                {activity.length === 0 ? (
                  <p className="text-sm text-ink-3">還沒有 TWDC 轉帳紀錄</p>
                ) : (
                  <ul className="space-y-2">
                    {activity.map((a) => {
                      const out = a.from.toLowerCase() === address.toLowerCase();
                      return (
                        <li key={a.hash + a.to} className="flex items-center gap-3 rounded-2xl bg-surface-2/60 p-2.5">
                          <span className={cx("grid size-10 shrink-0 place-items-center rounded-xl", out ? "bg-brand-bg text-brand" : "bg-ok-bg text-ok")}>
                            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d={out ? "M7 17L17 7M9 7h8v8" : "M17 7L7 17M15 17H7V9"} />
                            </svg>
                          </span>
                          <div className="min-w-0 flex-1">
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
          ) : (
            <Panel title="BOLT">
              <p className="text-sm text-ink-2">
                BOLT 是 Boltchain 的原生幣，用來支付交易手續費。CAFECA 由平台全額贊助 gas，你不需要持有或轉帳 BOLT。
              </p>
              <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-brand">
                在區塊鏈瀏覽器查看 →
              </a>
            </Panel>
          )}
        </>
      )}
    </>
  );
}

type AssetSym = "TWDC" | "BOLT";
const ASSETS: { sym: AssetSym; name: string; glyph: string; tag: string }[] = [
  { sym: "TWDC", name: "新台幣穩定幣（測試網）", glyph: "NT", tag: "可轉帳" },
  { sym: "BOLT", name: "Boltchain 原生幣", glyph: "⚡", tag: "gas 由平台贊助" },
];

function ActionTile({ label, icon, onClick, active, busy }: { label: string; icon: string; onClick: () => void; active?: boolean; busy?: boolean }) {
  return (
    <button onClick={onClick} disabled={busy} className="group flex flex-col items-center gap-1.5 disabled:opacity-60" aria-pressed={active}>
      <span
        className={cx(
          "grid size-14 place-items-center rounded-2xl border transition group-active:scale-95",
          active ? "pill-gradient border-transparent text-white" : "border-line bg-surface text-ink-2 group-hover:text-ink",
        )}
      >
        {busy ? (
          <Spinner />
        ) : (
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={icon} />
          </svg>
        )}
      </span>
      <span className="text-xs text-ink-2">{label}</span>
    </button>
  );
}

/** 環狀進度（參考設計稿的圓形儀表） */
function Ring({ pct }: { pct: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-[68px] shrink-0">
      <svg viewBox="0 0 64 64" className="size-full -rotate-90" aria-hidden>
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f69a5a" />
            <stop offset="1" stopColor="#ef5da8" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="url(#ring-grad)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-sm font-semibold">{pct}%</div>
    </div>
  );
}
