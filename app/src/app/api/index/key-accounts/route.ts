import { isHex } from "viem";
import { accountsOfKey } from "@/server/indexer";
import { handle, HttpError } from "@/server/session";

/** 由 Passkey 的 keyId 找出曾加入這把金鑰的身分（登入反查用；錢包仍會以 getKey 確認目前有效） */
export const GET = handle(async (req: Request) => {
  const keyId = new URL(req.url).searchParams.get("keyId") ?? "";
  if (!isHex(keyId) || keyId.length !== 66) throw new HttpError(400, "keyId 格式錯誤");
  return Response.json({ accounts: await accountsOfKey(keyId) }, { headers: { "cache-control": "no-store" } });
});
