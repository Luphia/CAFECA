import { isAddress, getAddress } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { hasEntity, myEntities, registerEntity } from "@/server/entity";
import { handle, HttpError, requireSession } from "@/server/session";

/**
 * 法人帳戶（規格 §16.4）
 * GET  → 我所屬的法人帳戶與驗證狀態
 * POST { entity, displayName? } → 登記錢包剛建立的法人帳戶（鏈上確認呼叫者是成員）
 */
export const GET = handle(async () => {
  const me = await requireSession();
  if (!hasEntity()) return Response.json({ supported: false, entities: [] });
  return Response.json({ supported: true, memberValidator: DEPLOYMENT.memberValidator, entityFactory: DEPLOYMENT.entityFactory, entities: await myEntities(me) });
});

export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const b = (await req.json().catch(() => ({}))) as { entity?: string; displayName?: string };
  if (!b.entity || !isAddress(b.entity)) throw new HttpError(400, "法人帳戶地址錯誤");
  const r = await registerEntity(me, getAddress(b.entity), b.displayName);
  return Response.json({ entity: r.entity });
});
