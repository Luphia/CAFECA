"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import type { Address, Hex } from "viem";
import { DEPLOYMENT, KeyClass } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, publicClient } from "@/lib/client";
import { buildDeeplink } from "@/lib/deeplink";
import { AppShell } from "@/components/app-shell";
import { CafecaMark } from "@/components/cafeca-logo";
import { useWallet } from "@/components/wallet-provider";
import { Button, cx, errMsg, short, useToast } from "@/components/ui";

type Ticket = {
  id: string;
  kind: "event" | "transit" | "coupon";
  title: string;
  subtitle: string;
  venue: string;
  startsAt: number;
  seat?: string;
  sig: Hex;
};

export default function IdPage() {
  return (
    <AppShell title="身分證與票券">
      <IdBody />
    </AppShell>
  );
}

function IdBody() {
  const { wallet, chain, handle } = useWallet();
  const toast = useToast();
  const w = wallet!;
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const [keys, setKeys] = useState<{ devices: number; cards: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const rail = useRef<HTMLDivElement>(null);

  const loadTickets = useCallback(async () => {
    const r = await api<{ tickets: Ticket[] }>("/api/tickets");
    setTickets(r.tickets);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTickets().catch(() => undefined);
  }, [loadTickets]);

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

  const slides = ["id", ...tickets.map((t) => t.id), "add"];
  const current = slides[idx];
  const isFlipped = !!flipped[current];
  const flip = (key: string) => setFlipped((f) => ({ ...f, [key]: !f[key] }));

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const card = el.firstElementChild as HTMLElement | null;
    const step = card ? card.offsetWidth + 16 : el.clientWidth;
    const i = Math.round(el.scrollLeft / step);
    if (i !== idx && i >= 0 && i < slides.length) setIdx(i);
  };
  const go = (i: number) => {
    const el = rail.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (el && card) el.scrollTo({ left: i * (card.offsetWidth + 16), behavior: "smooth" });
  };

  const addDemo = async () => {
    setBusy(true);
    try {
      await api("/api/tickets/demo", {});
      await loadTickets();
      toast("已加入示範票券", "ok");
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  const name = w.kycLeaves?.find((l) => l.field === "name")?.value;
  const checks = [
    { ok: chain.level >= 2, label: "實名驗證（證件＋臉部影像）", href: "/kyc" },
    { ok: !!chain.guardian, label: "平台備援金鑰", href: "/kyc" },
    { ok: chain.masterMode, label: "CAFECA 實體卡", href: "/card" },
    { ok: (keys?.devices ?? 0) >= 2, label: `裝置金鑰 ${keys ? keys.devices : "—"} 把（建議至少 2 台）`, href: "/security" },
  ];

  return (
    <>
      <div
        ref={rail}
        onScroll={onScroll}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-[11%] pb-2 pt-1"
        aria-label="身分證與票券"
      >
        <Slide>
          <FlipCard flipped={!!flipped.id} onFlip={() => flip("id")} label="數位身分證"
            front={<IdFront name={name} handle={handle} level={chain.level} guardian={!!chain.guardian} card={chain.masterMode} createdAt={w.createdAt} address={w.address} />}
            back={<IdBack handle={handle} address={w.address} />}
          />
        </Slide>
        {tickets.map((t) => (
          <Slide key={t.id}>
            <FlipCard flipped={!!flipped[t.id]} onFlip={() => flip(t.id)} label={t.title}
              front={<TicketFront t={t} holder={handle ? `@${handle}` : short(w.address)} />}
              back={<TicketBack t={t} holder={w.address} />}
            />
          </Slide>
        ))}
        <Slide>
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[28px] border-2 border-dashed border-line p-6 text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-surface text-2xl text-ink-3">＋</div>
            <div className="text-[15px] font-semibold">票券</div>
            <p className="text-xs text-ink-3">活動門票、交通票券會在購買後出現在這裡，出示 QR 即可入場。</p>
            <Button variant="secondary" size="sm" onClick={addDemo} busy={busy}>加入示範票券</Button>
          </div>
        </Slide>
      </div>

      <div className="flex justify-center gap-1.5">
        {slides.map((s, i) => (
          <button key={s} aria-label={`第 ${i + 1} 張`} onClick={() => go(i)} className={cx("h-1.5 rounded-full transition-all", i === idx ? "w-6 bg-brand" : "w-1.5 bg-ink-3/50")} />
        ))}
      </div>

      {current !== "add" && (
        <Button className="w-full" onClick={() => flip(current)}>
          {isFlipped ? "翻回正面" : current === "id" ? "出示身分 QR code" : "出示票券 QR code"}
        </Button>
      )}

      {current === "id" && (
        <section className="rounded-3xl border border-line bg-surface p-4">
          <div className="mb-2 text-[15px] font-semibold">身分保護</div>
          <ul className="space-y-2">
            {checks.map((c) => (
              <li key={c.label}>
                <Link href={c.href} className="flex items-center gap-3 rounded-2xl bg-surface-2/60 p-3 hover:bg-surface-2">
                  <span className={cx("grid size-8 shrink-0 place-items-center rounded-full text-sm font-bold", c.ok ? "bg-ok-bg text-ok" : "bg-surface text-ink-3")}>{c.ok ? "✓" : "·"}</span>
                  <span className="flex-1 text-sm">{c.label}</span>
                  <span className="text-xs text-ink-3">{c.ok ? "已完成" : "設定 →"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Slide({ children }: { children: ReactNode }) {
  return <div className="aspect-[5/8] w-[78%] shrink-0 snap-center">{children}</div>;
}

/** 直式卡片，點擊或按鈕觸發 3D 翻轉到背面 */
function FlipCard({ front, back, flipped, onFlip, label }: { front: ReactNode; back: ReactNode; flipped: boolean; onFlip: () => void; label: string }) {
  return (
    <div className="flip h-full">
      <div
        role="button"
        tabIndex={0}
        aria-label={`${label}（點擊翻面）`}
        aria-pressed={flipped}
        onClick={onFlip}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onFlip())}
        className={cx("flip-inner cursor-pointer", flipped && "flipped")}
      >
        <div className="flip-face" aria-hidden={flipped}>{front}</div>
        <div className="flip-face flip-back" aria-hidden={!flipped}>{back}</div>
      </div>
    </div>
  );
}

function useQr(text: string) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: "M" }).then(setQr).catch(() => undefined);
  }, [text]);
  return qr;
}

function IdFront({ name, handle, level, guardian, card, createdAt, address }: { name?: string; handle: string | null; level: number; guardian: boolean; card: boolean; createdAt: number; address: Address }) {
  const initial = (name ?? handle ?? address.slice(2, 3)).slice(0, 1).toUpperCase();
  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-b from-[#40245f] via-[#2a1c4a] to-[#1b1432] p-5 text-white shadow-[0_24px_60px_-24px_rgba(239,93,168,0.6)]">
      <div className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-[#ef5da8]/35 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-16 size-56 rounded-full bg-[#f69a5a]/20 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <CafecaMark className="size-6" />
          <span className="text-[11px] font-semibold tracking-[0.22em]">CAFECA</span>
        </div>
        <span className="text-[10px] tracking-[0.2em] text-white/60">DIGITAL ID</span>
      </div>

      <div className="relative mt-6 flex flex-col items-center">
        <div className="rounded-full bg-gradient-to-br from-[#f69a5a] to-[#ef5da8] p-[3px]">
          <div className="grid size-24 place-items-center rounded-full bg-[#2a1c4a] text-4xl font-bold">{initial}</div>
        </div>
        <div className="mt-4 text-center text-[22px] font-bold tracking-wide">{name ?? (level >= 2 ? "已實名驗證" : "尚未實名")}</div>
        <div className="text-sm text-white/70">{handle ? `@${handle}` : "尚未設定代稱"}</div>
        <span className={cx("mt-3 rounded-full px-3 py-1 text-xs font-semibold", level >= 2 ? "bg-[#4fd8a2]/20 text-[#7ff0c1]" : "bg-white/10 text-white/70")}>
          {level >= 2 ? "L2 實名驗證" : "L0 未實名"}
        </span>
      </div>

      <dl className="relative mt-auto grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
        <Info k="建立於" v={new Date(createdAt).toLocaleDateString("zh-TW")} />
        <Info k="平台備援" v={guardian ? "已啟用" : "未啟用"} />
        <Info k="實體卡" v={card ? "已綁定" : "未持有"} />
        <Info k="身分地址" v={<span className="font-mono text-xs">{short(address, 4)}</span>} />
      </dl>
      <div className="relative mt-4 text-center text-[11px] text-white/50">點一下卡片出示 QR code</div>
    </div>
  );
}

function IdBack({ handle, address }: { handle: string | null; address: Address }) {
  const qr = useQr(buildDeeplink(handle ? { action: "id", handle } : { action: "id", address }));
  return (
    <div className="flex h-full flex-col items-center rounded-[28px] border border-white/10 bg-gradient-to-b from-[#2a1c4a] to-[#1b1432] p-5 text-white">
      <div className="flex w-full items-center justify-between">
        <CafecaMark className="size-6" />
        <span className="text-[10px] tracking-[0.2em] text-white/60">SHOW MY ID</span>
      </div>
      <div className="mt-6 text-lg font-semibold">出示我的身分</div>
      <div className="text-sm text-white/70">{handle ? `@${handle}` : short(address, 6)}</div>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="身分 QR code" className="mt-5 w-[82%] rounded-2xl bg-white p-2.5" data-testid="id-qr" />
      )}
      <p className="mt-auto text-center text-[11px] leading-relaxed text-white/60">對方掃描後可以加你為聯絡人、開始聊天或付款給你。QR code 不含任何個資。</p>
    </div>
  );
}

const TICKET_STYLE: Record<Ticket["kind"], { label: string; cls: string }> = {
  event: { label: "活動票券", cls: "from-[#f7709f] via-[#d9489b] to-[#7b3fb3]" },
  transit: { label: "交通票券", cls: "from-[#f69a5a] via-[#e0608a] to-[#8e3fa0]" },
  coupon: { label: "優惠券", cls: "from-[#4fd8a2] via-[#3aa0c8] to-[#5b4bd1]" },
};

function TicketFront({ t, holder }: { t: Ticket; holder: string }) {
  const st = TICKET_STYLE[t.kind];
  const d = new Date(t.startsAt);
  return (
    <div className={cx("relative flex h-full flex-col overflow-hidden rounded-[28px] bg-gradient-to-br p-5 text-white shadow-[0_24px_60px_-24px_rgba(239,93,168,0.6)]", st.cls)}>
      <div className="pointer-events-none absolute -right-12 -top-10 size-44 rounded-full bg-white/15" />
      <div className="relative flex items-center justify-between">
        <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-semibold">{st.label}</span>
        <CafecaMark className="size-5 opacity-90" />
      </div>
      <div className="relative mt-6 text-[26px] font-bold leading-tight">{t.title}</div>
      <div className="relative mt-1 text-sm text-white/80">{t.subtitle}</div>

      <div className="relative mt-6 grid grid-cols-2 gap-3 text-sm">
        <Info k="日期" v={d.toLocaleDateString("zh-TW", { month: "long", day: "numeric", weekday: "short" })} light />
        <Info k="時間" v={d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} light />
        <div className="col-span-2">
          <Info k="地點" v={t.venue} light />
        </div>
        {t.seat && (
          <div className="col-span-2">
            <Info k="座位" v={t.seat} light />
          </div>
        )}
      </div>

      <div className="relative -mx-5 mt-auto flex items-center">
        <span className="size-5 -translate-x-2.5 rounded-full bg-bg" />
        <div className="ticket-perf flex-1" />
        <span className="size-5 translate-x-2.5 rounded-full bg-bg" />
      </div>
      <div className="relative mt-3 flex items-end justify-between text-xs">
        <div>
          <div className="text-white/60">持有人</div>
          <div className="font-semibold">{holder}</div>
        </div>
        <div className="text-right text-white/70">點一下出示 QR</div>
      </div>
    </div>
  );
}

function TicketBack({ t, holder }: { t: Ticket; holder: Address }) {
  const qr = useQr(buildDeeplink({ action: "ticket", id: t.id, holder, sig: t.sig }));
  return (
    <div className="flex h-full flex-col items-center rounded-[28px] border border-line bg-surface p-5">
      <div className="text-xs text-ink-3">{TICKET_STYLE[t.kind].label}</div>
      <div className="mt-1 text-center text-lg font-semibold">{t.title}</div>
      {t.seat && <div className="text-sm text-ink-2">{t.seat}</div>}
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="票券 QR code" className="mt-5 w-[82%] rounded-2xl bg-white p-2.5" data-testid="ticket-qr" />
      )}
      <div className="mt-3 font-mono text-sm tracking-[0.2em] text-ink-2">{t.id.toUpperCase().replace(/(.{4})/g, "$1 ").trim()}</div>
      <p className="mt-auto text-center text-[11px] leading-relaxed text-ink-3">驗票人員掃描後，會確認發行方簽章與持有人是你本人的身分。</p>
    </div>
  );
}

function Info({ k, v, light }: { k: string; v: ReactNode; light?: boolean }) {
  return (
    <div>
      <dt className={cx("text-[11px]", light ? "text-white/60" : "text-white/50")}>{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
