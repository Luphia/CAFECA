import { p256 } from "@noble/curves/p256";
import { encodeAbiParameters, getAddress, hexToBigInt, isAddress, keccak256, numberToHex, type Address, type Hex } from "viem";

/**
 * CAFECA Deeplink 規範 v1
 *
 * 兩種等價的形式（原生 App 註冊 custom scheme 與 Universal/App Link；網頁版只用 https）：
 *   https://<host>/dl/<action>?v=1&<params>      ← 印在 QR code、分享連結
 *   cafeca://<action>?v=1&<params>               ← 原生 App 之間互相喚起
 *
 * 規則
 * - v：規範版本，目前為 1；不認得的版本一律拒絕，不做猜測
 * - 參數一律 URL query，值為 hex（0x…）、十進位字串或 UTF-8 文字；不放任何秘密（私鑰、session、KYC 資料）
 * - 深連結只「開啟並預填」畫面，永遠不自動執行：任何上鏈操作都要使用者看過內容並以金鑰確認
 * - 有時效的連結帶 exp（Unix 秒）；過期即拒絕
 * - 金額以最小單位整數表示（TWDC 6 位小數），避免小數點與語系問題
 *
 * Actions
 * | action  | 用途                     | 參數                                                   |
 * | pair    | 新裝置請求加入既有身分   | s 配對 session、k 壓縮公鑰（base64url 33B）、n 名稱、exp |
 * | pay     | 付款請求（收款 QR）      | to 地址或 @代稱、amt 最小單位、tok 代幣、memo、ref      |
 * | id      | 開啟某個身分（加聯絡人） | a 地址 或 h 代稱                                       |
 * | recover | 開啟恢復頁並帶入身分     | a 地址                                                 |
 */

export const DEEPLINK_VERSION = "1";
export const CUSTOM_SCHEME = "cafeca:";

/** rpIdHash 不放進連結（縮短 QR）：同一個 RP 網域，核准端以自己的 rpId 計算 */
export type PairLink = { action: "pair"; session: string; qx: Hex; qy: Hex; name: string; exp: number };
export type PayLink = { action: "pay"; to: string; amount?: bigint; token?: Address; memo?: string; ref?: string };
export type IdLink = { action: "id"; address?: Address; handle?: string };
export type RecoverLink = { action: "recover"; address: Address };
export type Deeplink = PairLink | PayLink | IdLink | RecoverLink;

export class DeeplinkError extends Error {}

function base(origin?: string) {
  return (origin ?? (typeof window !== "undefined" ? window.location.origin : "https://id.cafeca.com.tw")) + "/dl/";
}

/** 產生 https 形式的深連結（QR code 用） */
export function buildDeeplink(link: Deeplink, origin?: string): string {
  const q = new URLSearchParams({ v: DEEPLINK_VERSION });
  switch (link.action) {
    case "pair":
      q.set("s", link.session);
      q.set("k", compressKey(link.qx, link.qy));
      q.set("n", link.name);
      q.set("exp", String(link.exp));
      break;
    case "pay":
      q.set("to", link.to);
      if (link.amount !== undefined) q.set("amt", link.amount.toString());
      if (link.token) q.set("tok", link.token);
      if (link.memo) q.set("memo", link.memo);
      if (link.ref) q.set("ref", link.ref);
      break;
    case "id":
      if (link.address) q.set("a", link.address);
      if (link.handle) q.set("h", link.handle);
      break;
    case "recover":
      q.set("a", link.address);
      break;
  }
  return `${base(origin)}${link.action}?${q.toString()}`;
}

/** 對應的 custom scheme 形式（原生 App） */
export function toCustomScheme(httpsLink: string): string {
  const u = new URL(httpsLink);
  return `${CUSTOM_SCHEME}//${u.pathname.replace(/^\/dl\//, "")}${u.search}`;
}

/** P-256 公鑰壓縮成 33 bytes 再 base64url（44 字元），讓配對 QR 維持低密度、好掃 */
export function compressKey(qx: Hex, qy: Hex): string {
  const pt = p256.ProjectivePoint.fromAffine({ x: hexToBigInt(qx), y: hexToBigInt(qy) });
  return b64url(pt.toRawBytes(true));
}

