import "server-only";
import { createHmac } from "crypto";
import type { Address, Hex } from "viem";
import { CHAIN_ID, DEPLOYMENT, IdentityStatus } from "@/lib/config";
import {
  CREDENTIAL_CLAIMS,
  CREDENTIAL_TTL,
  ZERO32,
  disclosedString,
  kycCredentialTypedData,
  type CredentialClaim,
  type DocType,
  type KycCredential,
  type KycCredentialMessage,
} from "@/lib/kyc-credential";
import { signerOf } from "./chain";
import { env } from "./env";
import { identityState } from "./identity";
import { read, type KycCase } from "./store";

/**
 * KYC Credential 簽發（規格 §16.3）。
 * 資料來源是後台 OCR 擷取、並經自動或人工核准的案件欄位（KycCase.fields）；使用者無法自行填寫。
 */

export type AvailableClaims = {
  /** 目前是否為有效的 L2（v2 active） */
  active: boolean;
  legal_name: string | null;
  doc_type: DocType | null;
  nationality: string | null;
  pairwise_id: boolean;
};

type Source = { name?: string; docType?: DocType; nationality?: string; idHash?: string };

/** 目前實名證明所依據的案件：最新一筆核准、而且有擷取欄位的案件（恢復後重新驗證的案件會取代開戶案件） */
async function sourceOf(account: Address): Promise<Source | null> {
  const s = await read();
  const rec = Object.entries(s.kyc).find(([k]) => k.toLowerCase() === account.toLowerCase())?.[1];
  if (!rec || rec.level < 2) return null;
  const c = (rec.cases ?? [])
    .filter((x): x is KycCase & { fields: NonNullable<KycCase["fields"]> } => x.status === "approved" && !!x.fields)
    .sort((a, b) => (b.processedAt ?? b.createdAt) - (a.processedAt ?? a.createdAt))[0];
  return {
    name: c?.fields.name,
    docType: c?.fields.docType as DocType | undefined,
    nationality: c?.fields.nationality,
    idHash: rec.idHash ?? c?.fields.idNumberHash,
  };
}

/**
 * pairwise_id = HMAC-SHA256(K_pairwise, kycIdHash ‖ audience)
 * 同一人在同一依賴方永遠相同（換裝置、恢復後也相同），不同依賴方之間無法串連，也推不回證號。
 * K_pairwise（KYC_PAIRWISE_KEY）與 kycIdHash 使用的金鑰分開；正式環境放在 HSM。
 */
export function pairwiseId(idHash: string, audience: string): Hex | null {
  const key = env.pairwiseKey();
  if (!key) return null;
  return `0x${createHmac("sha256", key).update(`${idHash}|${audience}`).digest("hex")}`;
}

export async function availableClaims(account: Address): Promise<AvailableClaims> {
  const [src, st] = await Promise.all([sourceOf(account), identityState(account)]);
  const active = !!st && st.status === IdentityStatus.ACTIVE && st.effectiveLevel >= 2;
  return {
    active,
    legal_name: src?.name ?? null,
    doc_type: src?.docType ?? null,
    nationality: src?.nationality ?? null,
    pairwise_id: !!src?.idHash && !!env.pairwiseKey(),
  };
}

export async function issueCredential(account: Address, p: { audience: string; nonce: string; claims: string[] }): Promise<KycCredential | null> {
  if (!DEPLOYMENT.identityRegistry) throw new Error("IdentityRegistry v2 尚未部署，無法簽發 KYC Credential");
  const want = p.claims.filter((c): c is CredentialClaim => (CREDENTIAL_CLAIMS as readonly string[]).includes(c));
  if (!want.length) return null;
  const [src, st] = await Promise.all([sourceOf(account), identityState(account)]);
  if (!st || st.status !== IdentityStatus.ACTIVE || st.effectiveLevel < 2 || !src) throw new Error("目前沒有有效的 L2 實名證明");

  const pid = want.includes("pairwise_id") && src.idHash ? pairwiseId(src.idHash, p.audience) : null;
  const value: Record<CredentialClaim, string | null> = {
    legal_name: src.name ?? null,
    doc_type: src.docType ?? null,
    nationality: src.nationality ?? null,
    pairwise_id: pid,
  };
  const disclosed = want.filter((c) => value[c]);
  if (!disclosed.length) return null;
  const has = (c: CredentialClaim) => disclosed.includes(c);
  const now = Math.floor(Date.now() / 1000);
  const message: KycCredentialMessage = {
    account,
    audience: p.audience,
    nonce: p.nonce,
    attestationNonce: st.nonce.toString(),
    issuedAt: now,
    expiresAt: now + CREDENTIAL_TTL,
    legalName: has("legal_name") ? value.legal_name! : "",
    docType: has("doc_type") ? value.doc_type! : "",
    nationality: has("nationality") ? value.nationality! : "",
    pairwiseId: has("pairwise_id") ? (pid as Hex) : ZERO32,
    disclosed: disclosedString(disclosed),
  };
  const signature = await signerOf(env.kycSignerKey()).signTypedData(kycCredentialTypedData(CHAIN_ID, DEPLOYMENT.identityRegistry, message));
  return { message, signature };
}
