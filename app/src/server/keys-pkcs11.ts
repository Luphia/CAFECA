import "server-only";
import { createHash } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { recoverAddress, serializeSignature, toHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { DigestSigner, Mac, P256Signer } from "./keys";

/**
 * PKCS#11 HSM 實作（規格 §16.6 P3-A1，KEY_BACKEND=pkcs11）
 *
 * 金鑰在 HSM 內產生、不可匯出（CKA_EXTRACTABLE=false、CKA_SENSITIVE=true），伺服器只拿得到簽章結果。
 *   PKCS11_MODULE        HSM 廠商的 PKCS#11 函式庫（測試用 SoftHSM：/usr/lib/softhsm/libsofthsm2.so）
 *   PKCS11_TOKEN_LABEL   token（partition）名稱
 *   PKCS11_PIN           token 的使用者 PIN（正式環境改由啟動時輸入或 HSM 的 client 憑證）
 *   PKCS11_KYC_SIGNER_LABEL／PKCS11_NEXT_KYC_SIGNER_LABEL   secp256k1 簽章金鑰（目前／下一把）
 *   PKCS11_DISCLOSURE_LABEL                                P-256 資料包簽章金鑰
 *   PKCS11_PAIRWISE_LABEL／PKCS11_NEXT_PAIRWISE_LABEL      pairwise_id 的 HMAC 金鑰
 *
 * 建立金鑰：npm run hsm -- init（見 scripts/hsm.mts）。
 */

// PKCS#11 常數（避免在型別層依賴 pkcs11js）
const CKO_PUBLIC_KEY = 2, CKO_PRIVATE_KEY = 3, CKO_SECRET_KEY = 4;
const CKK_EC = 3, CKK_GENERIC_SECRET = 0x10;
const CKA_CLASS = 0, CKA_TOKEN = 1, CKA_PRIVATE = 2, CKA_LABEL = 3, CKA_KEY_TYPE = 0x100, CKA_SENSITIVE = 0x103, CKA_DECRYPT = 0x105, CKA_UNWRAP = 0x107, CKA_SIGN_RECOVER = 0x109, CKA_DERIVE = 0x10c, CKA_SIGN = 0x108, CKA_VERIFY = 0x10a, CKA_EXTRACTABLE = 0x162, CKA_VALUE_LEN = 0x161, CKA_EC_PARAMS = 0x180, CKA_EC_POINT = 0x181;
const CKM_EC_KEY_PAIR_GEN = 0x1040, CKM_ECDSA = 0x1041, CKM_SHA256_HMAC = 0x251, CKM_GENERIC_SECRET_KEY_GEN = 0x350;
const CKF_SERIAL_SESSION = 4, CKF_RW_SESSION = 2, CKU_USER = 1;
const OID = { secp256k1: Buffer.from("06052b8104000a", "hex"), p256: Buffer.from("06082a8648ce3d030107", "hex") };

type P11 = {
  load(path: string): void;
  C_Initialize(): void;
  C_GetSlotList(tokenPresent: boolean): Buffer[];
  C_GetTokenInfo(slot: Buffer): { label: string };
  C_OpenSession(slot: Buffer, flags: number): Buffer;
  C_Login(s: Buffer, user: number, pin: string): void;
  C_FindObjectsInit(s: Buffer, t: { type: number; value?: unknown }[]): void;
  C_FindObjects(s: Buffer): Buffer | null;
  C_FindObjectsFinal(s: Buffer): void;
  C_GetAttributeValue(s: Buffer, h: Buffer, t: { type: number }[]): { type: number; value: Buffer }[];
  C_SignInit(s: Buffer, m: { mechanism: number; parameter?: Buffer | null }, k: Buffer): void;
  C_Sign(s: Buffer, data: Buffer, out: Buffer): Buffer;
  C_GenerateKeyPair(s: Buffer, m: { mechanism: number }, pub: { type: number; value: unknown }[], priv: { type: number; value: unknown }[]): { publicKey: Buffer; privateKey: Buffer };
  C_GenerateKey(s: Buffer, m: { mechanism: number }, t: { type: number; value: unknown }[]): Buffer;
};

let ctx: { p: P11; s: Buffer } | null = null;

async function session() {
  if (ctx) return ctx;
  const mod = process.env.PKCS11_MODULE, label = process.env.PKCS11_TOKEN_LABEL, pin = process.env.PKCS11_PIN;
  if (!mod || !label || !pin) throw new Error("KEY_BACKEND=pkcs11 需要 PKCS11_MODULE、PKCS11_TOKEN_LABEL、PKCS11_PIN");
  const lib = (await import(/* webpackIgnore: true */ "pkcs11js")) as unknown as { PKCS11: new () => P11; default?: { PKCS11: new () => P11 } };
  const P = lib.PKCS11 ?? lib.default!.PKCS11;
  const p = new P();
  p.load(mod);
  p.C_Initialize();
  const slot = p.C_GetSlotList(true).find((sl) => p.C_GetTokenInfo(sl).label.trim() === label);
  if (!slot) throw new Error(`找不到 PKCS#11 token「${label}」`);
  const s = p.C_OpenSession(slot, CKF_SERIAL_SESSION | CKF_RW_SESSION);
  p.C_Login(s, CKU_USER, pin);
  ctx = { p, s };
  return ctx;
}

async function find(cls: number, label: string): Promise<Buffer> {
  const { p, s } = await session();
  p.C_FindObjectsInit(s, [
    { type: CKA_CLASS, value: cls },
    { type: CKA_LABEL, value: label },
  ]);
  const h = p.C_FindObjects(s);
  p.C_FindObjectsFinal(s);
  if (!h) throw new Error(`HSM 找不到金鑰「${label}」`);
  return h;
}

/** CKA_EC_POINT = DER OCTET STRING(04‖x‖y) */
async function ecPoint(label: string): Promise<Uint8Array> {
  const { p, s } = await session();
  const v = p.C_GetAttributeValue(s, await find(CKO_PUBLIC_KEY, label), [{ type: CKA_EC_POINT }])[0].value;
  const raw = v.length === 67 && v[0] === 0x04 && v[1] === 0x41 ? v.subarray(2) : v;
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error(`金鑰「${label}」的公鑰格式不支援`);
  return new Uint8Array(raw);
}

async function rawSign(label: string, digest: Buffer): Promise<Buffer> {
  const { p, s } = await session();
  p.C_SignInit(s, { mechanism: CKM_ECDSA }, await find(CKO_PRIVATE_KEY, label));
  const out = p.C_Sign(s, digest, Buffer.alloc(128));
  if (out.length !== 64) throw new Error(`HSM 回傳的簽章長度 ${out.length}，預期 64`);
  return out;
}

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少環境變數 ${name}`);
  return v;
}

export function pkcs11DigestSigner(labelEnv: string): DigestSigner {
  const label = need(labelEnv);
  let addr: Address | null = null;
  const address = async () => (addr ??= publicKeyToAddress(toHex(await ecPoint(label))));
  return {
    backend: "pkcs11",
    address,
    async signDigest(digest: Hex) {
      const rs = await rawSign(label, Buffer.from(digest.slice(2), "hex"));
      const sig = secp256k1.Signature.fromCompact(rs.toString("hex")).normalizeS();
      const want = await address();
      for (const v of [27n, 28n]) {
        const out = serializeSignature({ r: toHex(sig.r, { size: 32 }), s: toHex(sig.s, { size: 32 }), v });
        if ((await recoverAddress({ hash: digest, signature: out })).toLowerCase() === want.toLowerCase()) return out;
      }
      throw new Error("HSM 簽章無法還原成簽章者位址");
    },
  };
}

export function pkcs11P256(labelEnv: string): P256Signer | null {
  const label = process.env[labelEnv];
  if (!label) return null;
  return {
    backend: "pkcs11",
    async publicXY() {
      const pt = await ecPoint(label);
      return { x: pt.slice(1, 33), y: pt.slice(33) };
    },
    async signSha256(data: Uint8Array) {
      return new Uint8Array(await rawSign(label, createHash("sha256").update(data).digest()));
    },
  };
}

export function pkcs11Mac(labelEnv: string): Mac | null {
  const label = process.env[labelEnv];
  if (!label) return null;
  return {
    backend: "pkcs11",
    async hmacHex(data: string) {
      const { p, s } = await session();
      p.C_SignInit(s, { mechanism: CKM_SHA256_HMAC }, await find(CKO_SECRET_KEY, label));
      return `0x${p.C_Sign(s, Buffer.from(data, "utf8"), Buffer.alloc(64)).toString("hex")}` as Hex;
    },
  };
}

/** 在 HSM 內產生金鑰（不可匯出）；已存在同名金鑰時不動 */
export async function pkcs11Generate(kind: "secp256k1" | "p256" | "hmac", label: string): Promise<"created" | "exists"> {
  const { p, s } = await session();
  const exists = await find(kind === "hmac" ? CKO_SECRET_KEY : CKO_PRIVATE_KEY, label).then(() => true, () => false);
  if (exists) return "exists";
  if (kind === "hmac") {
    p.C_GenerateKey(s, { mechanism: CKM_GENERIC_SECRET_KEY_GEN }, [
      { type: CKA_CLASS, value: CKO_SECRET_KEY },
      { type: CKA_KEY_TYPE, value: CKK_GENERIC_SECRET },
      { type: CKA_VALUE_LEN, value: 32 },
      { type: CKA_TOKEN, value: true },
      { type: CKA_PRIVATE, value: true },
      { type: CKA_SENSITIVE, value: true },
      { type: CKA_EXTRACTABLE, value: false },
      { type: CKA_SIGN, value: true },
      { type: CKA_VERIFY, value: true },
      { type: CKA_LABEL, value: label },
    ]);
    return "created";
  }
  p.C_GenerateKeyPair(
    s,
    { mechanism: CKM_EC_KEY_PAIR_GEN },
    [
      { type: CKA_CLASS, value: CKO_PUBLIC_KEY },
      { type: CKA_KEY_TYPE, value: CKK_EC },
      { type: CKA_TOKEN, value: true },
      { type: CKA_VERIFY, value: true },
      { type: CKA_EC_PARAMS, value: kind === "secp256k1" ? OID.secp256k1 : OID.p256 },
      { type: CKA_LABEL, value: label },
    ],
    [
      { type: CKA_CLASS, value: CKO_PRIVATE_KEY },
      { type: CKA_KEY_TYPE, value: CKK_EC },
      { type: CKA_TOKEN, value: true },
      { type: CKA_PRIVATE, value: true },
      { type: CKA_SENSITIVE, value: true },
      { type: CKA_EXTRACTABLE, value: false },
      { type: CKA_SIGN, value: true },
      // 只允許簽章：不能解密、解包、復原簽章或衍生金鑰
      { type: CKA_DECRYPT, value: false },
      { type: CKA_UNWRAP, value: false },
      { type: CKA_SIGN_RECOVER, value: false },
      { type: CKA_DERIVE, value: false },
      { type: CKA_LABEL, value: label },
    ],
  );
  return "created";
}

/** 金鑰是否可以匯出（應為 false）：抽查用 */
export async function pkcs11Extractable(kind: "ec" | "hmac", label: string): Promise<boolean> {
  const { p, s } = await session();
  const h = await find(kind === "hmac" ? CKO_SECRET_KEY : CKO_PRIVATE_KEY, label);
  return p.C_GetAttributeValue(s, h, [{ type: CKA_EXTRACTABLE }])[0].value[0] === 1;
}

/** 測試用 */
export function pkcs11Reset() {
  ctx = null;
}

export const pkcs11Address = (pt: Uint8Array) => publicKeyToAddress(toHex(pt));
