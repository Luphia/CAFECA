"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, getAddress, isAddress, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi, deviceDirectoryAbi, keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, passkeySigner, publicClient, saveWallet, submitOp } from "@/lib/client";
import { decryptEnvelope, devicesOf, ensureDeviceKey, encryptFor, getDeviceKey } from "@/lib/chat-crypto";
import { runOp, transferCall } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, cx, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, short, useToast } from "@/components/ui";
import { AddressInput } from "@/components/address-input";

type RawMsg = {
  id: string;
  from: string;
  to: string;
  fromDevice?: Hex;
  kind: "text" | "pay.request" | "pay.receipt" | "pay.transfer" | "agent.intent" | "system";
  envelopes?: Record<string, { iv: string; ct: string }>;
  body?: Record<string, string>;
  ts: number;
};

type Payload = { text?: string; amount?: string; memo?: string; txHash?: Hex; requestId?: string };

const SYSTEM = "system";

/** 鏈上的 TWDC 轉帳（不論是在聊天、錢包或其他地方送出，都顯示在與對方的對話中） */
type ChainTx = { hash: Hex; from: string; to: string; value: bigint; ts: number };
type Mode = "text" | "request" | "transfer";

export default function ChatPage() {
  return (
    <AppShell title="聊天">
      <ChatBody />
    </AppShell>
  );
}

