/** Passkey 圖示（人像＋鑰匙，對應 FIDO Alliance 的 passkey 標誌語意） */
export function PasskeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M2.5 20v-1a5.5 5.5 0 0 1 5.5-5.5h2.5" />
      <circle cx="17.5" cy="11.5" r="2.5" />
      <path d="M17.5 14v6.5l1.5-1.2-1-1.3 1-1.2-1.5-1" />
    </svg>
  );
}

/** QR code 掃描圖示 */
export function ScanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
    </svg>
  );
}

/** 身分證圖示（底部導覽中央按鈕） */
export function IdCardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <circle cx="8.5" cy="11" r="2.2" />
      <path d="M5.3 16.2c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3M14.5 10h4M14.5 13h3" />
    </svg>
  );
}
