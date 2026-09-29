import { promises as fs } from "fs";
import path from "path";
import { getAddress, isAddress } from "viem";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update } from "@/server/store";

/**
 * 聊天附件（檔案、相機照片）的密文。
 * 傳送端以一次性 AES-256-GCM 金鑰加密後才上傳，金鑰只放在端對端加密的訊息裡；伺服器看不到內容。
 * 只有傳送者與收件者能下載。
 */
const MAX_BLOB = 10 * 1024 * 1024 + 64;
const DIR = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "chat-blobs");

export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const to = new URL(req.url).searchParams.get("to") ?? "";
  if (!isAddress(to)) throw new HttpError(400, "收件人地址錯誤");
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BLOB) throw new HttpError(413, "檔案不能超過 10 MB");
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, "沒有檔案內容");
  if (buf.length > MAX_BLOB) throw new HttpError(413, "檔案不能超過 10 MB");
  const id = crypto.randomUUID();
  await fs.mkdir(DIR(), { recursive: true });
  await fs.writeFile(path.join(DIR(), `${id}.bin`), buf);
  await update((s) => {
    s.chatBlobs ??= {};
    s.chatBlobs[id] = { from: me, to: getAddress(to), size: buf.length, createdAt: Date.now() };
  });
  return Response.json({ id });
});

export const GET = handle(async (req: Request) => {
  const me = (await requireSession()).toLowerCase();
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "參數錯誤");
  const b = (await read()).chatBlobs?.[id];
  if (!b || (b.from.toLowerCase() !== me && b.to.toLowerCase() !== me)) throw new HttpError(404, "找不到這個檔案");
  const buf = await fs.readFile(path.join(DIR(), `${id}.bin`));
  return new Response(new Uint8Array(buf), { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
});
