import type { Address } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { channelValidatorAbi } from "@/lib/contracts/abis";
import { publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { handle, HttpError, requireSession } from "@/server/session";
import { update } from "@/server/store";

export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { channel } = (await req.json()) as { channel: Address };
  const [parent, operator, ctype] = await publicClient.readContract({
    address: DEPLOYMENT.channelValidator,
    abi: channelValidatorAbi,
    functionName: "configOf",
    args: [channel],
  });
  if (parent.toLowerCase() !== me.toLowerCase()) throw new HttpError(403, "不是你的通道");
  if (operator.toLowerCase() !== signerOf(env.visaOperatorKey()).address.toLowerCase() || ctype !== 1) {
    throw new HttpError(400, "不是 Visa 卡通道");
  }
  await update((s) => {
    s.visaChannels[me] = channel;
  });
  return Response.json({ ok: true });
});
