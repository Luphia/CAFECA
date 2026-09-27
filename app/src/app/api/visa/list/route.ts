import { handle, requireSession } from "@/server/session";
import { read } from "@/server/store";

export const GET = handle(async () => {
  const me = await requireSession();
  const s = await read();
  return Response.json({ items: s.visa.filter((v) => v.owner === me).slice(0, 30) });
});
