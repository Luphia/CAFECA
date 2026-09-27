"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { formatUnits, zeroAddress, type Hex } from "viem";
import { DEPLOYMENT, OP_KIND_LABEL, TWDC_DECIMALS } from "@/lib/config";
import { cardSign, getCard } from "@/lib/card-sim";
import { ctxdOf, type CardConfirm } from "@/lib/client";
import type { TxSummary } from "@/lib/userop";
import { CardBack, Contactless, FingerprintMark } from "./cafeca-card";
import { Button, cx, short } from "./ui";

type Pending = {
  summaries: TxSummary[];
  challenge: Hex;
  title?: string;
  resolve: (v: Awaited<ReturnType<CardConfirm>>) => void;
  reject: (e: Error) => void;
};

const Ctx = createContext<CardConfirm>(async () => {
  throw new Error("CardProvider missing");
});

export function useCardConfirm() {
  return useContext(Ctx);
}

function amountText(token: string, amount: bigint) {
  if (amount === 2n ** 256n - 1n) return "無上限";
  if (token.toLowerCase() === DEPLOYMENT.twdc.toLowerCase()) {
    return `${Number(formatUnits(amount, TWDC_DECIMALS)).toLocaleString("zh-TW")} TWDC`;
  }
  if (token === zeroAddress) return `${formatUnits(amount, 18)} BOLT`;
  return `${amount.toString()} @${short(token)}`;
}

/** 卡片螢幕上的一行：把 TxSummary 轉成人看得懂的文字 */
export function summaryLine(s: TxSummary): { title: string; detail: string; warn?: boolean } {
  const label = OP_KIND_LABEL[s.kind] ?? `操作 ${s.kind}`;
  switch (s.kind) {
    case 1:
      return { title: `${label} ${amountText(s.token, s.token === zeroAddress ? s.amount : s.amount)}`, detail: `→ ${short(s.counterparty, 6)}` };
    case 2:
      return { title: `${label} ${amountText(s.token, s.amount)}`, detail: `給 ${short(s.counterparty, 6)}`, warn: true };
    case 3:
    case 4:
    case 5:
      return { title: label, detail: `金鑰指紋 ${s.extra.slice(2, 10).toUpperCase()}` };
    case 10:
      return { title: label, detail: `單筆 ${amountText(s.token, s.amount)}／每日 ${amountText(s.token, BigInt(s.extra))}` };
    case 11:
      return { title: label, detail: `每日上限 ${amountText(s.token, s.amount)}，操作者 ${short(s.counterparty)}` };
    case 12:
      return { title: label, detail: `通道 ${short(s.counterparty)}` };
    case 14:
      return { title: `${label} #${BigInt(s.extra)}`, detail: `${amountText(s.token, s.amount)} → ${short(s.counterparty, 6)}` };
    case 15:
      return { title: "⚠ " + label, detail: "安裝或移除帳戶模組", warn: true };
    case 18:
      return { title: label, detail: `新裝置金鑰 ${s.extra.slice(2, 10).toUpperCase()}` };
    case 19:
      return { title: label, detail: `備援金鑰 ${short(s.counterparty, 6)}` };
    case 0:
      return { title: "⚠ " + label, detail: `合約 ${short(s.counterparty, 6)}`, warn: true };
    default:
      return { title: label, detail: s.amount > 0n ? amountText(s.token, s.amount) : "" };
  }
}

export function CardProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<"tap" | "confirm" | "signing">("tap");
  const [err, setErr] = useState<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback<CardConfirm>(
    ({ summaries, challenge, title }) =>
      new Promise((resolve, reject) => {
        const p = { summaries, challenge, title, resolve, reject };
        pendingRef.current = p;
        setErr(null);
        setPhase("tap");
        setPending(p);
      }),
    [],
  );

  const close = (e?: Error) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (e && p) p.reject(e);
  };

  const tap = async () => {
    const card = await getCard();
    if (!card) {
      setErr("這個瀏覽器沒有 CAFECA 卡（模擬器）。請到「卡片」頁申請，或在綁卡的瀏覽器操作。");
      return;
    }
    setPhase("confirm");
  };

  const fingerprint = async () => {
    const p = pendingRef.current;
    if (!p) return;
    setPhase("signing");
    try {
      // 卡片自行由螢幕顯示的內容計算 ctxd
      const ctxd = ctxdOf(p.summaries);
      const res = await cardSign(p.challenge, ctxd);
      pendingRef.current = null;
      setPending(null);
      p.resolve(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("confirm");
    }
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm sm:items-center">
          <div className="rise w-full max-w-sm rounded-3xl bg-surface p-5 shadow-2xl">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-base font-semibold">{pending.title ?? "需要 CAFECA 卡確認"}</h3>
              <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-medium text-warn">卡片模擬器</span>
            </div>
            <p className="mb-4 text-sm text-ink-2">這是高風險操作。請核對卡片螢幕上的內容，確認無誤再按指紋。</p>

            <CardBack className="mx-auto max-w-[330px]">
              {phase === "tap" ? (
                <div className="grid h-full place-items-center text-center text-xs">
                  <div>
                    <Contactless className="mx-auto mb-1 size-6" />
                    等待感應…
                  </div>
                </div>
              ) : (
                <div className="flex h-full flex-col text-[11px] leading-snug">
                  <div className="mb-1 flex justify-between border-b border-black/20 pb-1 font-semibold">
                    <span>請確認 {pending.summaries.length} 筆操作</span>
                    <span>Boltchain</span>
                  </div>
                  <div className="flex-1 space-y-1 overflow-auto">
                    {pending.summaries.map((s, i) => {
                      const l = summaryLine(s);
                      return (
                        <div key={i}>
                          <div className={cx("font-semibold", l.warn && "underline")}>{l.title}</div>
                          {l.detail && <div>{l.detail}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardBack>

            {err && <p className="mt-3 text-sm text-danger">{err}</p>}

            <div className="mt-5 flex flex-col items-center gap-3">
              {phase === "tap" && (
                <Button className="w-full" onClick={tap}>
                  <Contactless className="size-5" /> 將卡片靠近手機
                </Button>
              )}
              {phase !== "tap" && (
                <button
                  onClick={fingerprint}
                  disabled={phase === "signing"}
                  className={cx(
                    "grid size-20 place-items-center rounded-full border-2 border-brand-3 text-brand transition",
                    phase === "confirm" && "pulse-ring",
                    phase === "signing" && "opacity-60",
                  )}
                  aria-label="按指紋確認"
                >
                  <FingerprintMark className="size-10" />
                </button>
              )}
              {phase === "confirm" && <span className="text-sm text-ink-2">內容正確？按下指紋感應器確認</span>}
              {phase === "signing" && <span className="text-sm text-ink-2">卡片簽署中…</span>}
              <button className="text-sm text-ink-3 hover:text-ink" onClick={() => close(new Error("已在卡片上取消"))}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
