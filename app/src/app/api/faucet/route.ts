import { isAddress, type Address } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { testStableAbi } from "@/lib/contracts/abis";
import { operatorTx } from "@/server/chain";
import { explainRevert } from "@/server/bundler";
import { handle, HttpError } from "@/server/session";

/** 測試網 TWDC 領取（每地址每天一次，50,000 TWDC） */
export const POST = handle(async (req: Request) => {
  const { address } = (await req.json()) as { address: Address };
  if (!isAddress(address)) throw new HttpError(400, "地址格式錯誤");
  try {
    const r = await operatorTx({
      address: DEPLOYMENT.twdc,
      abi: testStableAbi,
      functionName: "faucet",
      args: [address],
    });
    return Response.json({ txHash: r.transactionHash });
  } catch (e) {
    const msg = explainRevert(e);
    throw new HttpError(400, msg.includes("TooSoon") ? "今天已經領過了，明天再來" : msg);
  }
});
