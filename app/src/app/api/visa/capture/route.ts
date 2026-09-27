import { encodeFunctionData, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi } from "@/lib/contracts/abis";
import { execCall } from "@/lib/userop";
import { channelExec } from "@/server/channel";
import { env } from "@/server/env";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update } from "@/server/store";

/** 模擬清算：capture（可到授權金額 120%）或 release */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { id, amount, action } = (await req.json()) as { id: Hex; amount?: string; action: "capture" | "release" };
  const rec = (await read()).visa.find((v) => v.id === id && v.owner === me);
  if (!rec || rec.status !== "authorized") throw new HttpError(404, "找不到可處理的授權");
  const channel = rec.channel as Address;
  let data: Hex;
  let captured: bigint | undefined;
  if (action === "capture") {
    captured = parseUnits(amount ?? "0", TWDC_DECIMALS);
    data = encodeFunctionData({ abi: channelValidatorAbi, functionName: "capture", args: [id, captured] });
  } else {
    data = encodeFunctionData({ abi: channelValidatorAbi, functionName: "release", args: [channel, id] });
  }
  const res = await channelExec(channel, execCall(DEPLOYMENT.channelValidator, data), env.visaOperatorKey());
  await update((s) => {
    const v = s.visa.find((x) => x.id === id);
    if (!v) return;
    v.status = action === "capture" ? "captured" : "released";
    if (captured !== undefined) v.captured = captured.toString();
    v.txs.push(res.txHash);
  });
  return Response.json({ txHash: res.txHash });
});
