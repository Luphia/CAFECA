import { promises as fs } from "fs";
import path from "path";
import { caseDir } from "@/server/kyc-pipeline";
import { findCase } from "@/server/kyc-queue";
import { handle, HttpError, requireSession } from "@/server/session";

/** 使用者檢視自己送出的浮水印版證件（只有正反面，不提供臉部影片），只能看自己的案件 */
export const GET = handle(async (req: Request) => {
  const me = await requireSession();
  const q = new URL(req.url).searchParams;
  const id = q.get("case") ?? "";
  const kind = q.get("kind") as "front" | "back";
  if (!["front", "back"].includes(kind)) throw new HttpError(400, "參數錯誤");
  const c = await findCase(me, id);
  if (!c) throw new HttpError(404, "找不到這個驗證案件");
  const buf = await fs.readFile(path.join(caseDir(me, id), c.files[kind]));
  return new Response(new Uint8Array(buf), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});
