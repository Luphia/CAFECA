import { getAddress, isAddress } from "viem";
import { membersOf, Role, roleOf } from "@/server/entity";
import { handle, HttpError, requireSession } from "@/server/session";
import { read } from "@/server/store";

/** 法人帳戶成員（只有成員看得到）：地址、角色、代稱 */
export const GET = handle(async (req: Request) => {
  const me = await requireSession();
  const e = new URL(req.url).searchParams.get("entity") ?? "";
  if (!isAddress(e)) throw new HttpError(400, "法人帳戶地址錯誤");
  const entity = getAddress(e);
  if ((await roleOf(me, entity)) === Role.NONE) throw new HttpError(403, "你不是這個法人帳戶的成員");
  const s = await read();
  const list = await membersOf(entity);
  return Response.json({ members: list.map((m) => ({ ...m, handle: s.profiles[m.member]?.handle ?? null })) });
});
