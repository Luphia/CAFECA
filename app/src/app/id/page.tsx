"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { DEPLOYMENT, KeyClass } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/lib/client";
import { buildDeeplink } from "@/lib/deeplink";
import { AppShell } from "@/components/app-shell";
import { CafecaTile } from "@/components/cafeca-logo";
import { useWallet } from "@/components/wallet-provider";
import { Button, cx, short, useToast } from "@/components/ui";

export default function IdPage() {
  return (
    <AppShell title="數位身分證">
      <IdBody />
    </AppShell>
  );
}

function IdBody() {
  const { wallet, chain, handle } = useWallet();
  const toast = useToast();
  const w = wallet!;
  const [qr, setQr] = useState<string | null>(null);
  const [keys, setKeys] = useState<{ devices: number; cards: number } | null>(null);
  const name = w.kycLeaves?.find((l) => l.field === "name")?.value;
  const link = buildDeeplink(handle ? { action: "id", handle } : { action: "id", address: w.address });

  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 240 }).then(setQr).catch(() => undefined);
  }, [link]);

  useEffect(() => {
    (async () => {
      const ids = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "keysOf", args: [w.address] });
      let devices = 0;
      let cards = 0;
      for (const id of ids) {
        const k = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [w.address, id] });
        if (k.keyClass === KeyClass.DAILY) devices++;
        if (k.keyClass === KeyClass.MASTER) cards++;
      }
      setKeys({ devices, cards });
    })().catch(() => undefined);
  }, [w.address, chain.masterMode]);

  const checks = [
    { ok: chain.level >= 2, label: "實名驗證（證件＋臉部影像）", href: "/kyc" },
    { ok: !!chain.guardian, label: "平台備援金鑰", href: "/kyc" },
    { ok: chain.masterMode, label: "CAFECA 實體卡", href: "/card" },
    { ok: (keys?.devices ?? 0) >= 2, label: `裝置金鑰 ${keys ? keys.devices : "—"} 把（建議至少 2 台）`, href: "/security" },
  ];

  return (
    <>
      {/* 身分證卡面 */}
      <section className="relative overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-[#3b2462] via-[#2a1c4a] to-[#1d1535] p-5 text-white shadow-[0_20px_50px_-20px_rgba(239,93,168,0.55)]">
        <div className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-[#ef5da8]/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 size-48 rounded-full bg-[#f69a5a]/20 blur-3xl" />
        <div className="relative flex items-start justify-between">
          <div className="flex items-center gap-2">
            <CafecaTile className="size-9" />
            <div>
              <div className="text-[11px] tracking-[0.2em] text-white/60">CAFECA DIGITAL ID</div>
              <div className="text-sm font-semibold">數位身分證</div>
            </div>
          </div>
          <span className={cx("rounded-full px-2.5 py-1 text-xs font-semibold", chain.level >= 2 ? "bg-[#4fd8a2]/20 text-[#7ff0c1]" : "bg-white/10 text-white/70")}>
            {chain.level >= 2 ? "L2 實名" : "L0 未實名"}
          </span>
        </div>

        <div className="relative mt-6">
          <div className="text-[11px] text-white/50">姓名</div>
          <div className="text-xl font-bold tracking-wide">{name ?? "尚未實名"}</div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-[11px] text-white/50">代稱</div>
              <div className="font-medium">{handle ? `@${handle}` : "—"}</div>
            </div>
            <div>
              <div className="text-[11px] text-white/50">建立於</div>
              <div className="font-medium">{new Date(w.createdAt).toLocaleDateString("zh-TW")}</div>
            </div>
          </div>
          <button
            className="mt-4 rounded-full bg-white/10 px-3 py-1 font-mono text-xs hover:bg-white/20"
            onClick={() => {
              navigator.clipboard.writeText(w.address);
              toast("已複製身分地址", "ok");
            }}
          >
            {short(w.address, 8)} ⧉
          </button>
        </div>
      </section>

      {/* 出示身分 */}
      <section className="flex flex-col items-center gap-2 rounded-3xl border border-line bg-surface p-5">
        <div className="text-[15px] font-semibold">出示我的身分</div>
        {qr && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="身分 QR code" className="size-52 rounded-2xl bg-white p-2" />
        )}
        <p className="text-center text-xs text-ink-3">對方掃描後可以加你為聯絡人、開始聊天或付款給你。不包含任何個資。</p>
      </section>

      {/* 身分完整度 */}
      <section className="rounded-3xl border border-line bg-surface p-4">
        <div className="mb-2 text-[15px] font-semibold">身分保護</div>
        <ul className="space-y-2">
          {checks.map((c) => (
            <li key={c.label}>
              <Link href={c.href} className="flex items-center gap-3 rounded-2xl bg-surface-2/60 p-3 hover:bg-surface-2">
                <span className={cx("grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold", c.ok ? "bg-ok-bg text-ok" : "bg-surface text-ink-3")}>
                  {c.ok ? "✓" : "·"}
                </span>
                <span className="flex-1 text-sm">{c.label}</span>
                <span className="text-xs text-ink-3">{c.ok ? "已完成" : "設定 →"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {chain.level < 2 && (
        <Link href="/kyc" className="block">
          <Button className="w-full">完成實名驗證，啟用平台備援</Button>
        </Link>
      )}
    </>
  );
}
