import { isAddress, type Address, type Hex } from "viem";
import { prepareUserOp } from "@/server/bundler";
import { allowIdentityCreation, clientIp } from "@/server/ratelimit";
import { handle, HttpError } from "@/server/session";

export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { sender: Address; validator: Address; callData: Hex; initCode?: Hex };
  if (!isAddress(b.sender) || !isAddress(b.validator)) throw new HttpError(400, "地址格式錯誤");
  if (b.initCode && b.initCode !== "0x" && !allowIdentityCreation(clientIp(req))) {
    throw new HttpError(429, "今天從這個網路建立的身分已達上限，請明天再試");
  }
  return Response.json(await prepareUserOp(b));
});
