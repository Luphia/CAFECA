"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi, deviceDirectoryAbi } from "@/lib/contracts/abis";
import { api, passkeySigner, saveWallet, submitOp } from "@/lib/client";
import { decryptEnvelope, devicesOf, ensureDeviceKey, encryptFor, getDeviceKey } from "@/lib/chat-crypto";
import { runOp, transferCall } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, cx, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, short, useToast } from "@/components/ui";

type RawMsg = {
  id: string;
  from: string;
  to: string;
  fromDevice?: Hex;
  kind: "text" | "pay.request" | "pay.receipt" | "agent.intent" | "system";
  envelopes?: Record<string, { iv: string; ct: string }>;
  body?: Record<string, string>;
  ts: number;
};

type Payload = { text?: string; amount?: string; memo?: string; txHash?: Hex; requestId?: string };

const SYSTEM = "system";

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
  const decrypted = useRef<Set<string>>(new Set());

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

  const peers = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of msgs) {
      const other = m.from.toLowerCase() === me ? m.to.toLowerCase() : m.from.toLowerCase();
      map.set(other, Math.max(map.get(other) ?? 0, m.ts));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [msgs, me]);

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
    return <Thread peer={peer} msgs={msgs} plain={plain} handles={handles} onBack={() => setPeer(null)} onSent={poll} />;
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
        <input className={inputCls} value={newPeer} onChange={(e) => setNewPeer(e.target.value)} placeholder="輸入 @代稱 或地址開始聊天" />
        <Button variant="secondary" onClick={openPeer} disabled={!newPeer}>開始</Button>
      </div>

      <Panel>
        {peers.length === 0 ? (
          <p className="text-sm text-ink-3">還沒有對話</p>
        ) : (
          <ul className="divide-y divide-line">
            {peers.map((p) => {
              const last = [...msgs].reverse().find((m) => m.from.toLowerCase() === p || m.to.toLowerCase() === p);
              return (
                <li key={p}>
                  <button className="flex w-full items-center gap-3 py-3 text-left" onClick={() => setPeer(p)}>
                    <Avatar peer={p} handle={handles[p]} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{p === SYSTEM ? "CAFECA AI 通知" : handles[p] ? `@${handles[p]}` : short(p)}</div>
                      <div className="truncate text-sm text-ink-3">{last ? preview(last, plain[last.id]) : ""}</div>
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
  onBack,
  onSent,
}: {
  peer: string;
  msgs: RawMsg[];
  plain: Record<string, Payload | null>;
  handles: Record<string, string | null>;
  onBack: () => void;
  onSent: () => Promise<void>;
}) {
  const { wallet, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const me = wallet!.address.toLowerCase();
  const [text, setText] = useState("");
  const [payMode, setPayMode] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const thread = msgs.filter((m) => m.from.toLowerCase() === peer || m.to.toLowerCase() === peer).sort((a, b) => a.ts - b.ts);
  const paidRequests = new Set(thread.filter((m) => m.kind === "pay.receipt").map((m) => plain[m.id]?.requestId).filter(Boolean));

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length]);

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
    if (!text.trim()) return;
    setBusy("send");
    try {
      if (payMode) {
        parseUnits(amount, TWDC_DECIMALS);
        await send("pay.request", { amount, memo: text });
        setPayMode(false);
        setAmount("");
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
        {thread.map((m) => {
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
          {payMode && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-2">請求金額</span>
              <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal" />
              <span className="text-sm text-ink-2">TWDC</span>
            </div>
          )}
          <div className="flex gap-2">
            <button
              className={cx("grid size-11 shrink-0 place-items-center rounded-xl border", payMode ? "border-brand bg-brand-bg text-brand" : "border-line")}
              onClick={() => setPayMode(!payMode)}
              aria-label="付款請求"
            >
              $
            </button>
            <input
              className={inputCls}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendText()}
              placeholder={payMode ? "備註（例：午餐）" : "輸入訊息"}
            />
            <Button onClick={sendText} busy={busy === "send"} disabled={!text.trim() || (payMode && !amount)}>送出</Button>
          </div>
        </div>
      )}
      {peer === SYSTEM && <Notice>AI 代理超過確認門檻時，會在這裡請你核准。</Notice>}
    </div>
  );
}