function ChatBody() {
  const { wallet, handle, refreshSession } = useWallet();
  const toast = useToast();
  const me = wallet!.address.toLowerCase();
  const [deviceReady, setDeviceReady] = useState<boolean | null>(null);
  const [msgs, setMsgs] = useState<RawMsg[]>([]);
  const [plain, setPlain] = useState<Record<string, Payload | null>>({});
  const [handles, setHandles] = useState<Record<string, string | null>>({});
  const [peer, setPeer] = useState<string | null>(null);
  const [newPeer, setNewPeer] = useState("");
  const [handleInput, setHandleInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chainTx, setChainTx] = useState<ChainTx[]>([]);
  const [extraHandles, setExtraHandles] = useState<Record<string, string | null>>({});
  const decrypted = useRef<Set<string>>(new Set());
  const identityCache = useRef<Map<string, boolean>>(new Map());
  const blockTs = useRef<Map<bigint, number>>(new Map());

  const checkDevice = useCallback(async () => {
    const local = await getDeviceKey();
    if (!local) return setDeviceReady(false);
    const list = await devicesOf(wallet!.address);
    setDeviceReady(list.some((d) => d.deviceId === local.deviceId));
  }, [wallet]);

  // 由 id 深連結開啟：預填聊天對象
  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get("with");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (w) setNewPeer(w);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkDevice().catch(() => setDeviceReady(false));
  }, [checkDevice]);

  const poll = useCallback(async () => {
    const r = await api<{ messages: RawMsg[]; handles: Record<string, string | null> }>("/api/chat/inbox");
    setMsgs(r.messages);
    setHandles(r.handles);
    const updates: Record<string, Payload | null> = {};
    for (const m of r.messages) {
      if (decrypted.current.has(m.id) || !m.envelopes || !m.fromDevice) continue;
      decrypted.current.add(m.id);
      updates[m.id] = (await decryptEnvelope(getAddress(m.from), m.fromDevice, m.envelopes)) as Payload | null;
    }
    if (Object.keys(updates).length) setPlain((p) => ({ ...p, ...updates }));
  }, []);

  /** 讀取與我相關的鏈上 TWDC 轉帳，只保留對方也是 CAFECA 身分的紀錄 */
  const loadChainTx = useCallback(async () => {
    const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const fromBlock = BigInt(DEPLOYMENT.startBlock);
    const self = getAddress(me);
    const [out, inc] = await Promise.all([
      publicClient.getLogs({ address: DEPLOYMENT.twdc, event: ev, args: { from: self }, fromBlock }),
      publicClient.getLogs({ address: DEPLOYMENT.twdc, event: ev, args: { to: self }, fromBlock }),
    ]);
    const logs = [...out, ...inc].sort((a, b) => Number(b.blockNumber! - a.blockNumber!)).slice(0, 100);
    const others = [...new Set(logs.map((l) => (l.args.from!.toLowerCase() === me ? l.args.to! : l.args.from!).toLowerCase()))];
    await Promise.all(
      others
        .filter((o) => !identityCache.current.has(o))
        .map(async (o) => {
          const st = await publicClient
            .readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "accountState", args: [getAddress(o)] })
            .catch(() => null);
          identityCache.current.set(o, !!st?.[2]);
        }),
    );
    const blocks = [...new Set(logs.map((l) => l.blockNumber!))].filter((b) => !blockTs.current.has(b));
    await Promise.all(
      blocks.map(async (b) => {
        const blk = await publicClient.getBlock({ blockNumber: b }).catch(() => null);
        if (blk) blockTs.current.set(b, Number(blk.timestamp) * 1000);
      }),
    );
    const txs: ChainTx[] = [];
    for (const l of logs) {
      const other = (l.args.from!.toLowerCase() === me ? l.args.to! : l.args.from!).toLowerCase();
      if (!identityCache.current.get(other) || other === me) continue;
      txs.push({ hash: l.transactionHash!, from: l.args.from!.toLowerCase(), to: l.args.to!.toLowerCase(), value: l.args.value!, ts: blockTs.current.get(l.blockNumber!) ?? 0 });
    }
    setChainTx(txs);
    const missing = [...new Set(txs.map((t) => (t.from === me ? t.to : t.from)))].filter((o) => !(o in extraHandlesRef.current));
    for (const o of missing) {
      const r = await api<{ handle: string | null }>(`/api/profile?q=${o}`).catch(() => ({ handle: null }));
      extraHandlesRef.current[o] = r.handle;
    }
    if (missing.length) setExtraHandles({ ...extraHandlesRef.current });
  }, [me]);
  const extraHandlesRef = useRef<Record<string, string | null>>({});

  useEffect(() => {
    if (!deviceReady) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadChainTx().catch(() => undefined);
    const t = setInterval(() => loadChainTx().catch(() => undefined), 8000);
    return () => clearInterval(t);
  }, [deviceReady, loadChainTx]);

  useEffect(() => {
    if (!deviceReady) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll().catch(() => undefined);
    const t = setInterval(() => poll().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [deviceReady, poll]);

  const enableDevice = async () => {
    setBusy(true);
    try {
      const dev = await ensureDeviceKey();
      const callData = execCall(
        DEPLOYMENT.deviceDirectory,
        encodeFunctionData({ abi: deviceDirectoryAbi, functionName: "registerDevice", args: [dev.deviceId, dev.pub] }),
      );
      await submitOp({ sender: wallet!.address, validator: DEPLOYMENT.keyring, callData, signer: passkeySigner(wallet!.passkeys) });
      saveWallet({ ...wallet!, deviceId: dev.deviceId });
      setDeviceReady(true);
      toast("此裝置的加密聊天金鑰已登記上鏈", "ok");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const saveHandle = async () => {
    try {
      await api("/api/profile", { handle: handleInput });
      await refreshSession();
      toast("代稱已設定", "ok");
    } catch (e) {
      toast(errMsg(e), "danger");
    }
  };

  const allHandles = useMemo(() => ({ ...extraHandles, ...handles }), [extraHandles, handles]);

  const peers = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of msgs) {
      const other = m.from.toLowerCase() === me ? m.to.toLowerCase() : m.from.toLowerCase();
      map.set(other, Math.max(map.get(other) ?? 0, m.ts));
    }
    for (const t of chainTx) {
      const other = t.from === me ? t.to : t.from;
      map.set(other, Math.max(map.get(other) ?? 0, t.ts));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [msgs, chainTx, me]);

  /** 對話列表的最後一則：訊息或鏈上轉帳，取較新者 */
  const lastLine = (p: string) => {
    const last = [...msgs].reverse().find((m) => m.from.toLowerCase() === p || m.to.toLowerCase() === p);
    const tx = chainTx.find((t) => t.from === p || t.to === p);
    if (tx && (!last || tx.ts > last.ts)) return `${tx.from === me ? "↗ 轉出" : "↙ 收到"} ${fmtTwdc(tx.value)} TWDC`;
    return last ? preview(last, plain[last.id]) : "";
  };

  const openPeer = async () => {
    try {
      const q = newPeer.trim();
      const r = isAddress(q) ? { address: getAddress(q) } : await api<{ address: Address }>(`/api/profile?q=${encodeURIComponent(q)}`);
      setPeer(r.address.toLowerCase());
      setNewPeer("");
    } catch (e) {
      toast(errMsg(e), "danger");
    }
  };

  if (deviceReady === null) return null;

  if (!deviceReady) {
    return (
      <Panel title="啟用端對端加密聊天">
        <p className="mb-3 text-sm text-ink-2">
          在此裝置產生聊天金鑰（ECDH P-256，不可匯出），並把公鑰登記到鏈上的裝置目錄。訊息只以密文經過伺服器。
        </p>
        <Button className="w-full" onClick={enableDevice} busy={busy}>以 Passkey 啟用</Button>
      </Panel>
    );
  }

  if (peer) {
    return (
      <Thread
        peer={peer}
        msgs={msgs}
        plain={plain}
        handles={allHandles}
        chainTx={chainTx.filter((t) => t.from === peer || t.to === peer)}
        onBack={() => setPeer(null)}
        onSent={async () => {
          await poll();
          await loadChainTx();
        }}
      />
    );
  }

  return (
    <>
      {!handle && (
        <Panel title="設定你的代稱">
          <p className="mb-2 text-sm text-ink-2">朋友可以用 @代稱 找到你、轉帳給你。</p>
          <div className="flex gap-2">
            <input className={inputCls} value={handleInput} onChange={(e) => setHandleInput(e.target.value)} placeholder="例如 luphia" />
            <Button onClick={saveHandle}>設定</Button>
          </div>
        </Panel>
      )}
      {handle && <div className="text-sm text-ink-2">你的代稱：<span className="font-semibold text-ink">@{handle}</span></div>}

      <div className="flex gap-2">
        <AddressInput value={newPeer} onChange={setNewPeer} placeholder="輸入 @代稱 或地址開始聊天" />
        <Button variant="secondary" onClick={openPeer} disabled={!newPeer}>開始</Button>
      </div>

      <Panel>
        {peers.length === 0 ? (
          <p className="text-sm text-ink-3">還沒有對話</p>
        ) : (
          <ul className="divide-y divide-line">
            {peers.map((p) => {
              return (
                <li key={p}>
                  <button className="flex w-full items-center gap-3 py-3 text-left" onClick={() => setPeer(p)}>
                    <Avatar peer={p} handle={allHandles[p]} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{p === SYSTEM ? "CAFECA AI 通知" : allHandles[p] ? `@${allHandles[p]}` : short(p)}</div>
                      <div className="truncate text-sm text-ink-3">{lastLine(p)}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}

function preview(m: RawMsg, p: Payload | null | undefined) {
  if (m.kind === "agent.intent") return `AI 請求核准 ${fmtTwdc(m.body?.amount ?? "0")} TWDC`;
  if (!p) return "🔒 加密訊息";
  if (m.kind === "pay.request") return `💸 付款請求 ${p.amount} TWDC`;
  if (m.kind === "pay.receipt") return `✅ 已付款 ${p.amount} TWDC`;
  if (m.kind === "pay.transfer") return `💸 轉帳 ${p.amount} TWDC`;
  return p.text ?? "";
}

function Avatar({ peer, handle }: { peer: string; handle?: string | null }) {
  if (peer === SYSTEM) return <div className="brand-gradient grid size-10 place-items-center rounded-full text-white">🤖</div>;
  const hue = parseInt(peer.slice(2, 6), 16) % 360;
  return (
    <div className="grid size-10 place-items-center rounded-full font-semibold text-white" style={{ background: `hsl(${hue} 55% 55%)` }}>
      {(handle ?? peer.slice(2, 3)).slice(0, 1).toUpperCase()}
    </div>
  );
}

function Thread({
  peer,
  msgs,
  plain,
  handles,
  chainTx,
  onBack,
  onSent,
}: {
  peer: string;
  msgs: RawMsg[];
  plain: Record<string, Payload | null>;
  handles: Record<string, string | null>;
  chainTx: ChainTx[];
  onBack: () => void;
  onSent: () => Promise<void>;
}) {
  const { wallet, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const me = wallet!.address.toLowerCase();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("text");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const thread = msgs.filter((m) => m.from.toLowerCase() === peer || m.to.toLowerCase() === peer).sort((a, b) => a.ts - b.ts);
  const paidRequests = new Set(thread.filter((m) => m.kind === "pay.receipt").map((m) => plain[m.id]?.requestId).filter(Boolean));
  // 已由聊天訊息（付款回條／轉帳）呈現的交易，不再重複顯示鏈上紀錄
  const shownTx = new Set(thread.map((m) => plain[m.id]?.txHash?.toLowerCase()).filter(Boolean));
  const items: ({ t: "msg"; m: RawMsg; ts: number } | { t: "tx"; x: ChainTx; ts: number })[] = [
    ...thread.map((m) => ({ t: "msg" as const, m, ts: m.ts })),
    ...chainTx.filter((x) => !shownTx.has(x.hash.toLowerCase())).map((x) => ({ t: "tx" as const, x, ts: x.ts })),
  ].sort((a, b) => a.ts - b.ts);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  const send = async (kind: RawMsg["kind"], payload: Payload) => {
    const dev = await ensureDeviceKey();
    const [theirs, mine] = await Promise.all([devicesOf(getAddress(peer)), devicesOf(wallet!.address)]);
    if (theirs.length === 0) throw new Error("對方尚未啟用加密聊天");
    const all = [...theirs, ...mine.filter((m) => !theirs.some((t) => t.deviceId === m.deviceId))];
    const envelopes = await encryptFor(all, payload);
    await api("/api/chat/send", { to: getAddress(peer), fromDevice: dev.deviceId, kind, envelopes });
    await onSent();
  };

  const sendText = async () => {
    if (mode === "text" && !text.trim()) return;
    setBusy("send");
    try {
      if (mode === "request") {
        if (!(parseUnits(amount || "0", TWDC_DECIMALS) > 0n)) throw new Error("請輸入金額");
        await send("pay.request", { amount, memo: text });
        setMode("text");
        setAmount("");
      } else if (mode === "transfer") {
        const value = parseUnits(amount || "0", TWDC_DECIMALS);
        if (value <= 0n) throw new Error("請輸入金額");
        const res = await runOp(wallet!, transferCall(getAddress(peer), value), confirmOnCard);
        try {
          await send("pay.transfer", { amount, memo: text, txHash: res.txHash });
        } catch {
          // 對方沒有啟用加密聊天也沒關係：鏈上轉帳仍會出現在對話中
          await onSent();
        }
        toast(<span>已轉帳 {amount} TWDC <TxLink hash={res.txHash} /></span>, "ok");
        setMode("text");
        setAmount("");
        await refresh();
      } else {
        await send("text", { text });
      }
      setText("");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const pay = async (m: RawMsg, p: Payload) => {
    setBusy(m.id);
    try {
      const res = await runOp(wallet!, transferCall(getAddress(peer), parseUnits(p.amount ?? "0", TWDC_DECIMALS)), confirmOnCard);
      await send("pay.receipt", { amount: p.amount, txHash: res.txHash, requestId: m.id });
      toast("已付款", "ok");
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const approveIntent = async (m: RawMsg) => {
    const b = m.body!;
    setBusy(m.id);
    try {
      const callData = execCall(
        DEPLOYMENT.channelValidator,
        encodeFunctionData({
          abi: channelValidatorAbi,
          functionName: "approveIntent",
          args: [b.channel as Address, BigInt(b.intentId), b.token as Address, b.to as Address, BigInt(b.amount)],
        }),
      );
      const res = await runOp(wallet!, callData, confirmOnCard);
      await api("/api/agent/run", { id: b.agentId, item: b.item, approvedTx: res.txHash });
      toast(<span>已核准 AI 請求 <TxLink hash={res.txHash} /></span>, "ok");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-[70dvh] flex-col">
      <div className="mb-3 flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-brand">← 返回</button>
        <Avatar peer={peer} handle={handles[peer]} />
        <div>
          <div className="font-semibold">{peer === SYSTEM ? "CAFECA AI 通知" : handles[peer] ? `@${handles[peer]}` : short(peer)}</div>
          {peer !== SYSTEM && <div className="text-xs text-ink-3">🔒 端對端加密</div>}
        </div>
      </div>

      <div className="flex-1 space-y-2">
        {items.map((it) => {
          if (it.t === "tx") {
            const x = it.x;
            const out = x.from === me;
            return (
              <div key={"tx" + x.hash} className={cx("flex", out ? "justify-end" : "justify-start")}>
                <div className="max-w-[80%] rounded-2xl border border-line bg-surface-2 px-3 py-2" data-testid="chain-tx">
                  <div className="text-xs text-ink-3">{out ? "↗ 你轉帳給對方" : "↙ 對方轉帳給你"} · 鏈上紀錄</div>
                  <div className={cx("text-lg font-semibold", out ? "text-ink" : "text-ok")}>
                    {out ? "−" : "+"}
                    {fmtTwdc(x.value)} TWDC
                  </div>
                  <TxLink hash={x.hash} />
                  {x.ts > 0 && (
                    <div className="mt-0.5 text-[10px] text-ink-3">{new Date(x.ts).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                  )}
                </div>
              </div>
            );
          }
          const m = it.m;
          const mine = m.from.toLowerCase() === me;
          const p = plain[m.id];
          if (m.kind === "agent.intent") {
            const b = m.body!;
            return (
              <div key={m.id} className="rounded-2xl border border-brand/30 bg-brand-bg p-3">
                <div className="text-sm font-semibold text-brand">🤖 {b.agentName} 請求核准</div>
                <div className="mt-1 text-sm">{b.itemName}</div>
                <div className="text-lg font-semibold">{fmtTwdc(b.amount)} TWDC</div>
                <div className="text-xs text-ink-3">超過確認門檻 · 請求 #{b.intentId}</div>
                <Button size="sm" className="mt-2" onClick={() => approveIntent(m)} busy={busy === m.id}>以卡片核准</Button>
              </div>
            );
          }
          return (
            <div key={m.id} className={cx("flex", mine ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "max-w-[80%] rounded-2xl px-3 py-2 text-[15px]",
                  mine ? "brand-gradient text-white" : "border border-line bg-surface",
                )}
              >
                {!p && <span className="opacity-70">🔒 無法在此裝置解密</span>}
                {p && m.kind === "text" && <span className="whitespace-pre-wrap">{p.text}</span>}
                {p && m.kind === "pay.request" && (
                  <div>
                    <div className="text-xs opacity-80">付款請求</div>
                    <div className="text-xl font-semibold">{p.amount} TWDC</div>
                    {p.memo && <div className="text-sm opacity-90">{p.memo}</div>}
                    {paidRequests.has(m.id) ? (
                      <Badge tone="ok">已付款</Badge>
                    ) : (
                      !mine && (
                        <Button size="sm" variant="secondary" className="mt-2" onClick={() => pay(m, p)} busy={busy === m.id}>
                          支付
                        </Button>
                      )
                    )}
                  </div>
                )}
                {p && m.kind === "pay.transfer" && (
                  <div>
                    <div className="text-xs opacity-80">💸 {mine ? "轉帳給對方" : "轉帳給你"}</div>
                    <div className="text-xl font-semibold">{p.amount} TWDC</div>
                    {p.memo && <div className="text-sm opacity-90">{p.memo}</div>}
                    {p.txHash && <TxLink hash={p.txHash} className={mine ? "text-white underline" : undefined} />}
                  </div>
                )}
                {p && m.kind === "pay.receipt" && (
                  <div>
                    <div className="text-xs opacity-80">✅ 已付款</div>
                    <div className="text-lg font-semibold">{p.amount} TWDC</div>
                    {p.txHash && <TxLink hash={p.txHash} className={mine ? "text-white underline" : undefined} />}
                  </div>
                )}
                <div className={cx("mt-0.5 text-[10px]", mine ? "text-white/70" : "text-ink-3")}>
                  {new Date(m.ts).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      {peer !== SYSTEM && (
        <div className="sticky bottom-20 mt-3 space-y-2 rounded-2xl border border-line bg-surface p-2">
          {mode !== "text" && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-ink-2">{mode === "transfer" ? "轉帳金額" : "請求金額"}</span>
              <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" />
              <span className="text-sm text-ink-2">TWDC</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              className={cx("grid size-11 shrink-0 place-items-center rounded-xl border", mode === "transfer" ? "border-brand bg-brand-bg text-brand" : "border-line text-ink-2")}
              onClick={() => setMode(mode === "transfer" ? "text" : "transfer")}
              aria-label="轉帳給對方"
              title="轉帳給對方"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7 17L17 7M9 7h8v8" />
              </svg>
            </button>
            <button
              className={cx("grid size-11 shrink-0 place-items-center rounded-xl border", mode === "request" ? "border-brand bg-brand-bg text-brand" : "border-line text-ink-2")}
              onClick={() => setMode(mode === "request" ? "text" : "request")}
              aria-label="付款請求"
              title="向對方請求付款"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M17 7L7 17M15 17H7V9" />
              </svg>
            </button>
            <input
              className={inputCls}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendText()}
              placeholder={mode === "text" ? "輸入訊息" : "備註（例：午餐）"}
            />
            <Button onClick={sendText} busy={busy === "send"} disabled={mode === "text" ? !text.trim() : !amount}>
              {mode === "transfer" ? "轉帳" : "送出"}
            </Button>
          </div>
          {mode === "transfer" && <p className="px-1 text-xs text-ink-3">直接從你的錢包轉 TWDC 給對方；超過日常額度時需要實體卡確認。</p>}
        </div>
      )}
      {peer === SYSTEM && <Notice>AI 代理超過確認門檻時，會在這裡請你核准。</Notice>}
    </div>
  );
}
