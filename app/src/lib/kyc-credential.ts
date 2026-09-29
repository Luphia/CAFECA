import { hashTypedData, type Address, type Hex } from "viem";

/**
 * KYC Credential（規格 §16.3）：可驗證的實名 claims。
 *
 * 由 KYC 簽章者（與 IdentityRegistry v2 的 attestation 同一把）以 EIP-712 簽署，綁定：
 * - account：使用者身分合約
 * - audience：依賴方網站 origin（等於 SignIn 的 domain）
 * - nonce：這次 SignIn 的 nonce，credential 只能用在這一次登入
 * - attestationNonce：簽發當下 IdentityRegistry v2 的 nonce；之後被暫停、撤銷或重新簽發，nonce 就會改變
 *
 * 依賴方驗證：recover 出簽章者 == statusOf(account).signer、status 為 active、nonce 相同。
 * 不上鏈、不經過 CAFECA 伺服器，網站以公開 RPC 就能完成。
 */

/** 需要 KYC Credential 才能提供的 claims */
export const CREDENTIAL_CLAIMS = ["legal_name", "doc_type", "nationality", "pairwise_id"] as const;
export type CredentialClaim = (typeof CREDENTIAL_CLAIMS)[number];

export const CREDENTIAL_TTL = 10 * 60;

export type DocType = "national_id" | "resident_permit" | "passport";

export type KycCredentialMessage = {
  account: Address;
  audience: string;
  nonce: string;
  attestationNonce: string; // uint64，十進位字串
  issuedAt: number;
  expiresAt: number;
  /** 未提供的欄位為空字串；是否提供以 disclosed 為準 */
  legalName: string;
  docType: string;
  nationality: string;
  pairwiseId: Hex; // 未提供時為 0x00…00
  /** 這份 credential 揭露的 claims，逗號分隔並排序 */
  disclosed: string;
};

export type KycCredential = { message: KycCredentialMessage; signature: Hex };

export const ZERO32 = `0x${"0".repeat(64)}` as Hex;

export const KYC_CREDENTIAL_TYPES = {
  KycCredential: [
    { name: "account", type: "address" },
    { name: "audience", type: "string" },
    { name: "nonce", type: "string" },
    { name: "attestationNonce", type: "uint64" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "legalName", type: "string" },
    { name: "docType", type: "string" },
    { name: "nationality", type: "string" },
    { name: "pairwiseId", type: "bytes32" },
    { name: "disclosed", type: "string" },
  ],
} as const;

/** EIP-712 domain：綁定鏈與 IdentityRegistry v2 */
export function kycCredentialDomain(chainId: number, identityRegistry: Address) {
  return { name: "CAFECA KYC Credential", version: "1", chainId, verifyingContract: identityRegistry } as const;
}

export function kycCredentialTypedData(chainId: number, identityRegistry: Address, m: KycCredentialMessage) {
  return {
    domain: kycCredentialDomain(chainId, identityRegistry),
    types: KYC_CREDENTIAL_TYPES,
    primaryType: "KycCredential" as const,
    message: { ...m, attestationNonce: BigInt(m.attestationNonce), issuedAt: BigInt(m.issuedAt), expiresAt: BigInt(m.expiresAt) },
  };
}

export function kycCredentialHash(chainId: number, identityRegistry: Address, m: KycCredentialMessage): Hex {
  return hashTypedData(kycCredentialTypedData(chainId, identityRegistry, m));
}

export function disclosedString(claims: readonly string[]): string {
  return [...new Set(claims)].filter((c) => (CREDENTIAL_CLAIMS as readonly string[]).includes(c)).sort().join(",");
}

export const DOC_TYPE_LABEL: Record<DocType, string> = { national_id: "國民身分證", resident_permit: "居留證", passport: "護照" };
