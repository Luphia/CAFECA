"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import { EXPLORER, TWDC_DECIMALS } from "@/lib/config";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  busy,
  type = "button",
  className,
  size = "md",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100",
        size === "sm" ? "h-9 px-3 text-sm" : "h-11 px-4 text-[15px]",
        variant === "primary" && "btn-primary text-white shadow-sm",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-brand hover:bg-brand-bg",
        variant === "danger" && "bg-danger-bg text-danger hover:opacity-90",
        className,
      )}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
      aria-hidden
    />
  );
}

export function Panel({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface p-4", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-[15px] outline-none placeholder:text-ink-3 focus:border-brand";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "danger" | "brand" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "ok" && "bg-ok-bg text-ok",
        tone === "warn" && "bg-warn-bg text-warn",
        tone === "danger" && "bg-danger-bg text-danger",
        tone === "brand" && "bg-brand-bg text-brand",
      )}
    >
      {children}
    </span>
  );
}

export function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" | "danger" | "ok" | "brand" }) {
  return (
    <div
      className={cx(
        "rounded-xl px-3 py-2.5 text-sm leading-relaxed",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "warn" && "bg-warn-bg text-warn",
        tone === "danger" && "bg-danger-bg text-danger",
        tone === "ok" && "bg-ok-bg text-ok",
        tone === "brand" && "bg-brand-bg text-brand",
      )}
    >
      {children}
    </div>
  );
}

export function short(a?: string | null, n = 4) {
  if (!a) return "";
  return `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
}

export function fmtTwdc(v: bigint | string | number, digits = 2) {
  const n = Number(formatUnits(BigInt(v), TWDC_DECIMALS));
  return n.toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function TxLink({ hash, label, className }: { hash: Hex | string; label?: string; className?: string }) {
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer" className={cx("font-mono text-xs underline-offset-2 hover:underline", className ?? "text-brand")}>
      {label ?? short(hash, 6)}
    </a>
  );
}

export function AddrLink({ address }: { address: Address | string }) {
  return (
    <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-ink-2 hover:text-brand">
      {short(address)}
    </a>
  );
}

// ───────────────────────── Toast ─────────────────────────

type Toast = { id: number; text: ReactNode; tone: "ok" | "danger" | "neutral" };
const ToastCtx = createContext<(text: ReactNode, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: ReactNode, tone: Toast["tone"] = "neutral") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "danger" ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] mx-auto flex max-w-md flex-col gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              "rise pointer-events-auto rounded-xl border px-3 py-2.5 text-sm shadow-lg",
              t.tone === "ok" && "border-ok/30 bg-ok-bg text-ok",
              t.tone === "danger" && "border-danger/30 bg-danger-bg text-danger",
              t.tone === "neutral" && "border-line bg-surface text-ink",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("NotAllowedError") || m.includes("The operation either timed out or was not allowed")) return "已取消或逾時";
  return m;
}

/** 隱藏金額時顯示的遮罩 */
export const HIDDEN_AMOUNT = "••••••";

/** 顯示／隱藏餘額的眼睛按鈕 */
export function EyeToggle({ shown, onToggle, className }: { shown: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? "隱藏餘額" : "顯示餘額"}
      aria-pressed={shown}
      className={cx("grid size-7 place-items-center rounded-full hover:bg-white/20", className)}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
        {!shown && <path d="M4 4l16 16" />}
      </svg>
    </button>
  );
}
