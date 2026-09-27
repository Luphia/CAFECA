"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, parseUnits, type Address, type Hex } from "viem";
import { ChannelType, DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi } from "@/lib/contracts/abis";
import { api, publicClient } from "@/lib/client";
import { createChannelWithFunding, runOp, transferCall } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { AddrLink, Badge, Button, EyeToggle, Field, HIDDEN_AMOUNT, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, useToast } from "@/components/ui";

type Agent = {
  id: string;
  name: string;
  operator: Address;
  channel: Address | null;
  salt: Hex;
  log: { ts: number; text: string; tx?: string }[];
  createdAt: number;
};
type Item = { id: string; name: string; price: string };

export default function AgentsPage() {
  return (
    <AppShell title="AI 子錢包">
      <AgentsBody />
    </AppShell>
  );
}

function AgentsBody() {
  const { wallet, chain, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [catalog, setCatalog] = useState<Item[]>([]);
  const [form, setForm] = useState({ name: "研究助理", perTx: "500", daily: "1000", threshold: "300", days: "30", fund: "2000" });
  const [busy, setBusy] = useState(false);
  const w = wallet!;

  const load = useCallback(async () => {
    const r = await api<{ agents: Agent[]; catalog: Item[] }>("/api/agent/list");
    setAgents(r.agents);
    setCatalog(r.catalog);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => undefined);
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const a = await api<{ id: string; operator: Address; salt: Hex }>("/api/agent/new", { name: form.name });
      const policy = {
        token: DEPLOYMENT.twdc,
        perTxLimit: parseUnits(form.perTx, TWDC_DECIMALS),
        dailyLimit: parseUnits(form.daily, TWDC_DECIMALS),
        confirmThreshold: parseUnits(form.threshold, TWDC_DECIMALS),
        validUntil: Math.floor(Date.now() / 1000) + Number(form.days) * 86400,
        settlement: "0x0000000000000000000000000000000000000000" as Address,
      };
      const res = await createChannelWithFunding(
        w,
        { channelType: ChannelType.AGENT, operator: a.operator, policy, salt: a.salt, funding: parseUnits(form.fund, TWDC_DECIMALS) },
        confirmOnCard,
      );
      await api("/api/agent/register", { id: a.id });
      toast(<span>已建立「{form.name}」的支出通道 <TxLink hash={res.txHash} /></span>, "ok");
      await load();
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Notice tone="brand">
        每個 AI 代理有自己的子帳戶與政策：單筆、每日上限與確認門檻。超過門檻時，代理只能「請求」，必須由你用 CAFECA 卡在螢幕上核准。
      </Notice>

      {agents.map((a) => (
        <AgentCard key={a.id} agent={a} catalog={catalog} reload={load} />
      ))}

      <Panel title="新增 AI 代理">
        <div className="space-y-3">
          <Field label="名稱">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="單筆上限">
              <input className={inputCls} value={form.perTx} onChange={(e) => setForm({ ...form, perTx: e.target.value })} inputMode="decimal" />
            </Field>
            <Field label="每日上限">
              <input className={inputCls} value={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.value })} inputMode="decimal" />
            </Field>
            <Field label="確認門檻" hint="超過需你以卡片核准">
              <input className={inputCls} value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} inputMode="decimal" />
            </Field>
            <Field label="有效天數">
              <input className={inputCls} value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} inputMode="numeric" />
            </Field>
          </div>
          <Field label="初始撥款（TWDC）">
            <input className={inputCls} value={form.fund} onChange={(e) => setForm({ ...form, fund: e.target.value })} inputMode="decimal" />
          </Field>
          {chain.masterMode && <p className="text-xs text-ink-3">主金鑰模式下，建立通道需要卡片確認。</p>}
          <Button className="w-full" onClick={create} busy={busy}>建立代理與支出通道</Button>
        </div>
      </Panel>
    </>
  );
}

type Intent = { id: number; to: Address; amount: bigint; expiry: number; done: boolean };

