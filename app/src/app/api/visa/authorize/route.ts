import { encodeFunctionData, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi } from "@/lib/contracts/abis";
import { execCall } from "@/lib/userop";
import { channelExec } from "@/server/channel";
import { env } from "@/server/env";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update } from "@/server/store";

/** 模擬 POS 刷卡：發卡處理商在 Visa 授權時呼叫 authorize 鎖定金額 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { amount, merchant } = (await req.json()) as { amount: string; merchant: string };
  const channel = (await read()).visaChannels[me] as Address | undefined;
  if (!channel) throw new HttpError(400, "尚未開通 Visa 卡通道");
  const value = parseUnits(amount, TWDC_DECIMALS);
  if (value <= 0n) throw new HttpError(400, "金額錯誤");
  const authId = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32)))) as Hex;
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
  const data = encodeFunctionData({
    abi: channelValidatorAbi,
    functionName: "authorize",
    args: [authId, value, expiry],
  });
  const res = await channelExec(channel, execCall(DEPLOYMENT.channelValidator, data), env.visaOperatorKey());
  await update((s) => {
    s.visa.unshift({
      id: authId,
      channel,
      owner: me,
      merchant: merchant || "模擬商店",
      amount: value.toString(),
      status: "authorized",
      txs: [res.txHash],
      ts: Date.now(),
    });
  });
  return Response.json({ authId, txHash: res.txHash });
});
