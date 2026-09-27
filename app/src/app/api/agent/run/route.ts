import type { Hex } from "viem";
import { claimAfterApproval, runPurchase } from "@/server/agent";
import { CATALOG, type ItemId } from "@/server/merchant";
import { handle, HttpError, requireSession } from "@/server/session";
import { read } from "@/server/store";

/** 指派任務給 AI 代理：購買商品；或在主人核准 intent 後取貨 */
export const POST = handle(async (req: Request) => {
  const owner = await requireSession();
  const b = (await req.json()) as { id: string; item: ItemId; approvedTx?: Hex };
  const rec = (await read()).agents[b.id];
  if (!rec || rec.owner !== owner) throw new HttpError(404, "找不到代理");
  if (!(b.item in CATALOG)) throw new HttpError(400, "未知商品");
  if (b.approvedTx) return Response.json(await claimAfterApproval(b.id, b.item, b.approvedTx));
  return Response.json(await runPurchase(b.id, rec, b.item));
});
