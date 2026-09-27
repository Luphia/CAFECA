import { handle, requireSession } from "@/server/session";
import { read } from "@/server/store";

/** 取得與我相關的訊息（密文；只有持有裝置金鑰的瀏覽器能解開） */
export const GET = handle(async (req: Request) => {
  const me = (await requireSession()).toLowerCase();
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  const s = await read();
  const msgs = s.messages.filter((m) => (m.to.toLowerCase() === me || m.from.toLowerCase() === me) && m.ts > since);
  const peers = new Set<string>();
  msgs.forEach((m) => {
    const other = m.from.toLowerCase() === me ? m.to : m.from;
    if (other !== "system") peers.add(other);
  });
  const handles: Record<string, string | null> = {};
  peers.forEach((p) => {
    const key = Object.keys(s.profiles).find((k) => k.toLowerCase() === p.toLowerCase());
    handles[p.toLowerCase()] = key ? s.profiles[key].handle : null;
  });
  return Response.json({ messages: msgs, handles });
});
