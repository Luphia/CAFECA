import { getAddress, isAddress } from "viem";
import { transfersOf } from "@/server/indexer";
import { handle, HttpError } from "@/server/session";

/** 帳戶的 TWDC 轉帳紀錄（伺服器索引，新到舊）：?address=&limit=（≤ 200）&before=<區塊號> */
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const a = q.get("address") ?? "";
  if (!isAddress(a)) throw new HttpError(400, "地址格式錯誤");
  const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50) || 50));
  const before = q.get("before") ? Number(q.get("before")) : undefined;
  return Response.json(await transfersOf(getAddress(a), limit, before), { headers: { "cache-control": "no-store" } });
});
