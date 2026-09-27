"use client";

import Link from "next/link";
import { useWallet } from "./wallet-provider";
import { cx } from "./ui";

/** 首頁的主要按鈕：已在此裝置登入過就直接進錢包 */
export function LandingCta({ className, size = "lg" }: { className?: string; size?: "md" | "lg" }) {
  const { wallet, hydrated } = useWallet();
  const signedIn = hydrated && !!wallet;
  return (
    <div className={cx("flex flex-wrap gap-3", className)}>
      <Link
        href={signedIn ? "/wallet" : "/start"}
        className={cx(
          "brand-gradient inline-flex items-center justify-center rounded-xl font-semibold text-white shadow-sm transition active:scale-[0.98]",
          size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm",
        )}
      >
        {signedIn ? "進入我的錢包" : "免費建立數位身分"}
      </Link>
      {size === "lg" && (
        <a
          href="#keys"
          className="inline-flex h-12 items-center justify-center rounded-xl border border-line bg-surface px-6 text-base font-medium text-ink hover:bg-surface-2"
        >
          了解安全設計
        </a>
      )}
    </div>
  );
}
