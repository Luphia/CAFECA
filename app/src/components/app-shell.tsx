"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { DEPLOYMENT } from "@/lib/config";
import { useWallet } from "./wallet-provider";
import { CafecaTile } from "./cafeca-logo";
import { IdCardIcon, PasskeyIcon } from "./icons";
import { Badge, Button, cx, Notice, Spinner, errMsg, useToast } from "./ui";

type Tab = { href: string; label: string; icon: string };
const LEFT: Tab[] = [
  { href: "/wallet", label: "錢包", icon: "M3 7h18v12H3zM3 7l2-3h14l2 3M16 13h2" },
  { href: "/chat", label: "聊天", icon: "M4 5h16v11H8l-4 4z" },
];
const RIGHT: Tab[] = [
  { href: "/card", label: "卡片", icon: "M3 6h18v12H3zM3 10h18" },
  { href: "/security", label: "安全", icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
];

/** 登入後的 App 使用深紫夜色主題（html.app-dark），離開 App 內頁時移除 */
function useAppTheme() {
  useEffect(() => {
    document.documentElement.classList.add("app-dark");
    return () => document.documentElement.classList.remove("app-dark");
  }, []);
}

export function AppShell({ children, title, requireSession = true }: { children: ReactNode; title: string; requireSession?: boolean }) {
  const { wallet, hydrated, session, chain, unlock, logout } = useWallet();
  const router = useRouter();
  const path = usePathname();
  const toast = useToast();
  useAppTheme();

  useEffect(() => {
    if (hydrated && !wallet) router.replace("/start");
  }, [hydrated, wallet, router]);

  if (!hydrated || !wallet) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6 text-brand" />
      </div>
    );
  }

  const needUnlock = requireSession && !session;

  const signOut = async () => {
    if (!window.confirm("確定要登出此裝置嗎？金鑰仍保留在裝置上，之後可以直接用 Passkey 登入。")) return;
    await logout();
    router.replace("/start");
  };

  return (
    <div className="app-glow min-h-dvh">
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <CafecaTile className="size-8" />
          <div>
            <div className="text-[15px] font-semibold leading-tight">{title}</div>
            <div className="text-[11px] text-ink-3">Boltchain 測試網</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {chain.masterMode ? <Badge tone="brand">主金鑰模式</Badge> : <Badge>標準模式</Badge>}
          {chain.level >= 2 ? <Badge tone="ok">L2</Badge> : <Badge>L0</Badge>}
          <button
            onClick={signOut}
            aria-label="登出"
            title="登出此裝置"
            className="ml-1 grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-danger"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H4" />
            </svg>
          </button>
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
            <CafecaTile className="size-16" />
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
              <PasskeyIcon className="size-5" /> 以 Passkey 解鎖
            </Button>
            <button className="text-sm text-ink-3 hover:text-brand" onClick={signOut}>
              不是你？登出並切換身分
            </button>
          </div>
        ) : (
          children
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-md px-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        <div className="relative grid grid-cols-5 items-end rounded-[26px] border border-line bg-surface/90 shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          {LEFT.map((t) => (
            <NavTab key={t.href} tab={t} active={!!path?.startsWith(t.href)} />
          ))}
          <div className="flex justify-center">
            <Link
              href="/id"
              aria-label="我的數位身分證"
              className={cx(
                "pill-gradient -mt-7 grid size-16 place-items-center rounded-full border-4 border-bg text-white transition active:scale-95",
                path?.startsWith("/id") && "ring-2 ring-brand/60",
              )}
            >
              <IdCardIcon className="size-8" />
            </Link>
          </div>
          {RIGHT.map((t) => (
            <NavTab key={t.href} tab={t} active={!!path?.startsWith(t.href)} />
          ))}
        </div>
      </nav>
    </div>
    </div>
  );
}

function NavTab({ tab, active }: { tab: Tab; active: boolean }) {
  return (
    <Link href={tab.href} className={cx("flex flex-col items-center gap-0.5 py-3 text-[11px]", active ? "text-brand" : "text-ink-3 hover:text-ink-2")}>
      <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
        <path d={tab.icon} />
      </svg>
      {tab.label}
    </Link>
  );
}
