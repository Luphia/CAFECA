import { randomBytes } from "crypto";
import { handle, requireSession } from "@/server/session";
import { update } from "@/server/store";
import { ticketIssuer } from "@/server/tickets";

/** 測試網：發放兩張示範票券 */
export const POST = handle(async () => {
  const me = await requireSession();
  const now = Date.now();
  const day = 86_400_000;
  const issuer = ticketIssuer();
  await update((s) => {
    const mine = Object.values(s.tickets).filter((t) => t.owner.toLowerCase() === me.toLowerCase());
    if (mine.length >= 6) return;
    const id = () => randomBytes(8).toString("hex");
    s.tickets[id()] = { owner: me, kind: "event", title: "Boltchain Summit 2026", subtitle: "一般入場", venue: "台北流行音樂中心", startsAt: now + 14 * day, seat: "A 區 12 排 8 號", issuer, issuedAt: now };
    s.tickets[id()] = { owner: me, kind: "transit", title: "高鐵 台北 → 台中", subtitle: "標準車廂 · 對號座", venue: "台北車站 第 1 月台", startsAt: now + 3 * day, seat: "7 車 12A", issuer, issuedAt: now };
  });
  return Response.json({ ok: true });
});
