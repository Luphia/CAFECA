import type { Address, Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { channelManagerAbi, channelValidatorAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update } from "@/server/store";

/** 主帳戶在鏈上建立通道後，登記給代理使用 */
export const POST = handle(async (req: Request) => {
  const owner = await requireSession();
  const { id } = (await req.json()) as { id: string };
  const rec = (await read()).agents[id];
  if (!rec || rec.owner !== owner) throw new HttpError(404, "找不到代理");
  const channel = (await publicClient.readContract({
    address: DEPLOYMENT.channelManager,
    abi: channelManagerAbi,
    functionName: "channelAddress",
    args: [owner, rec.salt as Hex],
  })) as Address;
  const [parent, operator] = await publicClient.readContract({
    address: DEPLOYMENT.channelValidator,
    abi: channelValidatorAbi,
    functionName: "configOf",
    args: [channel],
  });
  if (parent.toLowerCase() !== owner.toLowerCase() || operator.toLowerCase() !== rec.operator.toLowerCase()) {
    throw new HttpError(400, "鏈上找不到對應的通道");
  }
  await update((s) => {
    s.agents[id].channel = channel;
  });
  return Response.json({ channel });
});
