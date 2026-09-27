import "server-only";

/**
 * 建立身分不需要任何登入，為避免大量建立身分套取 gas 贊助，
 * 以來源 IP 限制每日建立數量（原型用記憶體計數；正式版改用 Redis 並加上裝置認證如 App Attest）。
 */
const hits = new Map<string, { day: number; count: number }>();

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export function allowIdentityCreation(ip: string): boolean {
  const max = Number(process.env.MAX_IDENTITIES_PER_IP_PER_DAY ?? 10);
  const day = Math.floor(Date.now() / 86_400_000);
  const h = hits.get(ip);
  if (!h || h.day !== day) {
    hits.set(ip, { day, count: 1 });
    return true;
  }
  if (h.count >= max) return false;
  h.count++;
  return true;
}
