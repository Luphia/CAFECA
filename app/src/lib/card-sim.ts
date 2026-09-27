"use client";

import { bytesToHex, concat, hexToBytes, type Hex } from "viem";
import { b64urlEncode, keyIdOf, normalizeS, rpId, sha256 } from "./webauthn";
import type { WebAuthnSig } from "./userop";

/**
 * CAFECA 卡片模擬器（測試網替代實體卡）
 *
 * - 私鑰為 WebCrypto 產生的「不可匯出」P-256 金鑰，存在 IndexedDB，JS 無法讀出私鑰本體
 * - 斷言格式與實體卡一致：authenticatorData = rpIdHash ‖ flags(UP|UV|ED, BE=0) ‖ signCount ‖ ctxd 擴充
 * - ctxd = sha256(abi.encode(TxSummary[]))，由卡片「螢幕」顯示的內容計算
 */

const DB = "cafeca-card";
const STORE = "keys";
const CTXD_PREFIX = "0xa164637478645820" as Hex; // CBOR {"ctxd": bstr(32)}

export type CardInfo = { qx: Hex; qy: Hex; keyId: Hex; rpIdHash: Hex; cardNo: string; holder: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

type Stored = { pair: CryptoKeyPair; info: CardInfo; counter: number };

export async function getCard(): Promise<Stored | undefined> {
  return idb<Stored | undefined>("readonly", (s) => s.get("card"));
}

export async function createCard(holder: string): Promise<CardInfo> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const qx = bytesToHex(raw.slice(1, 33));
  const qy = bytesToHex(raw.slice(33, 65));
  const rpIdHash = bytesToHex(await sha256(new TextEncoder().encode(rpId())));
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 10).toString()).join("");
  const info: CardInfo = { qx, qy, keyId: keyIdOf(qx, qy), rpIdHash, cardNo: "9234" + digits, holder };
  await idb("readwrite", (s) => s.put({ pair, info, counter: 0 } satisfies Stored, "card"));
  return info;
}

export async function destroyCard(): Promise<void> {
  await idb("readwrite", (s) => s.delete("card"));
}

/**
 * 卡片簽章（使用者已在「螢幕」確認之後呼叫）
 * @param challenge userOpHash
 * @param ctxd 卡片自行由顯示內容算出的 sha256(abi.encode(TxSummary[]))
 */
export async function cardSign(challenge: Hex, ctxd: Hex): Promise<{ keyId: Hex; sig: WebAuthnSig }> {
  const stored = await getCard();
  if (!stored) throw new Error("尚未發卡");
  const counter = stored.counter + 1;
  await idb("readwrite", (s) => s.put({ ...stored, counter }, "card"));

  const flags = "0x85" as Hex; // UP | UV | ED，BE = 0（裝置綁定）
  const count = ("0x" + counter.toString(16).padStart(8, "0")) as Hex;
  const authData = concat([stored.info.rpIdHash, flags, count, CTXD_PREFIX, ctxd]);

  const clientDataJSON = JSON.stringify({
    type: "webauthn.get",
    challenge: b64urlEncode(hexToBytes(challenge)),
    origin: window.location.origin,
    crossOrigin: false,
  });
  const cdHash = await sha256(new TextEncoder().encode(clientDataJSON));
  const message = concat([authData, bytesToHex(cdHash)]);
  // WebCrypto 會先 sha256(message)，正好等於 WebAuthn 的簽章雜湊
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, stored.pair.privateKey, hexToBytes(message) as BufferSource),
  );
  const r = BigInt(bytesToHex(raw.slice(0, 32)));
  const s = normalizeS(BigInt(bytesToHex(raw.slice(32, 64))));
  return {
    keyId: stored.info.keyId,
    sig: {
      authenticatorData: authData,
      clientDataJSON,
      challengeIndex: BigInt(clientDataJSON.indexOf('"challenge":"')),
      typeIndex: BigInt(clientDataJSON.indexOf('"type":"webauthn.get"')),
      r: ("0x" + r.toString(16).padStart(64, "0")) as Hex,
      s: ("0x" + s.toString(16).padStart(64, "0")) as Hex,
    },
  };
}
