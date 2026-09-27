import { getAddress, hashTypedData, isAddress, isHex, type Address, type Hex, type TypedDataDefinition } from "viem";

/**
 * 簽章通道（規格 §15.8）— 協定、端對端加密與錢包端防護。
 *
 * 通道只是傳遞管道，不是授權：每一筆請求都要附上說明，由使用者在錢包確認後才簽。
 * 內容以 ECDH(網站金鑰, 錢包金鑰) → HKDF-SHA256 → AES-256-GCM 加密；中繼只看得到密文。
 * 瀏覽器 SDK（public/sdk/cafeca-connect.js）以同樣的演算法實作另一端。
 */

export const CHANNEL_VERSION = 1;
export const MAX_REQUEST_TTL = 10 * 60;
export const MAX_PENDING = 5;
export const MAX_CALLS = 10;

export type ChannelMethod = "sign_message" | "sign_typed_data" | "send_calls";
export type ChannelCall = { to: Address; value?: string; data?: Hex };

export type ChannelRequest = {
  v: 1;
  id: string;
  method: ChannelMethod;
  params: { message?: string; typedData?: TypedDataDefinition; calls?: ChannelCall[] };
  /** 必填：告訴使用者這次要簽什麼、為什麼 */
  description: { title: string; detail?: string };
  iat: number;
  exp: number;
};

export type ChannelResult = { signature: Hex } | { txHash: Hex; success: boolean };
export type ChannelErrorCode = "rejected" | "invalid_request" | "failed" | "channel_closed";
export type ChannelResponse = { v: 1; id: string; result?: ChannelResult; error?: ChannelErrorCode; message?: string };

/** 在中繼或 postMessage 上傳遞的密文 */
export type Box = { v: 1; ch: string; id: string; iv: string; ct: string };

// ───────────────────────── 編碼 ─────────────────────────

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomId(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();

// ───────────────────────── 金鑰與加密 ─────────────────────────

export async function generateChannelKey(extractable: boolean): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, extractable, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

export async function exportPub(k: CryptoKey): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.exportKey("raw", k)));
}

export async function deriveChannelKey(myPriv: CryptoKey, peerPub: string, channelId: string): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey("raw", unb64u(peerPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, myPriv, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(channelId), info: enc.encode("CAFECA-channel-v1") },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** dir 放進 AAD：請求與回應互不可替換，也不能被搬到別的通道或別的請求 id */
const aad = (ch: string, id: string, dir: "req" | "res") => enc.encode(`${ch}|${id}|${dir}`);

export async function seal(key: CryptoKey, ch: string, id: string, dir: "req" | "res", obj: unknown): Promise<Box> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(ch, id, dir) }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, ch, id, iv: b64u(iv), ct: b64u(new Uint8Array(ct)) };
}

export async function open<T>(key: CryptoKey, box: Box, dir: "req" | "res"): Promise<T> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64u(box.iv), additionalData: aad(box.ch, box.id, dir) },
      key,
      unb64u(box.ct),
    );
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    throw new Error("無法解開請求：不是這個通道的網站送來的，或內容遭到竄改");
  }
}

// ───────────────────────── 驗證請求 ─────────────────────────

