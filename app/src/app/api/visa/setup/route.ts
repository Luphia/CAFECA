import { signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { getSession } from "@/server/session";
import { read } from "@/server/store";

/** 發卡處理商資訊：建立 Visa 支出通道時使用 */
export async function GET() {
  const me = await getSession();
  const operator = signerOf(env.visaOperatorKey()).address;
  const s = await read();
  return Response.json({
    operator,
    settlement: operator, // 測試網：清算款直接進發卡處理商帳戶
    channel: me ? (s.visaChannels[me] ?? null) : null,
  });
}
