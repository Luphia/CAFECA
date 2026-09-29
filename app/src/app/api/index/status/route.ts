import { indexStatus } from "@/server/indexer";
import { handle } from "@/server/session";

/** 索引同步狀態（監控用）：lastBlock 與鏈高差距過大代表同步停滯 */
export const GET = handle(async () => Response.json(await indexStatus(), { headers: { "cache-control": "no-store" } }));
