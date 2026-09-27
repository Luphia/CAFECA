import { destroySession } from "@/server/session";

export async function POST() {
  await destroySession();
  return Response.json({ ok: true });
}
