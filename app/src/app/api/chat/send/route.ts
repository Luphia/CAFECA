import { getAddress, isAddress } from "viem";
import { handle, HttpError, requireSession } from "@/server/session";
import { update, type ChatMessage } from "@/server/store";

/** 送出端對端加密訊息：伺服器只轉存密文，不持有任何解密金鑰 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const b = (await req.json()) as Pick<ChatMessage, "to" | "fromDevice" | "kind" | "envelopes">;
  if (!isAddress(b.to)) throw new HttpError(400, "收件人地址錯誤");
  if (!b.envelopes || Object.keys(b.envelopes).length === 0) throw new HttpError(400, "沒有可投遞的裝置");
  if (!["text", "pay.request", "pay.receipt", "pay.transfer", "file", "location"].includes(b.kind)) throw new HttpError(400, "訊息類型錯誤");
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    from: me,
    to: getAddress(b.to),
    fromDevice: b.fromDevice,
    kind: b.kind,
    envelopes: b.envelopes,
    ts: Date.now(),
  };
  await update((s) => {
    s.messages.push(msg);
  });
  return Response.json({ id: msg.id, ts: msg.ts });
});
