import { getAddress, isAddress } from "viem";
import { applyEntity } from "@/server/entity";
import { handle, HttpError, requireSession } from "@/server/session";

/** 法人驗證申請：multipart { entity, ubn, letter?（非代表人本人時必填：代表人簽署的授權書） } */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const form = await req.formData();
  const entity = String(form.get("entity") ?? "");
  const ubn = String(form.get("ubn") ?? "").trim();
  if (!isAddress(entity)) throw new HttpError(400, "法人帳戶地址錯誤");
  const letter = form.get("letter");
  return Response.json(await applyEntity(me, getAddress(entity), ubn, letter instanceof File ? letter : null));
});
