import { randomBytes } from "crypto";
import { isHex, type Hex } from "viem";
import { clientIp } from "@/server/ratelimit";
import { handle, HttpError } from "@/server/session";
import { read, update } from "@/server/store";

const TTL = 10 * 60; // 秒
const perIp = new Map<string, { day: number; n: number }>();

/**
 * 新裝置建立配對 session（不需登入）：只存公鑰與裝置名稱，沒有任何秘密。
 * 既有裝置加入這把公鑰後回填身分地址，新裝置輪詢拿到地址即完成。
 */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { qx: Hex; qy: Hex; rpIdHash: Hex; name: string };
  if (![b.qx, b.qy, b.rpIdHash].every((v) => isHex(v) && v.length === 66)) throw new HttpError(400, "公鑰格式錯誤");
  const ip = clientIp(req);
  const day = Math.floor(Date.now() / 86_400_000);
  const c = perIp.get(ip);
  const n = c && c.day === day ? c.n + 1 : 1;
  if (n > 50) throw new HttpError(429, "配對請求過於頻繁，請稍後再試");
  perIp.set(ip, { day, n });

  const id = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + TTL;
  await update((s) => {
    const now = Date.now() / 1000;
    for (const [k, v] of Object.entries(s.pairings)) if (v.exp + 3600 < now) delete s.pairings[k];
    s.pairings[id] = { qx: b.qx, qy: b.qy, rpIdHash: b.rpIdHash, name: String(b.name ?? "新裝置").slice(0, 40), exp, createdAt: Date.now() };
  });
  return Response.json({ id, exp });
});

export const GET = handle(async (req: Request) => {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const p = (await read()).pairings[id];
  if (!p) throw new HttpError(404, "找不到配對請求");
  if (p.address) return Response.json({ status: "linked", address: p.address });
  if (p.exp * 1000 < Date.now()) return Response.json({ status: "expired" });
  return Response.json({ status: "waiting", exp: p.exp });
});
