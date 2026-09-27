"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiItem, parseUnits, type Hex } from "viem";
import { Action, DEPLOYMENT, KeyClass, RecoveryPath, TWDC_DECIMALS } from "@/lib/config";
import { keyringValidatorAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api, clearWallet, publicClient, saveWallet } from "@/lib/client";
import { loadSchedules, removeSchedule, runOp, saveSchedule, scheduledReadyAt, type LocalSchedule } from "@/lib/actions";
import { getCard } from "@/lib/card-sim";
import { execCall } from "@/lib/userop";
import { registerPasskey } from "@/lib/webauthn";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, Field, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, short, useToast } from "@/components/ui";

type KeyRow = { keyId: Hex; keyClass: number; addedAt: number; label: string };

export default function SecurityPage() {
  return (
    <AppShell title="安全">
      <SecurityBody />
    </AppShell>
  );
}

function SecurityBody() {
  const { wallet, chain, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const router = useRouter();
  const w = wallet!;
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [schedules, setSchedules] = useState<(LocalSchedule & { live: number })[]>([]);
  const [limits, setLimits] = useState({ perTx: "", daily: "" });
  const [current, setCurrent] = useState<{ perTx: bigint; daily: bigint } | null>(null);
  const [recovery, setRecovery] = useState<{ path: number; readyAt: number } | null>(null);
  const [label, setLabel] = useState("我的筆電");
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    setNow(Math.floor(Date.now() / 1000));
    const card = await getCard();
    const ev = parseAbiItem("event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 keyClass)");
    const logs = await publicClient
      .getLogs({ address: DEPLOYMENT.keyring, event: ev, args: { account: w.address }, fromBlock: BigInt(DEPLOYMENT.startBlock) })
      .catch(() => []);
    const ids = [...new Set([...logs.map((l) => l.args.keyId!), ...w.passkeys.map((p) => p.keyId), ...(card ? [card.info.keyId] : [])])];
    const rows: KeyRow[] = [];
    for (const id of ids) {
      const k = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [w.address, id] });
      if (k.keyClass === KeyClass.NONE) continue;
      const local = w.passkeys.find((p) => p.keyId === id);
      rows.push({
        keyId: id,
        keyClass: k.keyClass,
        addedAt: Number(k.addedAt),
        label: local ? `${local.label}（此瀏覽器）` : card?.info.keyId === id ? "CAFECA 卡（此瀏覽器的模擬器）" : k.keyClass === KeyClass.MASTER ? "CAFECA 卡" : "Passkey",
      });
    }
    setKeys(rows);

    const [perTx, daily] = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "limits", args: [DEPLOYMENT.twdc, w.address] });
    setCurrent({ perTx, daily });

    const local = loadSchedules(w.address);
    const live = await Promise.all(local.map(async (s) => ({ ...s, live: await scheduledReadyAt(w.address, s.hash) })));
    setSchedules(live.filter((s) => s.live > 0));

    const [path, readyAt] = await publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [w.address] });
    setRecovery(path !== RecoveryPath.NONE ? { path, readyAt: Number(readyAt) } : null);
  }, [w]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => console.warn(e));
  }, [load, chain.masterMode, chain.recoveryPending]);

  const wrap = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const schedule = async (action: number, payload: Hex, labelText: string) => {
    const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "schedule", args: [action, payload] }));
    const res = await runOp(w, call, confirmOnCard);
    const hash = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], [action, payload]));
    saveSchedule({ hash, action, payload, label: labelText, readyAt: await scheduledReadyAt(w.address, hash), account: w.address });
    toast(<span>已排程，時間鎖到期後可執行 <TxLink hash={res.txHash} /></span>, "ok");
  };

  const addPasskey = () =>
    wrap("add", async () => {
      const pk = await registerPasskey(`cafeca-${Date.now().toString(36)}`, label || "新裝置");
      if (chain.masterMode) {
        const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "addDailyKey", args: [pk.qx, pk.qy, pk.rpIdHash] }));
        const res = await runOp(w, call, confirmOnCard);
        toast(<span>已新增 Passkey <TxLink hash={res.txHash} /></span>, "ok");
      } else {
        const payload = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [pk.qx, pk.qy, pk.rpIdHash]);
        await schedule(Action.ADD_DAILY, payload, `新增 Passkey「${pk.label}」`);
      }
      saveWallet({ ...w, passkeys: [...w.passkeys, pk] });
    });

  const removeKey = (k: KeyRow) =>
    wrap("rm" + k.keyId, async () => {
      if (chain.masterMode) {
        const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "removeKey", args: [k.keyId] }));
        const res = await runOp(w, call, confirmOnCard);
        toast(<span>已移除 <TxLink hash={res.txHash} /></span>, "ok");
      } else {
        await schedule(Action.REMOVE_KEY, encodeAbiParameters([{ type: "bytes32" }], [k.keyId]), `移除 ${k.label}`);
      }
    });

  const scheduleRemoveCardByPhone = (k: KeyRow) =>
    wrap("sch" + k.keyId, async () => {
      await schedule(Action.REMOVE_KEY, encodeAbiParameters([{ type: "bytes32" }], [k.keyId]), `移除 ${k.label}（72 小時）`);
    });

  const saveLimits = () =>
    wrap("limits", async () => {
      const perTx = parseUnits(limits.perTx || "0", TWDC_DECIMALS);
      const daily = parseUnits(limits.daily || "0", TWDC_DECIMALS);
      const lowering = current && perTx <= current.perTx && daily <= current.daily;
      if (lowering || chain.masterMode) {
        const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "setLimits", args: [DEPLOYMENT.twdc, perTx, daily] }));
        const res = await runOp(w, call, confirmOnCard);
        toast(<span>額度已更新 <TxLink hash={res.txHash} /></span>, "ok");
      } else {
        const payload = encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }], [DEPLOYMENT.twdc, perTx, daily]);
        await schedule(Action.SET_LIMITS, payload, `調升額度：單筆 ${limits.perTx}／每日 ${limits.daily}`);
      }
      setLimits({ perTx: "", daily: "" });
    });

  const execSchedule = (s: LocalSchedule) =>
    wrap("x" + s.hash, async () => {
      const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "executeScheduled", args: [s.action, s.payload] }));
      const res = await runOp(w, call, confirmOnCard);
      removeSchedule(s.hash);
      toast(<span>已執行 <TxLink hash={res.txHash} /></span>, "ok");
    });

  const cancelSchedule = (s: LocalSchedule) =>
    wrap("c" + s.hash, async () => {
      const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "cancel", args: [s.hash] }));
      const res = await runOp(w, call, confirmOnCard);
      removeSchedule(s.hash);
      toast(<span>已取消 <TxLink hash={res.txHash} /></span>, "ok");
    });

  const cancelRecovery = () =>
    wrap("cr", async () => {
      const call = execCall(DEPLOYMENT.recovery, encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "cancelRecovery", args: [] }));
      const res = await runOp(w, call, confirmOnCard);
      toast(<span>已取消恢復請求，轉出已解凍 <TxLink hash={res.txHash} /></span>, "ok");
    });

  const logout = async () => {
    await api("/api/auth/logout", {});
    clearWallet();
    router.replace("/");
  };

  return (
    <>
      <Panel title="身分">
        <dl className="space-y-1.5 text-sm">
          <Row k="登入方式" v={w.provider === "google" ? "Google" : w.provider === "apple" ? "Apple" : "測試網開發者登入"} />
          {w.email && <Row k="Email" v={w.email} />}
          <Row k="錢包地址" v={<span className="font-mono text-xs">{short(w.address, 8)}</span>} />
          <Row k="身分承諾" v={<span className="font-mono text-xs">{short(w.idCommitment, 8)}</span>} />
          <Row k="身分等級" v={chain.level >= 2 ? <Badge tone="ok">L2 實名</Badge> : <Badge>L0</Badge>} />
          <Row k="帳戶模式" v={chain.masterMode ? <Badge tone="brand">主金鑰模式</Badge> : <Badge>標準模式</Badge>} />
        </dl>
      </Panel>

      {recovery && (
        <Panel title="進行中的恢復" action={<Badge tone="danger">轉出凍結中</Badge>}>
          <p className="mb-3 text-sm text-ink-2">
            {recovery.path === RecoveryPath.R3_OIDC_ONLY ? "僅 OIDC 恢復（7 天）" : "重新 KYC 恢復（48 小時）"}，預計
            {new Date(recovery.readyAt * 1000).toLocaleString("zh-TW")} 生效。若非本人操作，請立即取消。
          </p>
          <Button variant="danger" className="w-full" onClick={cancelRecovery} busy={busy === "cr"}>取消恢復請求</Button>
        </Panel>
      )}

      <Panel title="金鑰">
        <ul className="divide-y divide-line">
          {keys.map((k) => (
            <li key={k.keyId} className="flex items-center justify-between py-2.5">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {k.label}
                  {k.keyClass === KeyClass.MASTER ? <Badge tone="brand">MASTER</Badge> : <Badge>DAILY</Badge>}
                </div>
                <div className="font-mono text-xs text-ink-3">{k.keyId.slice(0, 18)}… · {new Date(k.addedAt * 1000).toLocaleDateString("zh-TW")}</div>
              </div>
              {keys.length > 1 && (
                <div className="flex gap-1">
                  {chain.masterMode && k.keyClass === KeyClass.MASTER && (
                    <Button size="sm" variant="ghost" onClick={() => scheduleRemoveCardByPhone(k)} busy={busy === "sch" + k.keyId}>
                      排程移除
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => removeKey(k)} busy={busy === "rm" + k.keyId}>
                    {chain.masterMode ? "移除" : "排程移除"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Passkey 名稱" />
          <Button variant="secondary" onClick={addPasskey} busy={busy === "add"}>新增 Passkey</Button>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {chain.masterMode ? "主金鑰模式：用卡片確認後立即生效。" : "標準模式：新增金鑰需等待 24 小時時間鎖，期間任何金鑰都能取消。"}
        </p>
      </Panel>

      <Panel title="TWDC 額度">
        {current && (
          <p className="mb-3 text-sm text-ink-2">目前：單筆 {fmtTwdc(current.perTx)}／每日 {fmtTwdc(current.daily)}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="單筆上限">
            <input className={inputCls} value={limits.perTx} onChange={(e) => setLimits({ ...limits, perTx: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="每日上限">
            <input className={inputCls} value={limits.daily} onChange={(e) => setLimits({ ...limits, daily: e.target.value })} inputMode="decimal" />
          </Field>
        </div>
        <Button className="mt-3 w-full" variant="secondary" onClick={saveLimits} busy={busy === "limits"} disabled={!limits.perTx || !limits.daily}>
          更新額度
        </Button>
        <p className="mt-2 text-xs text-ink-3">調降立即生效；調升在主金鑰模式需卡片確認，標準模式需排程 24 小時。</p>
      </Panel>

      {schedules.length > 0 && (
        <Panel title="排程中的變更">
          <ul className="divide-y divide-line">
            {schedules.map((s) => {
              const ready = s.live <= now;
              return (
                <li key={s.hash} className="py-2.5">
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="text-xs text-ink-3">{ready ? "可執行" : `${new Date(s.live * 1000).toLocaleString("zh-TW")} 後可執行`}</div>
                  <div className="mt-2 flex gap-2">
                    {ready && s.action !== Action.MODULE && (
                      <Button size="sm" onClick={() => execSchedule(s)} busy={busy === "x" + s.hash}>執行</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => cancelSchedule(s)} busy={busy === "c" + s.hash}>取消</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <Notice>
        遺失手機時：主金鑰模式可用「卡片＋Google 登入」立即恢復；沒有卡片則需等待 7 天（期間轉出凍結，原裝置可取消）。
      </Notice>

      <Button variant="secondary" className="w-full" onClick={logout}>登出此裝置</Button>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
