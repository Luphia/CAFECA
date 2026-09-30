import { listAudit, verifyAudit } from "@/server/audit";
import { anchorAudit, verifyAnchors } from "@/server/audit-anchor";
import { requireReviewer, requireStaff, whoOf } from "@/server/kyc-review";
import { handle } from "@/server/session";

/** 稽核紀錄查詢與 hash 鏈驗證（GET ?action=&subject=&before=&limit=） */
export const GET = handle(async (req: Request) => {
  const who = await requireReviewer("audit", "admin");
  const q = new URL(req.url).searchParams;
  const [entries, chain, anchors] = await Promise.all([
    listAudit({ limit: Math.min(Number(q.get("limit")) || 100, 500), before: Number(q.get("before")) || undefined, action: q.get("action") || undefined, subject: q.get("subject") || undefined }),
    verifyAudit(),
    verifyAnchors(),
  ]);
  return Response.json({ reviewer: who, chain, anchors, entries });
});

/** 立即把目前的 hash 上鏈（admin；平常由每日排程執行） */
export const POST = handle(async () => {
  const me = await requireStaff("admin");
  return Response.json(await anchorAudit(whoOf(me)));
});
