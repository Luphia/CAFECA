"use client";

import { useCallback, useState } from "react";
import { parseRecipient } from "@/lib/deeplink";
import { ScanIcon } from "./icons";
import { QrScanner } from "./qr-scanner";
import { cx, errMsg, inputCls, useToast } from "./ui";

/**
 * 地址／@代稱輸入框，右側附相機掃描按鈕。
 * 可掃描 CAFECA 收款 QR（pay 深連結，會一併帶出金額）、身分 QR（id）、EIP-681 或純地址。
 */
export function AddressInput({
  value,
  onChange,
  onScanAmount,
  placeholder = "@代稱 或 0x…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 掃到的付款請求帶有金額時呼叫（最小單位） */
  onScanAmount?: (amount: bigint) => void;
  placeholder?: string;
  className?: string;
}) {
  const [scanning, setScanning] = useState(false);
  const toast = useToast();

  const onResult = useCallback(
    (text: string) => {
      setScanning(false);
      try {
        const r = parseRecipient(text, window.location.origin);
        onChange(r.to);
        if (r.amount !== undefined) onScanAmount?.(r.amount);
        toast("已帶入掃描到的收款人", "ok");
      } catch (e) {
        toast(errMsg(e), "danger");
      }
    },
    [onChange, onScanAmount, toast],
  );

  return (
    <>
      <div className={cx("relative flex-1", className)}>
        <input className={inputCls + " pr-12"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        <button
          type="button"
          onClick={() => setScanning(true)}
          aria-label="掃描 QR code"
          title="掃描 QR code"
          className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-ink-2 hover:bg-surface hover:text-brand"
        >
          <ScanIcon className="size-5" />
        </button>
      </div>
      {scanning && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" role="dialog" aria-label="掃描 QR code">
          <div className="rise w-full max-w-sm rounded-3xl border border-line bg-surface p-4">
            <div className="mb-3 text-[15px] font-semibold">掃描收款人 QR code</div>
            <QrScanner onResult={onResult} onClose={() => setScanning(false)} hint="將收款 QR 或身分 QR 放進框內" />
          </div>
        </div>
      )}
    </>
  );
}
