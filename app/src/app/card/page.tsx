"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { ChannelType, DEPLOYMENT, KeyClass, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi, keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, publicClient } from "@/lib/client";
import { createCard, getCard, type CardInfo } from "@/lib/card-sim";
import { createChannelWithFunding, randomSalt, runOp, transferCall } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { CardBack, CardFront } from "@/components/cafeca-card";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, EyeToggle, Field, HIDDEN_AMOUNT, inputCls, Notice, Panel, TxLink, errMsg, fmtTwdc, useToast } from "@/components/ui";

export default function CardPage() {
  return (
    <AppShell title="CAFECA 卡">
      <CardBody />
    </AppShell>
  );
}

type Order = { id: string; used: boolean; issuedFor?: string; paidAt: number };

function CardBody() {
  const { wallet, chain, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [card, setCard] = useState<CardInfo | null>(null);
  const [bound, setBound] = useState(false);
  const [boundCards, setBoundCards] = useState<Hex[]>([]);
  const [shop, setShop] = useState<{ price: string; treasury: Address; orders: Order[] } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const w = wallet!;

  const load = useCallback(async () => {
    const c = await getCard();
    setCard(c?.info ?? null);
    const ids = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "keysOf", args: [w.address] });
    const cards: Hex[] = [];
    for (const id of ids) {
      const k = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [w.address, id] });
      if (k.keyClass === KeyClass.MASTER) cards.push(id);
    }
    setBoundCards(cards);
    setBound(!!c && cards.includes(c.info.keyId));
    setShop(await api<{ price: string; treasury: Address; orders: Order[] }>("/api/card/order").catch(() => null));
  }, [w.address]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, chain.masterMode, chain.level]);

  const holderName = w.kycLeaves?.find((l) => l.field === "name")?.value ?? "CAFECA MEMBER";
  const paidOrder = shop?.orders.find((o) => !o.used);

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

  /** 付款：TWDC 轉給發卡方（在日常額度內，裝置金鑰即可），再把交易交給發卡方核對 */
  const pay = () =>
    wrap("pay", async () => {
      if (!shop) throw new Error("讀取售價失敗");
      const res = await runOp(w, transferCall(shop.treasury, parseUnits(shop.price, TWDC_DECIMALS)), confirmOnCard);
      await api("/api/card/order", { txHash: res.txHash });
      toast(<span>已付款 {shop.price} TWDC，卡片製作中 <TxLink hash={res.txHash} /></span>, "ok");
    });

  /** 卡片送達：發卡方確認已 KYC＋已付款後簽署卡片證明，再由你送出綁定（補發時同時汰換舊卡） */
  const issueAndBind = () =>
    wrap("card", async () => {
      const replacesKeyId = replacing ? boundCards[0] : undefined;
      // 補發：此瀏覽器的模擬器換成一張新卡
      const info = !replacing && card && !boundCards.includes(card.keyId) ? card : await createCard(holderName.toUpperCase());
      setCard(info);
      const att = await api<{ serialHash: Hex; replacesKeyId: Hex; issuerSig: Hex }>("/api/issuer/card", {
        qx: info.qx,
        qy: info.qy,
        rpIdHash: info.rpIdHash,
        replacesKeyId,
      });
      const callData = execCall(
        DEPLOYMENT.keyring,
        encodeFunctionData({
          abi: keyringValidatorAbi,
          functionName: "addMasterKey",
          args: [info.qx, info.qy, info.rpIdHash, att.serialHash, att.replacesKeyId, att.issuerSig],
        }),
      );
      const res = await runOp(w, callData, confirmOnCard);
      toast(<span>{replacing ? "新卡已綁定，舊卡已註銷" : "卡片已綁定，進入主金鑰模式"} <TxLink hash={res.txHash} /></span>, "ok");
      setReplacing(false);
    });

  const status = bound ? (
    <Badge tone="ok">已綁定 · 實體金鑰</Badge>
  ) : boundCards.length > 0 ? (
    <Badge tone="brand">已綁定（卡片不在此裝置）</Badge>
  ) : (
    <Badge>未持有</Badge>
  );

  return (
    <>
      <div className="grid grid-cols-1 gap-3">
        <CardFront holder={card?.holder ?? holderName.toUpperCase()} />
        {card && <CardBack holder={card.holder} cardNo={card.cardNo} />}
      </div>

      <Notice tone="warn">
        測試網以瀏覽器內的「卡片模擬器」代替實體卡：金鑰是不可匯出的 P-256，簽章格式與 CTXD 協定和實體卡相同。
      </Notice>

      {chain.level < 2 ? (
        <Panel title="購買 CAFECA 實體卡" action={<Badge>需先實名</Badge>}>
          <p className="mb-3 text-sm text-ink-2">
            實體卡是一把等級較高、不能被其他金鑰移除的硬體金鑰，只提供給完成實名驗證（證件＋臉部影像）的身分。
          </p>
          <Link href="/kyc" className="block"><Button className="w-full">先完成實名驗證</Button></Link>
        </Panel>
      ) : (
        <Panel title="CAFECA 實體卡" action={status}>
          {bound && !replacing ? (
            <p className="text-sm text-ink-2">
              大額轉帳、放寬額度、建立 AI 支出通道，都需要這張卡在螢幕上確認。你的裝置金鑰無法移除這張卡；手機遺失時，用卡片可以立即把新裝置加回身分。
            </p>
          ) : boundCards.length > 0 && !replacing ? (
            <>
              <p className="mb-3 text-sm text-ink-2">這個身分已綁定實體卡，但卡片（模擬器）不在此瀏覽器。實體卡以 NFC 感應即可使用。</p>
              <Button variant="secondary" className="w-full" onClick={() => setReplacing(true)}>卡片遺失？掛失補發</Button>
            </>
          ) : (
            <div className="space-y-3">
              {replacing && (
                <Notice tone="warn">掛失補發：新卡綁定時，舊卡會同時被註銷。這是唯一不需要舊卡本身就能移除卡片的方式，因此需要重新付款並由發卡方確認本人。</Notice>
              )}
              <ul className="space-y-1 text-sm text-ink-2">
                <li>・電子紙螢幕：簽署前顯示真正要簽的內容（所見即所簽）</li>
                <li>・指紋感應：私鑰不離開卡片晶片</li>
                <li>・Visa 感應付款、NFC 登入與恢復身分</li>
              </ul>
              <div className="flex items-center justify-between rounded-xl bg-surface-2 p-3">
                <span className="text-sm">售價</span>
                <span className="font-semibold">{shop ? fmtTwdc(parseUnits(shop.price, TWDC_DECIMALS), 0) : "—"} TWDC</span>
              </div>
              {!paidOrder ? (
                <Button className="w-full" onClick={pay} busy={busy === "pay"} disabled={!shop}>
                  付款購買
                </Button>
              ) : (
                <>
                  <Notice tone="ok">已付款，卡片已寄達（模擬）。請把卡片靠近手機完成綁定。</Notice>
                  <Button className="w-full" onClick={issueAndBind} busy={busy === "card"}>
                    {replacing ? "綁定新卡並註銷舊卡" : "綁定這張卡"}
                  </Button>
                </>
              )}
              {replacing && <Button variant="ghost" className="w-full" onClick={() => setReplacing(false)}>取消</Button>}
            </div>
          )}
        </Panel>
      )}

      {chain.masterMode && <VisaSection />}
    </>
  );
}

type Auth = { id: Hex; merchant: string; amount: string; status: string; captured?: string; txs: string[]; ts: number };

function VisaSection() {
  const { wallet, refresh, showBalance, setShowBalance } = useWallet();
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
      <Panel
        title="Visa 支出通道"
        action={
          <div className="flex items-center gap-1">
            <EyeToggle shown={showBalance} onToggle={() => setShowBalance(!showBalance)} className="text-ink-2 hover:bg-surface-2" />
            <Badge tone="ok">已開通</Badge>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-ink-3">可用</div>
            <div className="text-lg font-semibold">{!bal ? "—" : showBalance ? fmtTwdc(bal.available) : HIDDEN_AMOUNT}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-ink-3">授權鎖定中</div>
            <div className="text-lg font-semibold">{!bal ? "—" : showBalance ? fmtTwdc(bal.locked) : HIDDEN_AMOUNT}</div>
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