export function decompressKey(k: string): { qx: Hex; qy: Hex } {
  try {
    const bytes = unb64url(k);
    if (bytes.length !== 33) throw new Error();
    const pt = p256.ProjectivePoint.fromHex(bytes);
    pt.assertValidity();
    const a = pt.toAffine();
    return { qx: numberToHex(a.x, { size: 32 }), qy: numberToHex(a.y, { size: 32 }) };
  } catch {
    throw new DeeplinkError("配對連結中的公鑰無效");
  }
}

function b64url(b: Uint8Array) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("bad");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * 解析深連結。接受：https://<任何 host>/dl/<action>?…、cafeca://<action>?…、或只有 /dl/<action>?… 的路徑。
 * @param expectedOrigin 若提供，https 連結的來源必須相同（防止被導向仿冒網域）
 */
export function parseDeeplink(input: string, expectedOrigin?: string): Deeplink {
  const raw = input.trim();
  let action: string;
  let q: URLSearchParams;
  try {
    if (raw.startsWith(CUSTOM_SCHEME)) {
      const u = new URL(raw.replace(/^cafeca:\/\//, "https://cafeca.invalid/dl/"));
      action = u.pathname.replace(/^\/dl\//, "");
      q = u.searchParams;
    } else {
      const u = new URL(raw, "https://cafeca.invalid");
      if (expectedOrigin && raw.startsWith("http") && u.origin !== expectedOrigin) {
        throw new DeeplinkError(`這個連結來自其他網站（${u.host}），不是 CAFECA`);
      }
      const m = u.pathname.match(/^\/dl\/([a-z]+)\/?$/);
      if (!m) throw new DeeplinkError("不是 CAFECA 連結");
      action = m[1];
      q = u.searchParams;
    }
  } catch (e) {
    if (e instanceof DeeplinkError) throw e;
    throw new DeeplinkError("連結格式錯誤");
  }
  if (q.get("v") !== DEEPLINK_VERSION) throw new DeeplinkError("不支援的連結版本，請更新 App");

  switch (action) {
    case "pair": {
      const [s, k] = [q.get("s"), q.get("k")];
      const exp = Number(q.get("exp"));
      if (!s || !/^[0-9a-f]{16,64}$/.test(s) || !k || !exp) throw new DeeplinkError("配對連結內容不完整");
      if (exp * 1000 < Date.now()) throw new DeeplinkError("配對連結已過期，請在新裝置重新產生");
      const { qx, qy } = decompressKey(k);
      return { action, session: s, qx, qy, name: (q.get("n") ?? "新裝置").slice(0, 40), exp };
    }
    case "pay": {
      const to = q.get("to") ?? "";
      if (!isAddress(to) && !/^@?[a-z0-9_]{3,20}$/i.test(to)) throw new DeeplinkError("收款人格式錯誤");
      const amt = q.get("amt");
      if (amt !== null && !/^\d{1,30}$/.test(amt)) throw new DeeplinkError("金額格式錯誤");
      const tok = q.get("tok");
      if (tok !== null && !isAddress(tok)) throw new DeeplinkError("代幣地址格式錯誤");
      return {
        action,
        to: isAddress(to) ? getAddress(to) : to.startsWith("@") ? to : `@${to}`,
        amount: amt === null ? undefined : BigInt(amt),
        token: tok ? getAddress(tok) : undefined,
        memo: q.get("memo")?.slice(0, 80) ?? undefined,
        ref: q.get("ref")?.slice(0, 64) ?? undefined,
      };
    }
    case "id": {
      const a = q.get("a");
      const h = q.get("h");
      if (a && isAddress(a)) return { action, address: getAddress(a) };
      if (h && /^[a-z0-9_]{3,20}$/i.test(h)) return { action, handle: h.toLowerCase() };
      throw new DeeplinkError("身分連結內容不完整");
    }
    case "recover": {
      const a = q.get("a");
      if (!a || !isAddress(a)) throw new DeeplinkError("恢復連結內容不完整");
      return { action, address: getAddress(a) };
    }
    default:
      throw new DeeplinkError(`不支援的動作「${action}」，請更新 App`);
  }
}

/**
 * 配對確認碼：由新裝置公鑰推導的 6 位數字，兩台裝置同時顯示，使用者比對一致才按確認。
 * 防止 QR code 被偷換成攻擊者的公鑰（把別人的裝置加進自己的身分）。
 */
export function pairingCode(qx: Hex, qy: Hex): string {
  const h = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }], ["CAFECA_PAIR", qx, qy]));
  const n = Number(BigInt(h) % 1_000_000n);
  return n.toString().padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
}
