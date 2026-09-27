import { getAddress, isAddress } from "viem";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update } from "@/server/store";

/** 使用者代稱（聊天用），僅存在伺服器，不上鏈 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { handle: h } = (await req.json()) as { handle: string };
  const handleName = (h ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(handleName)) throw new HttpError(400, "代稱需為 3–20 個英數字或底線");
  await update((s) => {
    const owner = s.handles[handleName];
    if (owner && owner !== me) throw new HttpError(409, "此代稱已被使用");
    const old = s.profiles[me]?.handle;
    if (old) delete s.handles[old];
    s.handles[handleName] = me;
    s.profiles[me] = { handle: handleName, iss: s.profiles[me]?.iss ?? "", createdAt: s.profiles[me]?.createdAt ?? Date.now() };
  });
  return Response.json({ handle: handleName });
});

/** 以代稱或地址查詢 */
export const GET = handle(async (req: Request) => {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  const s = await read();
  if (isAddress(q)) {
    const a = getAddress(q);
    return Response.json({ address: a, handle: s.profiles[a]?.handle ?? null });
  }
  const a = s.handles[q.replace(/^@/, "").toLowerCase()];
  if (!a) throw new HttpError(404, "找不到此代稱");
  return Response.json({ address: a, handle: s.profiles[a]?.handle ?? null });
});
