"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { parseDeeplink, type AuthLink, type Deeplink, type PairLink, type SignLink, type TicketLink } from "@/lib/deeplink";
import { api } from "@/lib/client";
import { AppShell } from "@/components/app-shell";
import { CafecaTile } from "@/components/cafeca-logo";
import { PairApprove } from "@/components/pair-approve";
import { SignInApprove } from "@/components/signin-approve";
import { ChannelApprove } from "@/components/channel-approve";
import { useWallet } from "@/components/wallet-provider";
import { Button, Notice, Panel, Spinner } from "@/components/ui";

/**
 * 深連結入口：https://<host>/dl/<action>?v=1&…（規範見 src/lib/deeplink.ts）
 * 只開啟並預填畫面，任何上鏈操作仍需使用者確認。
 */
export default function DeeplinkPage() {
  const router = useRouter();
  const { wallet, hydrated } = useWallet();
  const [link, setLink] = useState<Deeplink | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLink(parseDeeplink(window.location.href, window.location.origin));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!link || link.action === "pair" || link.action === "ticket" || link.action === "auth" || link.action === "sign") return;
    if (link.action === "recover") return router.replace(`/recover?address=${link.address}`);
    if (!hydrated) return;
    if (!wallet) return router.replace("/start");
    if (link.action === "pay") {
      const q = new URLSearchParams({ to: link.to });
      if (link.amount !== undefined) q.set("amt", link.amount.toString());
      router.replace(`/wallet?${q}`);
    } else if (link.action === "id") {
      router.replace(`/chat?with=${encodeURIComponent(link.address ?? `@${link.handle}`)}`);
    }
  }, [link, hydrated, wallet, router]);

  if (error) {
    return (
      <Standalone title="無法開啟連結">
        <Notice tone="danger">{error}</Notice>
      </Standalone>
    );
  }
  if (link?.action === "ticket") return <TicketVerify link={link} />;
  if (link?.action === "auth" && hydrated) return <AuthPage link={link} hasWallet={!!wallet} />;
  if (link?.action === "sign" && hydrated) return <SignPage link={link} hasWallet={!!wallet} />;
  if (!link || !hydrated || link.action !== "pair") {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6 text-brand" />
      </div>
    );
  }
  if (!wallet) {
    return (
      <Standalone title="加入新裝置">
        <Notice>這是新裝置的配對 QR code。請用<strong>已經登入 CAFECA 身分</strong>的裝置掃描；這台裝置目前沒有登入任何身分。</Notice>
        <Link href="/start" className="mt-3 block"><Button variant="secondary" className="w-full">前往 CAFECA</Button></Link>
      </Standalone>
    );
  }
  return <PairPage link={link} />;
}

function PairPage({ link }: { link: PairLink }) {
  const router = useRouter();
  return (
    <AppShell title="加入新裝置">
      <Panel title="有一台新裝置想加入你的身分">
        <PairApprove link={link} onCancel={() => router.replace("/security")} />
      </Panel>
    </AppShell>
  );
}

/** 第三方網站登入（規格 §15）：不經 AppShell，popup 視窗也能完整顯示 */
function AuthPage({ link, hasWallet }: { link: AuthLink; hasWallet: boolean }) {
  const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-8">
      <div className="flex items-center gap-2">
        <CafecaTile className="size-7" />
        <h1 className="text-lg font-bold">以 CAFECA 身分登入</h1>
      </div>
      <Panel>
        {hasWallet ? (
          <SignInApprove request={link.request} />
        ) : (
          <div className="space-y-3">
            <Notice>
              <span className="font-mono">{new URL(link.request.domain).host}</span> 想以 CAFECA 身分登入，但這台裝置還沒有登入 CAFECA。先建立或登入身分，完成後會回到這個畫面。
            </Notice>
            <Link href={`/start?next=${encodeURIComponent(next)}`} className="block">
              <Button className="w-full">建立或登入 CAFECA 身分</Button>
            </Link>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** 簽章通道請求（規格 §15.8） */
function SignPage({ link, hasWallet }: { link: SignLink; hasWallet: boolean }) {
  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-8">
      <div className="flex items-center gap-2">
        <CafecaTile className="size-7" />
        <h1 className="text-lg font-bold">網站請求簽署</h1>
      </div>
      <Panel>
        {hasWallet ? (
          <ChannelApprove channelId={link.channel} requestId={link.requestId} />
        ) : (
          <Notice>這台裝置沒有登入 CAFECA 身分，無法處理這個簽署請求。請在當初登入網站的裝置上開啟。</Notice>
        )}
      </Panel>
    </div>
  );
}

function Standalone({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-10">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Panel>{children}</Panel>
    </div>
  );
}

/** 驗票端：掃描持有人出示的票券 QR，向發行方確認簽章與持有人 */
function TicketVerify({ link }: { link: TicketLink }) {
  const [r, setR] = useState<{ valid: boolean; ticket?: { title: string; subtitle: string; venue: string; startsAt: number; seat?: string } } | null>(null);
  useEffect(() => {
    api<typeof r>(`/api/tickets/verify?t=${link.id}&h=${link.holder}&s=${link.sig}`).then(setR).catch(() => setR({ valid: false }));
  }, [link]);
  return (
    <Standalone title="驗票">
      {!r ? (
        <Spinner className="text-brand" />
      ) : r.valid && r.ticket ? (
        <div className="space-y-2">
          <Notice tone="ok">✓ 有效票券：發行方簽章正確，持有人相符</Notice>
          <div className="text-lg font-semibold">{r.ticket.title}</div>
          <div className="text-sm text-ink-2">{r.ticket.subtitle}{r.ticket.seat ? ` · ${r.ticket.seat}` : ""}</div>
          <div className="text-sm text-ink-2">{r.ticket.venue} · {new Date(r.ticket.startsAt).toLocaleString("zh-TW")}</div>
          <div className="font-mono text-xs text-ink-3">持有人 {link.holder}</div>
        </div>
      ) : (
        <Notice tone="danger">✕ 無效票券：簽章不符或持有人不正確</Notice>
      )}
    </Standalone>
  );
}
