"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { DEPLOYMENT } from "@/lib/config";
import { useWallet } from "./wallet-provider";
import { FingerprintMark } from "./cafeca-card";
import { Badge, Button, cx, Notice, Spinner, errMsg, useToast } from "./ui";

const TABS = [
  { href: "/wallet", label: "錢包", icon: "M3 7h18v12H3zM3 7l2-3h14l2 3M16 13h2" },
  { href: "/chat", label: "聊天", icon: "M4 5h16v11H8l-4 4z" },
  { href: "/agents", label: "AI", icon: "M12 3v3M5 9h14v10H5zM9 13h.01M15 13h.01M9 16h6" },
  { href: "/card", label: "卡片", icon: "M3 6h18v12H3zM3 10h18" },
  { href: "/security", label: "安全", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
];

export function AppShell({ children, title, requireSession = true }: { children: ReactNode; title: string; requireSession?: boolean }) {
  const { wallet, hydrated, session, chain, unlock } = useWallet();
  const router = useRouter();
  const path = usePathname();
  const toast = useToast();

  useEffect(() => {
    if (hydrated && !wallet) router.replace("/");
  }, [hydrated, wallet, router]);

  if (!hydrated || !wallet) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6 text-brand" />
      </div>
    );
  }

  const needUnlock = requireSession && !session;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="brand-gradient grid size-8 place-items-center rounded-lg text-white">
            <FingerprintMark className="size-5" />
          </div>
          <div>
            <div className="text-[15px] font-semibold leading-tight">{title}</div>
            <div className="text-[11px] text-ink-3">Boltchain 測試網</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {chain.masterMode ? <Badge tone="brand">主金鑰模式</Badge> : <Badge>標準模式</Badge>}
          {chain.level >= 2 ? <Badge tone="ok">L2</Badge> : <Badge>L0</Badge>}
        </div>
      </header>

      <main className="flex-1 space-y-4 px-4 pb-28 pt-4">
        {!DEPLOYMENT.deployed && <Notice tone="warn">合約尚未部署到測試網：請先執行 npm run deploy。</Notice>}
        {chain.recoveryPending && (
          <Notice tone="danger">
            帳戶有進行中的恢復請求，期間轉出已凍結。如果不是你本人發起，請到「安全」頁立即取消。
          </Notice>
        )}
        {needUnlock ? (
          <div className="rise mt-10 flex flex-col items-center gap-4 text-center">
            <div className="brand-gradient grid size-16 place-items-center rounded-2xl text-white">
              <FingerprintMark className="size-9" />
            </div>
            <div>
              <div className="text-lg font-semibold">解鎖錢包</div>
              <p className="mt-1 text-sm text-ink-2">用此裝置的 Passkey 簽署登入挑戰（ERC-1271）</p>
            </div>
            <Button
              onClick={async () => {
                try {
                  await unlock();
                } catch (e) {
                  toast(errMsg(e), "danger");
                }
              }}
            >
              以 Passkey 解鎖
            </Button>
          </div>
        ) : (
          children
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <ul className="grid grid-cols-5">
          {TABS.map((t) => {
            const active = path?.startsWith(t.href);
            return (
              <li key={t.href}>
                <Link href={t.href} className={cx("flex flex-col items-center gap-0.5 py-2.5 text-[11px]", active ? "text-brand" : "text-ink-3")}>
                  <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinejoin="round" strokeLinecap="round">
                    <path d={t.icon} />
                  </svg>
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
