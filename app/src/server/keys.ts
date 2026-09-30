import "server-only";
import { createHmac } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p256 } from "@noble/curves/p256";
import { hashTypedData, recoverAddress, serializeSignature, toHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";

/**
 * 伺服器金鑰介面（規格 §16.6 P3-A1）：簽章一律透過這裡，之後改用 KMS／HSM 只需要新增一個實作。
 *
 *   kycSigner()        secp256k1：Attested／Suspended／Revoked、KycCredential（EIP-712）
 *   disclosureSigner() P-256：資料調閱資料包的 ES256 JWS
 *   pairwiseMac()      HMAC-SHA256：pairwise_id
 *
 * KEY_BACKEND=local（預設）從 .env.local 讀金鑰；其他值（例如 aws-kms、gcp-kms、pkcs11）在 BACKENDS 註冊。
 * KMS 回傳的 secp256k1 簽章通常是 DER 且可能是 high-s，請用 secp256k1FromDer 轉成 OpenZeppelin ECDSA 接受的 65 bytes。
 */

export interface DigestSigner {
  readonly backend: string;
  address(): Promise<Address>;
  /** 對 32-byte digest 簽章，回傳 r‖s‖v（low-s） */
  signDigest(digest: Hex): Promise<Hex>;
}
export interface P256Signer {
  readonly backend: string;
  publicXY(): Promise<{ x: Uint8Array; y: Uint8Array }>;
  /** 對 SHA-256(data) 簽章，回傳 64 bytes r‖s（JWS ES256 格式） */
  signSha256(data: Uint8Array): Promise<Uint8Array>;
}
export interface Mac {
  readonly backend: string;
  hmacHex(data: string): Promise<Hex>;
}

type Backend = {
  kycSigner(slot: "current" | "next"): DigestSigner;
  disclosureSigner(): P256Signer | null;
  pairwiseMac(slot: "current" | "next"): Mac | null;
};

// ───────────────────────── local：金鑰在 .env.local ─────────────────────────

function localDigestSigner(envName: string): DigestSigner {
  const pk = process.env[envName] as Hex | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`缺少環境變數 ${envName}`);
  const acct = privateKeyToAccount(pk);
  return { backend: "local", address: async () => acct.address, signDigest: (h) => acct.sign({ hash: h }) };
}

function localP256(envName: string): P256Signer | null {
  const hex = process.env[envName];
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const d = Buffer.from(hex, "hex");
  const pub = p256.getPublicKey(d, false);
  return {
    backend: "local",
    publicXY: async () => ({ x: pub.slice(1, 33), y: pub.slice(33) }),
    signSha256: async (data) => p256.sign(data, d, { prehash: true, lowS: false }).toCompactRawBytes(),
  };
}

function localMac(envName: string): Mac | null {
  const k = process.env[envName];
  if (!k) return null;
  return { backend: "local", hmacHex: async (data) => `0x${createHmac("sha256", k).update(data).digest("hex")}` as Hex };
}

const local: Backend = {
  kycSigner: (slot) => localDigestSigner(slot === "next" ? "NEXT_KYC_SIGNER_KEY" : "KYC_SIGNER_KEY"),
  disclosureSigner: () => localP256("DISCLOSURE_SIGNING_KEY"),
  pairwiseMac: (slot) => localMac(slot === "next" ? "NEXT_KYC_PAIRWISE_KEY" : "KYC_PAIRWISE_KEY"),
};

/** 新增 KMS／HSM 實作時在這裡註冊（例如 "aws-kms": awsKmsBackend） */
const BACKENDS: Record<string, Backend> = { local };

function backend(): Backend {
  const name = process.env.KEY_BACKEND ?? "local";
  const b = BACKENDS[name];
  if (!b) throw new Error(`KEY_BACKEND=${name} 尚未實作（可用：${Object.keys(BACKENDS).join("、")}）`);
  return b;
}

export const kycSigner = (slot: "current" | "next" = "current") => backend().kycSigner(slot);
export const disclosureSigner = () => backend().disclosureSigner();
export const pairwiseMac = (slot: "current" | "next" = "current") => backend().pairwiseMac(slot);

/** EIP-712 簽章（KycCredential）：先算 digest，再交給簽章者 */
export async function signTypedDataWith(s: DigestSigner, td: TypedDataDefinition): Promise<Hex> {
  return s.signDigest(hashTypedData(td));
}

/**
 * KMS 常見的 DER 簽章 → 65 bytes r‖s‖v：s 正規化為 low-s，v 以還原位址比對決定。
 * OpenZeppelin ECDSA 會拒絕 high-s，KMS 不保證 low-s，所以一定要經過這一步。
 */
export async function secp256k1FromDer(der: Uint8Array, digest: Hex, expected: Address): Promise<Hex> {
  const sig = secp256k1.Signature.fromDER(der).normalizeS();
  for (const v of [27, 28]) {
    const out = serializeSignature({ r: toHex(sig.r, { size: 32 }), s: toHex(sig.s, { size: 32 }), v: BigInt(v) });
    if ((await recoverAddress({ hash: digest, signature: out })).toLowerCase() === expected.toLowerCase()) return out;
  }
  throw new Error("KMS 簽章無法還原成預期的簽章者位址");
}

/** 由 KMS 回傳的公鑰（SPKI 結尾的 65 bytes 未壓縮點）推算以太坊位址 */
export function addressFromPublicKey(uncompressed: Uint8Array): Address {
  const pt = secp256k1.ProjectivePoint.fromHex(uncompressed.slice(-65));
  return publicKeyToAddress(toHex(pt.toRawBytes(false)));
}
