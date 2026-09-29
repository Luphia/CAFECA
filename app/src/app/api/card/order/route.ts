import { decodeEventLog, erc20Abi, isHex, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CARD_PRICE_TWDC, DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { publicClient } from "@/server/chain";
import { env } from "@/server/env";
import { effectiveLevel } from "@/server/identity";
import { handle, HttpError, requireSession } from "@/server/session";
import { settleOrders } from "@/server/cards";
import { read, update } from "@/server/store";

/** 發卡方收款地址（測試網＝發卡方簽章金鑰的地址） */
function treasury() {
  return privateKeyToAccount(env.cardIssuerKey()).address;
}

export const GET = handle(async () => {
  const me = await requireSession();
  const orders = await settleOrders(me);
  return Response.json({ price: CARD_PRICE_TWDC, treasury: treasury(), orders });
});

/**
 * 購買實體卡：使用者先以 UserOp 付款（TWDC → 發卡方），再把交易雜湊交給發卡方核對。
 * 只有完成 L2 KYC 的身分可以購買。
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { txHash } = (await req.json()) as { txHash: Hex };
  if (!isHex(txHash) || txHash.length !== 66) throw new HttpError(400, "交易雜湊格式錯誤");
  // 以 v2 的有效等級為準：撤銷、暫停、簽章者失效的身分不能購買或綁定實體卡
  const level = await effectiveLevel(me);
  if (level < 2) throw new HttpError(403, "需先完成實名驗證（證件＋臉部影像）才能購買實體卡");
  if ((await read()).cardOrders[txHash.toLowerCase()]) throw new HttpError(409, "這筆付款已經使用過");

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const price = parseUnits(CARD_PRICE_TWDC, TWDC_DECIMALS);
  const to = treasury().toLowerCase();
  const paid = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== DEPLOYMENT.twdc.toLowerCase()) return false;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === me.toLowerCase() && ev.args.to.toLowerCase() === to && ev.args.value >= price;
    } catch {
      return false;
    }
  });
  if (!paid) throw new HttpError(402, `找不到 ${CARD_PRICE_TWDC} TWDC 的付款紀錄`);
  const id = txHash.toLowerCase();
  await update((s) => {
    s.cardOrders[id] = { owner: me, txHash, amount: CARD_PRICE_TWDC, paidAt: Date.now(), used: false };
  });
  return Response.json({ id });
});
