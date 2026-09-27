import { getSession } from "@/server/session";
import { read } from "@/server/store";

export async function GET() {
  const address = await getSession();
  if (!address) return Response.json({ address: null });
  const s = await read();
  return Response.json({ address, handle: s.profiles[address]?.handle ?? null });
}
