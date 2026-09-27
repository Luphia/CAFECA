"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { ChannelType, DEPLOYMENT, KeyClass, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi, keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, publicClient, saveWallet } from "@/lib/client";
import { createCard, getCard, type CardInfo } from "@/lib/card-sim";
import { createChannelWithFunding, randomSalt, runOp, transferCall } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { CardBack, CardFront } from "@/components/cafeca-card";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, Field, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, useToast } from "@/components/ui";

export default function CardPage() {
  return (
    <AppShell title="CAFECA 卡">
      <CardBody />
    </AppShell>
  );
}

function CardBody() {
  const { wallet, chain, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [card, setCard] = useState<CardInfo | null>(null);
  const [bound, setBound] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [kyc, setKyc] = useState({ name: "", idNumber: "", birthday: "" });
  const w = wallet!;

  const load = useCallback(async () => {
    const c = await getCard();
    setCard(c?.info ?? null);
    if (c) {
      const k = await publicClient.readContract({
        address: DEPLOYMENT.keyring,
        abi: keyringValidatorAbi,
        functionName: "getKey",
        args: [w.address, c.info.keyId],
      });
      setBound(k.keyClass === KeyClass.MASTER);
    }
  }, [w.address]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, chain.masterMode]);

  const holderName = w.kycLeaves?.find((l) => l.field === "name")?.value ?? w.email ?? "CAFECA MEMBER";

  const doKyc = async () => {
    setBusy("kyc");
    try {
      const r = await api<{ leaves: NonNullable<typeof w.kycLeaves>; txHash: Hex }>("/api/kyc", kyc);
      saveWallet({ ...w, kycLeaves: r.leaves });
      toast(<span>已完成 L2 實名驗證 <TxLink hash={r.txHash} /></span>, "ok");
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const issueAndBind = async () => {
    setBusy("card");
    try {
      const info = card ?? (await createCard(holderName.toUpperCase()));
      setCard(info);
      const att = await api<{ serialHash: Hex; issuerSig: Hex }>("/api/issuer/card", {
        qx: info.qx,
        qy: info.qy,
        rpIdHash: info.rpIdHash,
      });
      const callData = execCall(
        DEPLOYMENT.keyring,
        encodeFunctionData({
          abi: keyringValidatorAbi,
          functionName: "addMasterKey",
          args: [info.qx, info.qy, info.rpIdHash, att.serialHash, att.issuerSig],
        }),
      );
      const res = await runOp(w, callData, confirmOnCard);
      toast(<span>卡片已綁定，進入主金鑰模式 <TxLink hash={res.txHash} /></span>, "ok");
      await refresh();
      await load();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-3">
        <CardFront holder={card?.holder ?? holderName.toUpperCase()} />
        {card && <CardBack holder={card.holder} cardNo={card.cardNo} />}
      </div>

      <Notice tone="warn">
        測試網以瀏覽器內的「卡片模擬器」代替實體卡：金鑰是不可匯出的 P-256，簽章格式與 CTXD 協定和實體卡相同。
      </Notice>

      {chain.level < 2 && (
        <Panel title="步驟 1：L2 實名驗證" action={<Badge>模擬 KYC</Badge>}>
          <p className="mb-3 text-sm text-ink-2">鏈上只寫入欄位的 Merkle root，原文與 salt 只存在你的裝置。</p>
          <div className="space-y-3">
            <Field label="姓名（英文，印在卡上）">
              <input className={inputCls} value={kyc.name} onChange={(e) => setKyc({ ...kyc, name: e.target.value })} placeholder="CHEN HUNG-JEN" />
            </Field>
            <Field label="身分證字號">
              <input className={inputCls} value={kyc.idNumber} onChange={(e) => setKyc({ ...kyc, idNumber: e.target.value.toUpperCase() })} placeholder="A123456789" />
            </Field>
            <Field label="生日">
              <input className={inputCls} type="date" value={kyc.birthday} onChange={(e) => setKyc({ ...kyc, birthday: e.target.value })} />
            </Field>
            <Button className="w-full" onClick={doKyc} busy={busy === "kyc"}>送出驗證</Button>
          </div>
        </Panel>
      )}

      <Panel
        title={chain.level < 2 ? "步驟 2：申請並綁定卡片" : "卡片狀態"}
        action={bound ? <Badge tone="ok">已綁定 · MASTER</Badge> : chain.masterMode ? <Badge tone="brand">已綁定其他卡</Badge> : <Badge>未綁定</Badge>}
      >
        {bound ? (
          <p className="text-sm text-ink-2">
            大額轉帳、新增裝置、建立或放寬支出通道，都需要這張卡在螢幕上確認。手機遺失時，卡片＋Google 登入可以立即恢復。
          </p>
        ) : chain.masterMode && !card ? (
          <Notice>這個錢包已綁定卡片，但卡片（模擬器）在另一個瀏覽器。</Notice>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-2">發卡方確認你的 L2 狀態後簽署卡片證明，再由你用手機 Passkey 送出綁定交易（第一張卡可以用手機綁定）。</p>
            <Button className="w-full" onClick={issueAndBind} busy={busy === "card"} disabled={chain.level < 2}>
              {card ? "綁定這張卡" : "申請 CAFECA 卡"}
            </Button>
          </>
        )}
      </Panel>

      {chain.masterMode && <VisaSection />}
    </>
  );
}

type Auth = { id: Hex; merchant: string; amount: string; status: string; captured?: string; txs: string[]; ts: number };

function VisaSection() {
  const { wallet, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const w = wallet!;
  const [setup, setSetup] = useState<{ operator: Address; settlement: Address; channel: Address | null } | null>(null);
  const [bal, setBal] = useState<{ available: bigint; locked: bigint } | null>(null);
  const [auths, setAuths] = useState<Auth[]>([]);
  const [pos, setPos] = useState({ merchant: "全家便利商店", amount: "350" });
  const [topup, setTopup] = useState("5000");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await api<{ operator: Address; settlement: Address; channel: Address | null }>("/api/visa/setup");
    setSetup(s);
    if (s.channel) {
      const [available, locked] = await Promise.all([
        publicClient.readContract({ address: DEPLOYMENT.channelValidator, abi: channelValidatorAbi, functionName: "available", args: [s.channel] }),
        publicClient.readContract({ address: DEPLOYMENT.channelValidator, abi: channelValidatorAbi, functionName: "lockedOf", args: [s.channel] }),
      ]);
      setBal({ available, locked });
      const l = await api<{ items: Auth[] }>("/api/visa/list");
      setAuths(l.items);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => undefined);
  }, [load]);

  const open = async () => {
    if (!setup) return;
    setBusy("open");
    try {
      const salt = randomSalt("visa");
      const policy = {
        token: DEPLOYMENT.twdc,
        perTxLimit: parseUnits("20000", TWDC_DECIMALS),
        dailyLimit: parseUnits("50000", TWDC_DECIMALS),
        confirmThreshold: 0n,
        validUntil: Math.floor(Date.now() / 1000) + 365 * 86400,
        settlement: setup.settlement,
      };
      const res = await createChannelWithFunding(
        w,
        { channelType: ChannelType.CARD, operator: setup.operator, policy, salt, funding: parseUnits("5000", TWDC_DECIMALS) },
        confirmOnCard,
      );
      await api("/api/visa/register", { channel: res.channel });
      toast(<span>Visa 卡通道已開通並儲值 5,000 TWDC <TxLink hash={res.txHash} /></span>, "ok");
      await load();
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const doTopup = async () => {
    if (!setup?.channel) return;
    setBusy("topup");
    try {
      const res = await runOp(w, transferCall(setup.channel, parseUnits(topup, TWDC_DECIMALS)), confirmOnCard);
      toast(<span>已儲值 <TxLink hash={res.txHash} /></span>, "ok");
      await load();
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const swipe = async () => {
    setBusy("swipe");
    try {
      const r = await api<{ txHash: Hex }>("/api/visa/authorize", pos);
      toast(<span>授權成功，已鎖定 {pos.amount} TWDC <TxLink hash={r.txHash} /></span>, "ok");
      await load();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const settle = async (a: Auth, action: "capture" | "release", amount?: string) => {
    setBusy(a.id + action);
    try {
      const r = await api<{ txHash: Hex }>("/api/visa/capture", { id: a.id, action, amount });
      toast(<span>{action === "capture" ? "已清算" : "已釋放"} <TxLink hash={r.txHash} /></span>, "ok");
      await load();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  if (!setup) return null;

  if (!setup.channel) {
    return (
      <Panel title="Visa 支付" action={<Badge>未開通</Badge>}>
        <p className="mb-3 text-sm text-ink-2">
          建立一個「Visa 卡支出通道」子帳戶：發卡處理商只能在通道內 authorize（鎖定）→ capture（扣款），單筆 20,000、每日 50,000 TWDC，碰不到主帳戶資金。
        </p>
        <Button className="w-full" onClick={open} busy={busy === "open"}>開通 Visa 並儲值 5,000 TWDC</Button>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="Visa 支出通道" action={<Badge tone="ok">已開通</Badge>}>
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-ink-3">可用</div>
            <div className="text-lg font-semibold">{bal ? fmtTwdc(bal.available) : "—"}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-ink-3">授權鎖定中</div>
            <div className="text-lg font-semibold">{bal ? fmtTwdc(bal.locked) : "—"}</div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <input className={inputCls} value={topup} onChange={(e) => setTopup(e.target.value)} inputMode="decimal" />
          <Button variant="secondary" onClick={doTopup} busy={busy === "topup"}>儲值</Button>
        </div>
      </Panel>

      <Panel title="刷卡模擬（POS）" action={<Badge tone="warn">模擬</Badge>}>
        <div className="space-y-3">
          <Field label="商店">
            <input className={inputCls} value={pos.merchant} onChange={(e) => setPos({ ...pos, merchant: e.target.value })} />
          </Field>
          <Field label="金額（TWDC）">
            <input className={inputCls} value={pos.amount} onChange={(e) => setPos({ ...pos, amount: e.target.value })} inputMode="decimal" />
          </Field>
          <Button className="w-full" onClick={swipe} busy={busy === "swipe"}>感應付款（Visa 授權）</Button>
        </div>
      </Panel>

      {auths.length > 0 && (
        <Panel title="Visa 交易">
          <ul className="divide-y divide-line">
            {auths.map((a) => (
              <li key={a.id} className="py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{a.merchant}</div>
                    <div className="text-xs text-ink-3">{new Date(a.ts).toLocaleString("zh-TW")}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">{fmtTwdc(a.captured ?? a.amount)}</div>
                    <Badge tone={a.status === "captured" ? "ok" : a.status === "released" ? "neutral" : "warn"}>
                      {a.status === "captured" ? "已清算" : a.status === "released" ? "已釋放" : "已授權"}
                    </Badge>
                  </div>
                </div>
                {a.status === "authorized" && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => settle(a, "capture", fmtTwdc(a.amount).replace(/,/g, ""))} busy={busy === a.id + "capture"}>
                      清算
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => settle(a, "release")} busy={busy === a.id + "release"}>
                      取消授權
                    </Button>
                  </div>
                )}
                <div className="mt-1 flex flex-wrap gap-2">
                  {a.txs.map((t) => (
                    <TxLink key={t} hash={t} />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
