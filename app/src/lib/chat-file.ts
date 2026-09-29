import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * 聊天附件的端對端加密：每個檔案產生一次性 AES-256-GCM 金鑰，
 * 密文上傳到伺服器，金鑰與 IV 放進（已端對端加密的）訊息內容，伺服器永遠看不到檔案。
 */

export const MAX_FILE = 10 * 1024 * 1024;

export type FileRef = { id: string; name: string; mime: string; size: number; key: Hex; iv: Hex; sha256: Hex; thumb?: string; w?: number; h?: number };

export async function encryptFile(file: Blob): Promise<{ ct: Uint8Array; key: Hex; iv: Hex; sha256: Hex }> {
  const data = new Uint8Array(await file.arrayBuffer());
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return { ct, key: bytesToHex(raw), iv: bytesToHex(iv), sha256: bytesToHex(sha) };
}

const cache = new Map<string, Promise<Blob>>();

/** 下載並解密；比對雜湊，防止伺服器替換內容 */
export function fetchFile(f: FileRef): Promise<Blob> {
  let p = cache.get(f.id);
  if (!p) {
    p = (async () => {
      const r = await fetch(`/api/chat/blob?id=${f.id}`);
      if (!r.ok) throw new Error("下載失敗");
      const ct = new Uint8Array(await r.arrayBuffer());
      const key = await crypto.subtle.importKey("raw", hexToBytes(f.key) as BufferSource, "AES-GCM", false, ["decrypt"]);
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(f.iv) as BufferSource }, key, ct));
      const sha = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", pt)));
      if (sha !== f.sha256) throw new Error("檔案內容與訊息不符");
      return new Blob([pt], { type: f.mime || "application/octet-stream" });
    })();
    p.catch(() => cache.delete(f.id));
    cache.set(f.id, p);
  }
  return p;
}

/** 圖片縮圖（放進加密訊息裡，對方不必下載原圖就能看到預覽） */
export async function imageThumb(file: Blob, max = 360): Promise<{ thumb: string; w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return { thumb: c.toDataURL("image/jpeg", 0.7), w: bmp.width, h: bmp.height };
  } catch {
    return null;
  }
}

export function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
