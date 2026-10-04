import { enableNativeDefaults, nativeStatus } from "@/server/native-limits";
import { handle, requireSession } from "@/server/session";

/** BOLT 轉帳額度：GET 目前額度與啟用方式；POST 由管理者帳戶設定平台預設額度（KeyringValidator v2） */
export const GET = handle(async () => Response.json(await nativeStatus(await requireSession())));

export const POST = handle(async () => {
  const me = await requireSession();
  return Response.json({ txHash: await enableNativeDefaults(me) });
});
