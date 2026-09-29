import { listAudit, verifyAudit } from "@/server/audit";
import { requireReviewer } from "@/server/kyc-review";
import { handle } from "@/server/session";

/** 稽核紀錄查詢與 hash 鏈驗證（GET ?action=&subject=&before=&limit=） */
export const GET = handle(async (req: Request) => {
  const who = await requireReviewer("audit", "admin");
  const q = new URL(req.url).searchParams;
  const [entries, chain] = await Promise.all([
    listAudit({ limit: Math.min(Number(q.get("limit")) || 100, 500), before: Number(q.get("before")) || undefined, action: q.get("action") || undefined, subject: q.get("subject") || undefined }),
    verifyAudit(),
  ]);
  return Response.json({ reviewer: who, chain, entries });
});
