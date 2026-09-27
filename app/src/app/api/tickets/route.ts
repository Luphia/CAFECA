import { getAddress } from "viem";
import { handle, requireSession } from "@/server/session";
import { read } from "@/server/store";
import { signTicket } from "@/server/tickets";

/** 我的票券（附發行方簽章，用來產生出示用 QR code） */
export const GET = handle(async () => {
  const me = getAddress(await requireSession());
  const all = Object.entries((await read()).tickets).filter(([, t]) => t.owner.toLowerCase() === me.toLowerCase());
  const tickets = await Promise.all(all.map(async ([id, t]) => ({ id, ...t, sig: await signTicket(id, me) })));
  tickets.sort((a, b) => a.startsAt - b.startsAt);
  return Response.json({ tickets });
});
