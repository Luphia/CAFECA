"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { parseDeeplink, type Deeplink, type PairLink } from "@/lib/deeplink";
import { AppShell } from "@/components/app-shell";
import { PairApprove } from "@/components/pair-approve";
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
    if (!link || link.action === "pair") return;
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

function Standalone({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-10">
      <h1 className="text-2xl font-bold">{title}</h1>
      <Panel>{children}</Panel>
    </div>
  );
}
