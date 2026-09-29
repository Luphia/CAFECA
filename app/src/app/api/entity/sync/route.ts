import { hasEntity, monitorEntities } from "@/server/entity";
import { requireReviewer } from "@/server/kyc-review";
import { handle } from "@/server/session";

/**
 * 法人每日監控（排程呼叫，每天一次即可；20 小時內查過的法人會略過）：
 * 公司狀況改變 → 撤銷（原因碼 3）；代表人或登記事項變更 → 暫停（原因碼 4）
 */
export const POST = handle(async (req: Request) => {
  if (!hasEntity()) return Response.json({ supported: false, results: [] });
  // ?force=1：立即重新查詢全部法人（只給管理後台登入者）
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (force) await requireReviewer("kyc");
  return Response.json({ supported: true, results: await monitorEntities({ force }) });
});
