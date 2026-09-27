import { MAX_PENDING, type Box } from "@/lib/channel";

/**
 * 簽章通道中繼信箱（規格 §15.8）：只轉存端對端加密後的 Box，讀不到內容。
 * 通道 id 為 128-bit 隨機值，只有網站與使用者的錢包知道。資料放在記憶體，10 分鐘後自動清除。
 *
 * POST {op:"push",  box}        網站放入請求
 * POST {op:"reply", box}        錢包放入回應（同時移除請求）
 * POST {op:"close", ch}         關閉通道（之後的 push 回 410 channel_closed）
 * GET  ?ch=a,b                  錢包輪詢：各通道待處理的請求
 * GET  ?ch=a&r=<id>             錢包讀取單一請求
 * GET  ?ch=a&r=<id>&res=1       網站輪詢回應
 */
type Mailbox = { reqs: Map<string, { box: Box; at: number }>; res: Map<string, { box: Box; at: number }>; closedAt?: number };

const TTL = 10 * 60 * 1000;
const g = globalThis as unknown as { __cafecaRelay?: Map<string, Mailbox> };
const boxes = (g.__cafecaRelay ??= new Map());

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" };
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: CORS });

const CH = /^[0-9a-f]{32}$/;
const RID = /^[0-9a-f]{16,64}$/;

function sweep() {
  const now = Date.now();
  for (const [ch, m] of boxes) {
    for (const [k, v] of m.reqs) if (now - v.at > TTL) m.reqs.delete(k);
    for (const [k, v] of m.res) if (now - v.at > TTL) m.res.delete(k);
    if (!m.reqs.size && !m.res.size && (!m.closedAt || now - m.closedAt > 30 * 24 * 3600 * 1000)) boxes.delete(ch);
  }
}

function mailbox(ch: string) {
  let m = boxes.get(ch);
  if (!m) boxes.set(ch, (m = { reqs: new Map(), res: new Map() }));
  return m;
}

function validBox(b: Box | undefined): b is Box {
  return !!b && b.v === 1 && CH.test(b.ch) && RID.test(b.id) && typeof b.iv === "string" && typeof b.ct === "string" && b.ct.length < 96_000;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  sweep();
  const body = (await req.json().catch(() => null)) as { op?: string; box?: Box; ch?: string } | null;
  if (!body) return json({ error: "bad_request" }, 400);
  if (body.op === "close") {
    if (!body.ch || !CH.test(body.ch)) return json({ error: "bad_request" }, 400);
    const m = mailbox(body.ch);
    m.reqs.clear();
    m.closedAt = Date.now();
    return json({ ok: true });
  }
  if (!validBox(body.box)) return json({ error: "bad_request" }, 400);
  const m = mailbox(body.box.ch);
  if (body.op === "push") {
    if (m.closedAt) return json({ error: "channel_closed" }, 410);
    if (m.reqs.size >= MAX_PENDING && !m.reqs.has(body.box.id)) return json({ error: "too_many_pending" }, 429);
    m.reqs.set(body.box.id, { box: body.box, at: Date.now() });
    return json({ ok: true });
  }
  if (body.op === "reply") {
    m.reqs.delete(body.box.id);
    m.res.set(body.box.id, { box: body.box, at: Date.now() });
    return json({ ok: true });
  }
  return json({ error: "bad_request" }, 400);
}

export function GET(req: Request) {
  sweep();
  const q = new URL(req.url).searchParams;
  const chs = (q.get("ch") ?? "").split(",").filter((c) => CH.test(c)).slice(0, 50);
  const r = q.get("r");
  if (r) {
    if (chs.length !== 1 || !RID.test(r)) return json({ error: "bad_request" }, 400);
    const m = boxes.get(chs[0]);
    if (q.get("res")) {
      const v = m?.res.get(r);
      if (v) return json({ box: v.box });
      return json({ pending: !m?.closedAt, closed: !!m?.closedAt });
    }
    const v = m?.reqs.get(r);
    return v ? json({ box: v.box }) : json({ error: "not_found" }, 404);
  }
  const out: Record<string, Box[]> = {};
  for (const ch of chs) out[ch] = [...(boxes.get(ch)?.reqs.values() ?? [])].map((v) => v.box);
  return json(out);
}
