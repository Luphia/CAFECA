import { requireCron, runMaintenance } from "@/server/maintenance";
import { handle } from "@/server/session";

/** 每日排程（deploy:server 建立）：同意請求逾期失效、保存期限清除 */
export const POST = handle(async (req: Request) => {
  requireCron(req);
  return Response.json(await runMaintenance("cron"));
});
