"use client";

import { bytesToHex, hexToBytes, keccak256, encodeAbiParameters, type Hex } from "viem";
import type { WebAuthnSig } from "./userop";

// ───────────────────────── 編碼工具 ─────────────────────────

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** 轉成 low-s（合約拒絕 high-s） */
export function normalizeS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

function pad32(b: Uint8Array): Uint8Array {
  const trimmed = b[0] === 0 && b.length > 32 ? b.slice(b.length - 32) : b;
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}

/** WebAuthn 回傳的 ASN.1 DER 簽章 → (r, s) */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  if (der[i] !== 0x02) throw new Error("bad DER r");
  const rLen = der[i + 1];
  const r = der.slice(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (der[i] !== 0x02) throw new Error("bad DER s");
  const sLen = der[i + 1];
  const s = der.slice(i + 2, i + 2 + sLen);
  return { r: BigInt(bytesToHex(pad32(r))), s: BigInt(bytesToHex(pad32(s))) };
}

/** SPKI（P-256）→ (x, y)：未壓縮點在最後 65 bytes */
export function spkiToXY(spki: Uint8Array): { qx: Hex; qy: Hex } {
  const pt = spki.slice(spki.length - 65);
  if (pt[0] !== 0x04) throw new Error("unexpected public key format");
  return { qx: bytesToHex(pt.slice(1, 33)), qy: bytesToHex(pt.slice(33, 65)) };
}

export function keyIdOf(qx: Hex, qy: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

export function rpId(): string {
  return window.location.hostname;
}

export async function rpIdHash(): Promise<Hex> {
  return bytesToHex(await sha256(new TextEncoder().encode(rpId())));
}

export function findIndices(clientDataJSON: string): { challengeIndex: bigint; typeIndex: bigint } {
  const c = clientDataJSON.indexOf('"challenge":"');
  const t = clientDataJSON.indexOf('"type":"webauthn.get"');
  if (c < 0 || t < 0) throw new Error("clientDataJSON 格式不符");
  return { challengeIndex: BigInt(c), typeIndex: BigInt(t) };
}

// ───────────────────────── Passkey（手機、電腦：DAILY） ─────────────────────────

export type PasskeyInfo = {
  credentialId: string;
  qx: Hex;
  qy: Hex;
  keyId: Hex;
  rpIdHash: Hex;
  backupEligible: boolean;
  label: string;
};

/**
 * 在此裝置建立 FIDO2 金鑰（ES256）。
 * @param userId 身分帳戶地址（已知時傳入，存在 passkey 的 userHandle，登入時可直接找到帳戶）；
 *               建立新身分時地址由公鑰決定、事先未知，登入時改由簽章還原公鑰推算地址
 */
export async function registerPasskey(userName: string, label: string, userId?: Uint8Array): Promise<PasskeyInfo> {
  if (!window.PublicKeyCredential) throw new Error("此瀏覽器不支援 Passkey");
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "CAFECA", id: rpId() },
      user: {
        id: (userId ?? crypto.getRandomValues(new Uint8Array(16))) as BufferSource,
        name: userName,
        displayName: userName,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("已取消建立 Passkey");
  const res = cred.response as AuthenticatorAttestationResponse;
  const spki = res.getPublicKey();
  if (!spki) throw new Error("無法取得公鑰");
  const { qx, qy } = spkiToXY(new Uint8Array(spki));
  const authData = new Uint8Array(res.getAuthenticatorData());
  return {
    credentialId: b64urlEncode(new Uint8Array(cred.rawId)),
    qx,
    qy,
    keyId: keyIdOf(qx, qy),
    rpIdHash: bytesToHex(authData.slice(0, 32)),
    backupEligible: (authData[32] & 0x08) !== 0,
    label,
  };
}

/** 以 passkey 簽署 32-byte challenge（userOpHash 或登入雜湊） */
export async function signWithPasskey(
  challenge: Hex,
  allow: PasskeyInfo[],
): Promise<{ keyId: Hex; sig: WebAuthnSig }> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: hexToBytes(challenge) as BufferSource,
      rpId: rpId(),
      allowCredentials: allow.map((k) => ({ type: "public-key" as const, id: b64urlDecode(k.credentialId) as BufferSource })),
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("已取消簽署");
  const res = assertion.response as AuthenticatorAssertionResponse;
  const credId = b64urlEncode(new Uint8Array(assertion.rawId));
  const key = allow.find((k) => k.credentialId === credId);
  if (!key) throw new Error("使用了未登記的 Passkey");
  const clientDataJSON = new TextDecoder().decode(res.clientDataJSON);
  const { r, s } = parseDerSignature(new Uint8Array(res.signature));
  return {
    keyId: key.keyId,
    sig: {
      authenticatorData: bytesToHex(new Uint8Array(res.authenticatorData)),
      clientDataJSON,
      ...findIndices(clientDataJSON),
      r: ("0x" + r.toString(16).padStart(64, "0")) as Hex,
      s: ("0x" + normalizeS(s).toString(16).padStart(64, "0")) as Hex,
    },
  };
}
