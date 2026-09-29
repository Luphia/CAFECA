import { reviewerLogin } from "@/server/kyc-review";
import { handle } from "@/server/session";

export const POST = handle(async (req: Request) => {
  const { token, name } = (await req.json()) as { token?: string; name?: string };
  return Response.json({ reviewer: await reviewerLogin(String(token ?? ""), String(name ?? "")) });
});
