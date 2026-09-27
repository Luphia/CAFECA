import { CATALOG } from "@/server/merchant";
import { handle, requireSession } from "@/server/session";
import { read } from "@/server/store";

export const GET = handle(async () => {
  const owner = await requireSession();
  const s = await read();
  const agents = Object.entries(s.agents)
    .filter(([, a]) => a.owner === owner)
    .map(([id, a]) => ({ id, name: a.name, operator: a.operator, channel: a.channel ?? null, salt: a.salt, log: a.log, createdAt: a.createdAt }));
  const catalog = Object.entries(CATALOG).map(([id, it]) => ({ id, name: it.name, price: it.price.toString() }));
  return Response.json({ agents, catalog });
});
