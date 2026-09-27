import "server-only";
import type { Address, Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { prepareUserOp, sendUserOp } from "./bundler";
import { signerOf } from "./chain";
import { HttpError } from "./session";

/** 以通道操作者金鑰（AI 代理或發卡處理商）送出通道子帳戶的 UserOp */
export async function channelExec(channel: Address, callData: Hex, operatorKey: Hex) {
  const { userOp, userOpHash } = await prepareUserOp({
    sender: channel,
    validator: DEPLOYMENT.channelValidator,
    callData,
  });
  userOp.signature = await signerOf(operatorKey).signMessage({ message: { raw: userOpHash } });
  const res = await sendUserOp(userOp);
  if (!res.success) throw new HttpError(400, `通道交易執行失敗：${res.reason ?? "未知原因"}（${res.txHash}）`);
  return res;
}
