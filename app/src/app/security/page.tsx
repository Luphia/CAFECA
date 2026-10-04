"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, hexToBytes, type Hex } from "viem";
import { Action, DEPLOYMENT, KeyClass } from "@/lib/config";
import { keyringValidatorAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { publicClient, saveWallet } from "@/lib/client";
import { loadSchedules, removeSchedule, runOp, scheduledReadyAt, type LocalSchedule } from "@/lib/actions";
import { getCard } from "@/lib/card-sim";
import { execCall } from "@/lib/userop";
import { registerPasskey } from "@/lib/webauthn";
import { parseDeeplink, type PairLink } from "@/lib/deeplink";
import { PairApprove } from "@/components/pair-approve";
import { SignInHistory } from "@/components/signin-history";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { TermsSummary } from "@/components/terms-gate";
import { QrScanner } from "@/components/qr-scanner";
import { PasskeyIcon, ScanIcon } from "@/components/icons";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, short, useToast } from "@/components/ui";

type KeyRow = { keyId: Hex; keyClass: number; addedAt: number; label: string };

export default function SecurityPage() {
  return (
    <AppShell title="安全">
      <SecurityBody />
    </AppShell>
  );
}

function SecurityBody() {
  const { wallet, chain, refresh, logout: signOut } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const router = useRouter();
  const w = wallet!;
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [schedules, setSchedules] = useState<(LocalSchedule & { live: number })[]>([]);
  const [current, setCurrent] = useState<{ perTx: bigint; daily: bigint } | null>(null);
  const [recovery, setRecovery] = useState<{ readyAt: number; escalated: boolean } | null>(null);
  const [pairText, setPairText] = useState("");
  const [pairLink, setPairLink] = useState<PairLink | null>(null);
  const [scanning, setScanning] = useState(false);
  const [label, setLabel] = useState("我的筆電");
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    setNow(Math.floor(Date.now() / 1000));
    const card = await getCard();
    const ids = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "keysOf", args: [w.address] });
    const rows: KeyRow[] = [];
    for (const id of ids) {
      const k = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [w.address, id] });
      if (k.keyClass === KeyClass.NONE) continue;
      const local = w.passkeys.find((p) => p.keyId === id);
      rows.push({
        keyId: id,
        keyClass: k.keyClass,
        addedAt: Number(k.addedAt),
        label: local ? `${local.label}（此裝置）` : card?.info.keyId === id ? "CAFECA 實體卡（此瀏覽器的模擬器）" : k.keyClass === KeyClass.MASTER ? "CAFECA 實體卡" : "其他裝置",
      });
    }
    setKeys(rows);

    const [perTx, daily] = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "limits", args: [DEPLOYMENT.twdc, w.address] });
    setCurrent({ perTx, daily });

    const local = loadSchedules(w.address);
    const live = await Promise.all(local.map(async (s) => ({ ...s, live: await scheduledReadyAt(w.address, s.hash) })));
    setSchedules(live.filter((s) => s.live > 0));

    const [active, escalated, readyAt] = await publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [w.address] });
    setRecovery(active ? { readyAt: Number(readyAt), escalated } : null);
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


  /** 在這台瀏覽器再建立一把 passkey（例如另一個瀏覽器設定檔、或不同步的安全金鑰） */
  const addPasskey = () =>
    wrap("add", async () => {
      // userHandle 存身分地址：這把金鑰在任何裝置上都能直接登入此身分
      const pk = await registerPasskey(`CAFECA ${short(w.address)}`, label || "新裝置", hexToBytes(w.address));
      const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "addDailyKey", args: [pk.qx, pk.qy, pk.rpIdHash] }));
      const res = await runOp(w, call, confirmOnCard);
      saveWallet({ ...w, passkeys: [...w.passkeys, pk] });
      toast(<span>已新增 Passkey <TxLink hash={res.txHash} /></span>, "ok");
    });

  /** 共管：掃描新裝置的配對 QR（或貼上配對連結）→ 比對確認碼 → 加入（所有裝置金鑰同級） */
  const openPairLink = (text: string) => {
    try {
      const l = parseDeeplink(text, window.location.origin);
      if (l.action !== "pair") throw new Error("這不是裝置配對的 QR code");
      setScanning(false);
      setPairLink(l);
    } catch (e) {
      setScanning(false);
      toast(errMsg(e), "danger");
    }
  };
  const onScan = useCallback((text: string) => openPairLink(text), []); // eslint-disable-line react-hooks/exhaustive-deps

  const removeKey = (k: KeyRow) =>
    wrap("rm" + k.keyId, async () => {
      const call = execCall(DEPLOYMENT.keyring, encodeFunctionData({ abi: keyringValidatorAbi, functionName: "removeKey", args: [k.keyId] }));
      const res = await runOp(w, call, confirmOnCard);
      toast(<span>已移除 {k.label} <TxLink hash={res.txHash} /></span>, "ok");
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
    await signOut();
    router.replace("/start");
  };

  return (
    <>
      <Panel title="身分">
        <dl className="space-y-1.5 text-sm">
          <Row k="身分根" v="FIDO2 裝置金鑰（無第三方登入）" />
          <Row k="平台備援" v={chain.guardian ? <Badge tone="brand">已啟用</Badge> : <Badge>未啟用</Badge>} />
          <Row k="錢包地址" v={<span className="font-mono text-xs">{short(w.address, 8)}</span>} />
          <Row k="身分等級" v={chain.level >= 2 ? <Badge tone="ok">L2 實名</Badge> : <Badge>L0</Badge>} />
          <Row k="帳戶模式" v={chain.masterMode ? <Badge tone="brand">主金鑰模式</Badge> : <Badge>標準模式</Badge>} />
        </dl>
      </Panel>

      {recovery && (
        <Panel title="進行中的恢復" action={<Badge tone="danger">轉出凍結中</Badge>}>
          <p className="mb-3 text-sm text-ink-2">
            平台備援金鑰發起了恢復{recovery.escalated ? "（爭議升級，已經過平台人工複核）" : ""}，預計
            {new Date(recovery.readyAt * 1000).toLocaleString("zh-TW")} 生效，屆時所有裝置金鑰會被新裝置取代。若非本人操作，請立即取消。
          </p>
          <Button variant="danger" className="w-full" onClick={cancelRecovery} busy={busy === "cr"} disabled={recovery.escalated && !chain.masterMode}>
            {recovery.escalated ? "以實體卡取消恢復" : "取消恢復請求"}
          </Button>
          {recovery.escalated && <p className="mt-2 text-xs text-ink-3">升級恢復只有實體卡能取消。沒有卡片時請聯絡 CAFECA 客服，平台會以根金鑰輪替備援金鑰。</p>}
        </Panel>
      )}

      <Panel title="金鑰">
        <div className="mb-1 text-xs font-medium text-ink-3">裝置金鑰（每台裝置同級，可互相新增與移除）</div>
        <ul className="divide-y divide-line">
          {keys.filter((k) => k.keyClass === KeyClass.DAILY).map((k) => (
            <li key={k.keyId} className="flex items-center justify-between py-2.5">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">{k.label}<Badge>裝置</Badge></div>
                <div className="font-mono text-xs text-ink-3">{k.keyId.slice(0, 18)}… · {new Date(k.addedAt * 1000).toLocaleDateString("zh-TW")}</div>
              </div>
              {keys.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => removeKey(k)} busy={busy === "rm" + k.keyId}>移除</Button>
              )}
            </li>
          ))}
        </ul>

        <div className="mb-1 mt-4 text-xs font-medium text-ink-3">高等級金鑰（裝置金鑰無法移除）</div>
        <ul className="divide-y divide-line">
          {keys.filter((k) => k.keyClass === KeyClass.MASTER).map((k) => (
            <li key={k.keyId} className="py-2.5">
              <div className="flex items-center gap-2 text-sm font-medium">{k.label}<Badge tone="brand">實體卡</Badge></div>
              <div className="font-mono text-xs text-ink-3">{k.keyId.slice(0, 18)}… · 只有卡片本身或掛失補發能移除</div>
            </li>
          ))}
          <li className="py-2.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              平台備援金鑰{chain.guardian ? <Badge tone="brand">HSM 託管</Badge> : <Badge>未啟用</Badge>}
            </div>
            <div className="text-xs text-ink-3">
              {chain.guardian ? (
                <>
                  <span className="font-mono">{short(chain.guardian, 6)}</span> · 只能協助恢復，不能轉帳；任何裝置都能取消它發起的恢復
                </>
              ) : (
                <>完成實名驗證（證件＋臉部影像）後啟用。<Link href="/kyc" className="text-brand">前往驗證</Link></>
              )}
            </div>
          </li>
          {!keys.some((k) => k.keyClass === KeyClass.MASTER) && (
            <li className="py-2.5 text-xs text-ink-3">
              尚未持有實體卡。<Link href="/card" className="text-brand">了解 CAFECA 卡</Link>
            </li>
          )}
        </ul>
      </Panel>

      <Panel title="新增裝置">
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium">連結另一台裝置</div>
            <p className="mt-0.5 text-xs text-ink-2">
              在新裝置打開 CAFECA，選「連結既有身份」並建立 passkey，畫面會出現配對 QR code。用這台裝置掃描，確認兩邊的確認碼相同後加入。
            </p>
            {pairLink ? (
              <div className="mt-3">
                <PairApprove
                  link={pairLink}
                  onDone={() => {
                    setPairLink(null);
                    setPairText("");
                    load();
                  }}
                  onCancel={() => setPairLink(null)}
                />
              </div>
            ) : scanning ? (
              <div className="mt-3">
                <QrScanner onResult={onScan} onClose={() => setScanning(false)} />
              </div>
            ) : (
              <>
                <Button className="mt-2 w-full" onClick={() => setScanning(true)}>
                  <ScanIcon className="size-5" /> 掃描 QR code
                </Button>
                <div className="mt-2 flex gap-2">
                  <input
                    className={inputCls + " font-mono text-xs"}
                    value={pairText}
                    onChange={(e) => setPairText(e.target.value)}
                    placeholder="或貼上配對連結 https://…/dl/pair?…"
                  />
                  <Button variant="secondary" onClick={() => openPairLink(pairText)} disabled={!pairText.trim()}>開啟</Button>
                </div>
              </>
            )}
          </div>
          <div>
            <div className="text-sm font-medium">在此瀏覽器新增 Passkey</div>
            <div className="mt-2 flex gap-2">
              <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Passkey 名稱" />
              <Button variant="secondary" onClick={addPasskey} busy={busy === "add"}><PasskeyIcon className="size-4" />新增 Passkey</Button>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="公司帳戶">
        <p className="mb-3 text-sm text-ink-2">以商工登記驗證公司，和同事各自用自己的 Passkey 代公司轉帳、以公司身分登入網站。</p>
        <Link href="/company" className="block"><Button className="w-full" variant="secondary" testId="goto-company">管理公司帳戶</Button></Link>
      </Panel>

      <Panel title="TWDC 額度">
        {current ? (
          <div className="grid grid-cols-2 gap-3 text-sm" data-testid="limits">
            <div className="rounded-xl border border-line px-3 py-2.5">
              <div className="text-xs text-ink-3">單筆上限</div>
              <div className="font-semibold">{fmtTwdc(current.perTx)} TWDC</div>
            </div>
            <div className="rounded-xl border border-line px-3 py-2.5">
              <div className="text-xs text-ink-3">每日上限</div>
              <div className="font-semibold">{fmtTwdc(current.daily)} TWDC</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-3">讀取中…</p>
        )}
        <p className="mt-2 text-xs text-ink-3">交易額度由 CAFECA 依實名等級與風控設定，使用者無法自行調整；需要調升或調降請聯絡客服。超過日常額度的交易需要實體卡確認。</p>
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

      <SignInHistory account={w.address} />

      <DisclosurePanel w={w} />

      <TermsSummary />

      <Notice>
        遺失裝置時：還有其他裝置就直接移除遺失的那台；有實體卡可立即把新裝置加回；全部遺失時，用平台備援金鑰重新驗證本人（證件＋臉部影像），等待 48 小時（已綁卡 7 天）後生效。Passkey 若有雲端同步，換機後直接登入即可。
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
