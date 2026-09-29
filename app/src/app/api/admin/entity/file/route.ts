import { promises as fs } from "fs";
import path from "path";
import { isAddress } from "viem";
import { entityDir } from "@/server/entity";
import { audit, requireReviewer } from "@/server/kyc-review";
import { handle, HttpError } from "@/server/session";
import { read } from "@/server/store";

/** 複核人員檢視授權書；每次檢視都寫入稽核紀錄 */
export const GET = handle(async (req: Request) => {
  const who = await requireReviewer();
  const q = new URL(req.url).searchParams;
  const entity = q.get("entity") ?? "";
  if (!isAddress(entity)) throw new HttpError(400, "參數錯誤");
  const a = (await read()).entities?.[entity.toLowerCase()]?.application;
  if (!a?.letter) throw new HttpError(404, "沒有授權書");
  const buf = await fs.readFile(path.join(entityDir(entity, a.id), a.letter));
  await audit({ who, action: "entity.view", entity, application: a.id });
  const type = a.letter.endsWith("pdf") ? "application/pdf" : a.letter.endsWith("png") ? "image/png" : "image/jpeg";
  return new Response(new Uint8Array(buf), { headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
});