export function validateRequest(r: ChannelRequest, boxId: string, now = Math.floor(Date.now() / 1000)): ChannelRequest {
  if (!r || r.v !== CHANNEL_VERSION) throw new Error("不支援的通道協定版本");
  if (r.id !== boxId || !/^[0-9a-f]{16,64}$/.test(r.id)) throw new Error("請求 id 錯誤");
  if (!["sign_message", "sign_typed_data", "send_calls"].includes(r.method)) throw new Error(`不支援的操作「${String(r.method)}」`);
  const d = r.description;
  if (!d || typeof d.title !== "string" || !d.title.trim()) throw new Error("網站沒有說明這次要簽署的內容，錢包不會簽署沒有說明的請求");
  if (d.title.length > 60) throw new Error("說明標題過長（最多 60 字）");
  if (d.detail !== undefined && (typeof d.detail !== "string" || d.detail.length > 500)) throw new Error("說明內容過長（最多 500 字）");
  if (!Number.isInteger(r.iat) || !Number.isInteger(r.exp) || r.exp - r.iat > MAX_REQUEST_TTL || r.iat > now + 60) throw new Error("請求時間不合理");
  if (r.exp <= now) throw new Error("請求已過期，請回到網站重新操作");
  const p = r.params ?? {};
  if (r.method === "sign_message" && (typeof p.message !== "string" || !p.message || p.message.length > 4000)) throw new Error("訊息內容錯誤");
  if (r.method === "sign_typed_data" && (!p.typedData || typeof p.typedData !== "object")) throw new Error("EIP-712 內容錯誤");
  if (r.method === "send_calls") {
    if (!Array.isArray(p.calls) || !p.calls.length || p.calls.length > MAX_CALLS) throw new Error(`交易內容錯誤（1–${MAX_CALLS} 筆）`);
    p.calls = p.calls.map((c) => {
      if (!c || !isAddress(c.to)) throw new Error("交易對象地址錯誤");
      if (c.data !== undefined && !isHex(c.data)) throw new Error("交易資料格式錯誤");
      if (c.value !== undefined && !/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(c.value)) throw new Error("交易金額格式錯誤");
      return { to: getAddress(c.to), value: c.value, data: c.data ?? "0x" };
    });
  }
  return r;
}

// ───────────────────────── 錢包端防護（網站無法關閉） ─────────────────────────

export type GuardContext = { account: Address; chainId: number; protectedContracts: Address[] };

const low = (a: string) => a.toLowerCase();

/** EIP-712：拒絕可被挪用成登入或 UserOp 的結構，回傳需要顯示的警示 */
export function guardTypedData(td: TypedDataDefinition, g: GuardContext): { hash: Hex; warnings: string[] } {
  let hash: Hex;
  try {
    hash = hashTypedData(td);
  } catch (e) {
    throw new Error("EIP-712 內容無法解析：" + (e instanceof Error ? e.message.split("\n")[0] : String(e)));
  }
  const dom = (td.domain ?? {}) as { name?: string; chainId?: number | bigint; verifyingContract?: Address };
  if (dom.name === "CAFECA Sign-In") throw new Error("網站不能透過簽章通道要求 CAFECA 登入簽章");
  if (dom.name === "ERC4337" || td.primaryType === "PackedUserOperation") throw new Error("網站不能要求簽署帳戶操作（UserOperation）");
  const vc = dom.verifyingContract ? low(dom.verifyingContract) : null;
  if (vc && (vc === low(g.account) || g.protectedContracts.some((a) => low(a) === vc))) {
    throw new Error("網站不能要求簽署以你的身分合約或 CAFECA 系統合約為對象的訊息");
  }
  const warnings: string[] = [];
  const msg = (td.message ?? {}) as Record<string, unknown>;
  if (/permit|approv|allowance/i.test(String(td.primaryType)) || "spender" in msg) {
    warnings.push("這是代幣授權：簽署後，對方不需要你再次確認就能動用你的代幣。");
  }
  if (dom.chainId !== undefined && Number(dom.chainId) !== g.chainId) warnings.push(`這則訊息指定的鏈（${dom.chainId}）不是 Boltchain。`);
  if (!vc) warnings.push("這則訊息沒有指定合約，請確認你了解它的用途。");
  return { hash, warnings };
}

/** send_calls：不可操作帳戶本身與 CAFECA 模組（金鑰、恢復、通道、裝置目錄…） */
export function guardCalls(calls: ChannelCall[], g: GuardContext) {
  for (const c of calls) {
    const to = low(c.to);
    if (to === low(g.account)) throw new Error("網站不能要求你的身分合約呼叫自己（例如變更金鑰或模組）");
    if (g.protectedContracts.some((a) => low(a) === to)) throw new Error("網站不能要求操作 CAFECA 系統合約（金鑰、恢復、通道等）");
  }
}

/** 鏈上 previewAssessment 解析出的操作種類：只允許轉帳（1）、授權（2）、一般合約呼叫（0） */
export const ALLOWED_SUMMARY_KINDS = [0, 1, 2];
