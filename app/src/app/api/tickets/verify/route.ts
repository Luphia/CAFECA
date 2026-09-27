import { getAddress, isAddress, isHex } from "viem";
import { handle, HttpError } from "@/server/session";
import { read } from "@/server/store";
import { verifyTicket } from "@/server/tickets";

/** 驗票：確認發行方簽章與持有人（驗票端不需登入） */
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const id = q.get("t") ?? "";
  const holder = q.get("h") ?? "";
  const sig = q.get("s") ?? "";
  if (!/^[0-9a-f]{8,32}$/.test(id) || !isAddress(holder) || !isHex(sig)) throw new HttpError(400, "票券資料格式錯誤");
  const valid = await verifyTicket(id, getAddress(holder), sig);
  const t = (await read()).tickets[id];
  if (!valid || !t || t.owner.toLowerCase() !== holder.toLowerCase()) return Response.json({ valid: false });
  return Response.json({ valid: true, ticket: { title: t.title, subtitle: t.subtitle, venue: t.venue, startsAt: t.startsAt, seat: t.seat } });
});