function AgentCard({ agent, catalog, reload }: { agent: Agent; catalog: Item[]; reload: () => Promise<void> }) {
  const { wallet, refresh, showBalance, setShowBalance } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [state, setState] = useState<{
    balance: bigint;
    perTx: bigint;
    daily: bigint;
    threshold: bigint;
    validUntil: number;
    revoked: boolean;
    intents: Intent[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [topup, setTopup] = useState("1000");
  const w = wallet!;

  const load = useCallback(async () => {
    if (!agent.channel) return;
    const ch = agent.channel;
    const [bal, policy, cfg, count] = await Promise.all([
      publicClient.readContract({ address: DEPLOYMENT.twdc, abi: erc20Abi, functionName: "balanceOf", args: [ch] }),
      publicClient.readContract({ address: DEPLOYMENT.channelValidator, abi: channelValidatorAbi, functionName: "policyOf", args: [ch] }),
      publicClient.readContract({ address: DEPLOYMENT.channelValidator, abi: channelValidatorAbi, functionName: "configOf", args: [ch] }),
      publicClient.readContract({ address: DEPLOYMENT.channelValidator, abi: channelValidatorAbi, functionName: "intentCountOf", args: [ch] }),
    ]);
    const intents: Intent[] = [];
    for (let i = Number(count); i >= 1 && intents.length < 5; i--) {
      const [to, amount, expiry, done] = await publicClient.readContract({
        address: DEPLOYMENT.channelValidator,
        abi: channelValidatorAbi,
        functionName: "intents",
        args: [BigInt(i), ch],
      });
      if (!done && expiry * 1000 > Date.now()) intents.push({ id: i, to, amount, expiry, done });
    }
    setState({ balance: bal, perTx: policy[1], daily: policy[2], threshold: policy[3], validUntil: policy[4], revoked: cfg[3], intents });
  }, [agent.channel]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => undefined);
  }, [load]);

  const buy = async (item: Item) => {
    setBusy(item.id);
    try {
      const r = await api<{ status: string; steps: { text: string }[] }>("/api/agent/run", { id: agent.id, item: item.id });
      toast(r.status === "paid" ? `代理已購買「${item.name}」` : "超過門檻，代理已送出請求，等你以卡片核准", r.status === "paid" ? "ok" : "neutral");
      await Promise.all([reload(), load()]);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const approve = async (it: Intent) => {
    if (!agent.channel) return;
    setBusy("intent" + it.id);
    try {
      const callData = execCall(
        DEPLOYMENT.channelValidator,
        encodeFunctionData({
          abi: channelValidatorAbi,
          functionName: "approveIntent",
          args: [agent.channel, BigInt(it.id), DEPLOYMENT.twdc, it.to, it.amount],
        }),
      );
      const res = await runOp(w, callData, confirmOnCard);
      const item = catalog.find((c) => BigInt(c.price) === it.amount);
      if (item) await api("/api/agent/run", { id: agent.id, item: item.id, approvedTx: res.txHash });
      toast(<span>已核准 <TxLink hash={res.txHash} /></span>, "ok");
      await Promise.all([reload(), load()]);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!agent.channel) return;
    setBusy("revoke");
    try {
      const callData = execCall(
        DEPLOYMENT.channelValidator,
        encodeFunctionData({ abi: channelValidatorAbi, functionName: "revoke", args: [agent.channel] }),
      );
      const res = await runOp(w, callData, confirmOnCard);
      toast(<span>已撤銷，餘額已退回 <TxLink hash={res.txHash} /></span>, "ok");
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const doTopup = async () => {
    if (!agent.channel) return;
    setBusy("topup");
    try {
      const res = await runOp(w, transferCall(agent.channel, parseUnits(topup, TWDC_DECIMALS)), confirmOnCard);
      toast(<span>已撥款 <TxLink hash={res.txHash} /></span>, "ok");
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const pending = state?.intents ?? [];

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          🤖 {agent.name}
        </span>
      }
      action={state?.revoked ? <Badge tone="danger">已撤銷</Badge> : agent.channel ? <Badge tone="ok">運作中</Badge> : <Badge tone="warn">未完成</Badge>}
    >
      {agent.channel && state && (
        <>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <div className="flex items-center gap-1 text-xs text-ink-3">
                通道餘額
                <EyeToggle shown={showBalance} onToggle={() => setShowBalance(!showBalance)} className="size-6 hover:bg-surface-2" />
              </div>
              <div className="text-2xl font-semibold">
                {showBalance ? fmtTwdc(state.balance) : HIDDEN_AMOUNT} <span className="text-sm font-normal text-ink-3">TWDC</span>
              </div>
            </div>
            <AddrLink address={agent.channel} />
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">單筆</div><div className="font-semibold">{fmtTwdc(state.perTx)}</div></div>
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">每日</div><div className="font-semibold">{fmtTwdc(state.daily)}</div></div>
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">確認門檻</div><div className="font-semibold">{fmtTwdc(state.threshold)}</div></div>
          </div>

          {pending.map((it) => (
            <div key={it.id} className="mb-3 rounded-xl border border-brand/30 bg-brand-bg p-3">
              <div className="text-sm font-semibold text-brand">代理請求 #{it.id}：{fmtTwdc(it.amount)} TWDC</div>
              <div className="mt-0.5 text-xs text-ink-2">
                {catalog.find((c) => BigInt(c.price) === it.amount)?.name ?? "商家付款"} · 收款 <AddrLink address={it.to} />
              </div>
              <Button size="sm" className="mt-2" onClick={() => approve(it)} busy={busy === "intent" + it.id}>以卡片核准</Button>
            </div>
          ))}

          {!state.revoked && (
            <>
              <div className="mb-2 text-sm font-medium">指派任務：向 x402 商家購買</div>
              <div className="space-y-2">
                {catalog.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-xl border border-line p-2.5">
                    <div>
                      <div className="text-sm">{c.name}</div>
                      <div className="text-xs text-ink-3">
                        {fmtTwdc(c.price)} TWDC {BigInt(c.price) > state.threshold ? "· 超過門檻，需核准" : "· 代理可自行支付"}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => buy(c)} busy={busy === c.id}>執行</Button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input className={inputCls} value={topup} onChange={(e) => setTopup(e.target.value)} inputMode="decimal" />
                <Button variant="secondary" onClick={doTopup} busy={busy === "topup"}>撥款</Button>
                <Button variant="danger" onClick={revoke} busy={busy === "revoke"}>撤銷</Button>
              </div>
            </>
          )}
        </>
      )}

      {agent.log.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-ink-2">代理紀錄（{agent.log.length}）</summary>
          <ul className="mt-2 space-y-1.5">
            {agent.log.slice(0, 12).map((l, i) => (
              <li key={i} className="text-xs text-ink-2">
                <span className="text-ink-3">{new Date(l.ts).toLocaleTimeString("zh-TW")}</span> {l.text} {l.tx && <TxLink hash={l.tx} />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
