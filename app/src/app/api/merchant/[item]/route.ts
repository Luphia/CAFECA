import type { Hex } from "viem";
import { CATALOG, quote, verifyPayment, type ItemId } from "@/server/merchant";

/** x402 風格：沒有付款憑證回 402，附上 X-PAYMENT（交易雜湊）且驗證通過才回資源 */
export async function GET(req: Request, ctx: RouteContext<"/api/merchant/[item]">) {
  const { item } = await ctx.params;
  if (!(item in CATALOG)) return Response.json({ error: "not found" }, { status: 404 });
  const id = item as ItemId;
  const payment = req.headers.get("x-payment");
  if (!payment || !(await verifyPayment(payment as Hex, id))) {
    return Response.json(quote(id), { status: 402 });
  }
  return Response.json({ item: CATALOG[id].name, data: CATALOG[id].content() });
}
