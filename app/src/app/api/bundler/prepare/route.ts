import { isAddress, type Address, type Hex } from "viem";
import { prepareUserOp } from "@/server/bundler";
import { handle, HttpError } from "@/server/session";

export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { sender: Address; validator: Address; callData: Hex; initCode?: Hex };
  if (!isAddress(b.sender) || !isAddress(b.validator)) throw new HttpError(400, "地址格式錯誤");
  return Response.json(await prepareUserOp(b));
});
