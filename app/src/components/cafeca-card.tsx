"use client";

import type { ReactNode } from "react";
import { cx } from "./ui";

/** 卡片正面：依設計概念（紫→橘漸層、指紋感應器、感應標誌、VISA） */
export function CardFront({ className, holder, compact }: { className?: string; holder?: string; compact?: boolean }) {
  return (
    <div
      className={cx(
        "brand-gradient relative aspect-[1.586] w-full overflow-hidden rounded-[18px] text-white shadow-xl",
        className,
      )}
    >
      <svg className="absolute inset-0 size-full opacity-25" viewBox="0 0 320 200" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} x={20 + i * 60} y={-20 + (i % 2) * 40} width="34" height="180" rx="17" fill="none" stroke="white" strokeWidth="1.2" transform={`rotate(35 ${37 + i * 60} 90)`} />
        ))}
      </svg>
      <div className="absolute right-4 top-3.5 flex items-center gap-1.5">
        <FingerprintMark className="size-6" />
        <span className="text-[15px] font-semibold tracking-[0.18em]">CAFECA</span>
      </div>
      <Contactless className="absolute right-5 top-1/2 size-5 -translate-y-1/2 opacity-90" />
      <div className="absolute bottom-4 left-4">
        {!compact && holder && <div className="mb-1 text-[11px] uppercase tracking-widest opacity-90">{holder}</div>}
        <span className="text-xl font-black italic tracking-tight">VISA</span>
      </div>
      <div className="absolute bottom-4 right-5 grid size-10 place-items-center rounded-full border border-[#f7c27a]/70">
        <div className="size-5 rounded-[5px] bg-[#1c1420]/90" />
      </div>
    </div>
  );
}

/** 卡片背面：電子紙螢幕＋電源鍵（依設計概念，卡片具電池與螢幕） */
export function CardBack({ children, className, holder, cardNo }: { children?: ReactNode; className?: string; holder?: string; cardNo?: string }) {
  return (
    <div className={cx("relative aspect-[1.586] w-full overflow-hidden rounded-[18px] bg-white text-[#222] shadow-xl", className)}>
      <div className="absolute right-6 top-0 h-2 w-12 rounded-b-md bg-[#8e3fa0]" />
      <div className="absolute inset-x-4 top-5 bottom-12 overflow-hidden rounded-lg bg-epaper p-3 font-mono text-epaper-ink shadow-inner">
        {children ?? (
          <div className="text-xs leading-relaxed">
            <div className="font-semibold uppercase tracking-wide">{holder ?? "CAFECA MEMBER"}</div>
            {cardNo && <div className="mt-1 tracking-[0.2em]">{cardNo.replace(/(\d{4})/g, "$1 ").trim()}</div>}
          </div>
        )}
      </div>
      <div className="absolute bottom-3 left-4 text-[10px] text-[#8e3fa0]">0800-080-080</div>
      <svg className="absolute bottom-2.5 right-4 size-7 text-[#8e3fa0]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <path d="M17.7 6.3a8 8 0 1 1-11.4 0" />
        <path d="M12 2.5v8" />
      </svg>
    </div>
  );
}

export function FingerprintMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M6.5 5.2A8 8 0 0 1 19.8 10" />
      <path d="M4.2 9.5A8 8 0 0 0 4 12c0 2 .5 3.6 1.3 5" />
      <path d="M8 18.5c-.9-1.8-1.3-3.9-1.1-6a5 5 0 0 1 10 .5c0 1.2-.1 2.3-.4 3.4" />
      <path d="M12 12.5c0 3-.6 5.5-1.8 7.6" />
      <path d="M15.4 17.5c-.4 1.3-1 2.5-1.7 3.5" />
    </svg>
  );
}

export function Contactless({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8.5 8a6 6 0 0 1 0 8" />
      <path d="M12 5.5a10 10 0 0 1 0 13" />
      <path d="M15.5 3a14 14 0 0 1 0 18" />
    </svg>
  );
}
