import type { UserOp } from "@/lib/userop";
import { sendUserOp } from "@/server/bundler";
import { handle } from "@/server/session";

export const POST = handle(async (req: Request) => {
  const { userOp } = (await req.json()) as { userOp: UserOp };
  return Response.json(await sendUserOp(userOp));
});
