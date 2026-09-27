"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { open, type Box, type ChannelRequest } from "@/lib/channel";
import { channelKey, listChannels } from "@/lib/channel-store";
import { useWallet } from "./wallet-provider";

type Pending = { ch: string; id: string; host: string; title: string };

/**
 * 跨裝置簽章通道：錢包開啟時輪詢中繼信箱，有網站送來的請求就在畫面底部提示。
 * 標題是解密後網站提供的說明；點進去才看到錢包自行解析的實際內容。
 */
export function ChannelInbox() {
  const { wallet } = useWallet();
  const path = usePathname();
  const [items, setItems] = useState<Pending[]>([]);

  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    const tick = async () => {
      const chans = listChannels(wallet.address);
      if (!chans.length) return setItems([]);
      const r = await fetch(`/api/channel?ch=${chans.map((c) => c.id).join(",")}`).then((x) => x.json()).catch(() => null);
      if (!r || stop) return;
      const out: Pending[] = [];
      for (const c of chans) {
        for (const box of (r as Record<string, Box[]>)[c.id] ?? []) {
          if (c.seen.includes(box.id)) continue;
          try {
            const req = await open<ChannelRequest>(await channelKey(c), box, "req");
            out.push({ ch: c.id, id: box.id, host: new URL(c.domain).host, title: String(req.description?.title ?? "").slice(0, 60) });
          } catch {
            /* 解不開：不是這個網站送的，略過 */
          }
        }
      }
      if (!stop) setItems(out);
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [wallet]);

  if (!items.length || path?.startsWith("/dl/")) return null;
  const it = items[0];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <Link
        href={`/dl/sign?v=1&ch=${it.ch}&r=${it.id}`}
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-lg"
        data-testid="channel-inbox"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-bg text-brand">✍︎</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{it.host} 請求簽署</span>
          <span className="block truncate text-xs text-ink-3">{it.title}</span>
        </span>
        <span className="text-sm font-medium text-brand">查看{items.length > 1 ? `（${items.length}）` : ""}</span>
      </Link>
    </div>
  );
}
