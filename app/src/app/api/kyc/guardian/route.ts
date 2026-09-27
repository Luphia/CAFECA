import { zeroAddress } from "viem";
import { authorizeGuardian, currentGuardian, guardianAddress } from "@/server/guardian";
import { handle, HttpError, requireSession } from "@/server/session";
import { read } from "@/server/store";

/** 已完成 KYC 但備援金鑰尚未安裝（例如上次送出失敗）：重新取得平台授權 */
export const POST = handle(async () => {
  const me = await requireSession();
  const rec = (await read()).kyc[me];
  if (!rec || rec.level < 2) throw new HttpError(403, "需先完成證件＋臉部影像實名驗證");
  if ((await currentGuardian(me)) !== zeroAddress) throw new HttpError(409, "平台備援金鑰已啟用");
  const address = guardianAddress(me);
  return Response.json({ address, authoritySig: await authorizeGuardian(me, address) });
});
