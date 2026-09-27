import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { handle, HttpError, requireSession } from "@/server/session";
import { update } from "@/server/store";

/** 為 AI 代理產生操作者金鑰（測試網由伺服器代表 TEE 保管） */
export const POST = handle(async (req: Request) => {
  const owner = await requireSession();
  const { name } = (await req.json()) as { name: string };
  if (!name?.trim()) throw new HttpError(400, "請為代理命名");
  const pk = generatePrivateKey();
  const operator = privateKeyToAccount(pk).address;
  const id = crypto.randomUUID();
  const salt = keccak256(toHex(`agent|${id}`));
  await update((s) => {
    s.agents[id] = { owner, name: name.trim(), salt, operatorKey: pk, operator, createdAt: Date.now(), log: [] };
  });
  return Response.json({ id, operator, salt });
});
