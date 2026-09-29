"use client";

import { useEffect, useState } from "react";
import { parseUnits, type Address, type Hex } from "viem";
import { HANDLE_CHANGE_PRICE_TWDC, TWDC_DECIMALS } from "@/lib/config";
import { api } from "@/lib/client";
import { runOp, transferCall } from "@/lib/actions";
import { useCardConfirm } from "./card-provider";
import { useWallet } from "./wallet-provider";
import { Button, inputCls, Notice, Panel, TxLink, errMsg, useToast } from "./ui";

type Check = { handle: string; valid: boolean; available: boolean; current: string | null; price: string; treasury: Address; credit: string | null };

const norm = (v: string) => v.trim().replace(/^@+/, "").toLowerCase();

/**
 * 代稱：第一次設定免費，設定後固定顯示；變更需支付 150 TWDC。
 * 付款前先確認新代稱可用；付款成功但變更失敗時，付款會保留為額度，下次變更不必再付。
 */
export function HandlePanel() {
  const { wallet, handle, refreshSession } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);

  const h = norm(input);
  const formatOk = /^[a-z0-9_]{3,20}$/.test(h);

  // 輸入時檢查是否可用（延遲 300ms）
  useEffect(() => {
    if (!formatOk) return;
    const t = setTimeout(() => {
      api<Check>(`/api/profile?check=${encodeURIComponent(h)}`).then(setCheck).catch(() => setCheck(null));
    }, 300);
    return () => clearTimeout(t);
  }, [h, formatOk]);
  const fresh = check?.handle === h ? check : null;

  const hint = !input
    ? null
    : !formatOk
      ? "3–20 個英文小寫、數字或底線，不需輸入 @"
      : !fresh
        ? "檢查中…"
        : fresh.available
          ? `@${h} 可以使用`
          : `@${h} 已被使用`;

  const submit = async () => {
    setBusy(true);
    try {
      if (!formatOk) throw new Error("代稱需為 3–20 個英文小寫、數字或底線（不含 @）");
      const c = await api<Check>(`/api/profile?check=${encodeURIComponent(h)}`);
      if (!c.available) throw new Error(`@${h} 已被使用`);
      let txHash: Hex | undefined;
      if (handle && !c.credit) {
        const res = await runOp(wallet!, transferCall(c.treasury, parseUnits(c.price, TWDC_DECIMALS)), confirmOnCard);
        txHash = res.txHash;
        toast(<span>已支付 {c.price} TWDC <TxLink hash={res.txHash} /></span>, "ok");
      }
      await api("/api/profile", { handle: h, txHash });
      await refreshSession();
      toast(handle ? `代稱已變更為 @${h}` : "代稱已設定", "ok");
      setEditing(false);
      setInput("");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">@</span>
          <input
            className={`${inputCls} pl-7`}
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/^@+/, ""))}
            placeholder="例如 luphia"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="handle-input"
          />
        </div>
        <Button onClick={submit} busy={busy} disabled={!formatOk || (!!fresh && !fresh.available)} testId="handle-submit">
          {handle ? (check?.credit ? "變更" : `支付 ${HANDLE_CHANGE_PRICE_TWDC} TWDC 並變更`) : "設定"}
        </Button>
      </div>
      {hint && <div className={`mt-1.5 text-xs ${fresh && !fresh.available ? "text-danger" : "text-ink-3"}`} data-testid="handle-hint">{hint}</div>}
    </>
  );

  if (!handle) {
    return (
      <Panel title="設定你的代稱">
        <p className="mb-2 text-sm text-ink-2">朋友可以用 @代稱 找到你、轉帳給你。代稱設定後即固定，之後變更需支付 {HANDLE_CHANGE_PRICE_TWDC} TWDC。</p>
        {form}
      </Panel>
    );
  }

  return (
    <Panel title="你的代稱">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-lg font-semibold" data-testid="my-handle">@{handle}</span>
        {!editing && (
          <Button variant="secondary" onClick={() => setEditing(true)} testId="handle-change">
            變更
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 space-y-2">
          <Notice tone="warn">
            變更代稱需支付 {HANDLE_CHANGE_PRICE_TWDC} TWDC。舊代稱 @{handle} 會保留給你，其他人無法註冊；朋友需要改用新代稱找你。
          </Notice>
          {form}
          <button type="button" className="text-xs text-ink-3 underline" onClick={() => { setEditing(false); setInput(""); }}>
            取消
          </button>
        </div>
      )}
    </Panel>
  );
}
