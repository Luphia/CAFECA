import "server-only";
import type { Hex } from "viem";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少環境變數 ${name}：請先執行 npm run deploy 產生 .env.local`);
  return v;
}

/**
 * 伺服器端角色與金鑰（測試網）
 * - OPERATOR：部署者＝bundler＝治理（KYC／發卡方名單）
 * - 其餘各自獨立，對應規格中的不同信任方
 */
export const env = {
  rpcUrl: process.env.RPC_URL ?? "https://boltchain.cafeca.io",
  operatorKey: () => req("DEPLOYER_PRIVATE_KEY") as Hex,
  paymasterSignerKey: () => req("PAYMASTER_SIGNER_KEY") as Hex,
  cardIssuerKey: () => req("CARD_ISSUER_KEY") as Hex,
  kycSignerKey: () => req("KYC_SIGNER_KEY") as Hex,
  visaOperatorKey: () => req("VISA_OPERATOR_KEY") as Hex,
  merchantKey: () => req("MERCHANT_KEY") as Hex,
  guardianRootKey: () => req("GUARDIAN_ROOT_KEY") as Hex,
  guardianSeed: () => req("GUARDIAN_SEED") as Hex,
  sessionSecret: () => req("SESSION_SECRET"),
  kycRecordSecret: () => req("SESSION_SECRET") + ":kyc-record",
  /** K_pairwise：pairwise_id 的 HMAC 金鑰（§16.3），與 kycRecordSecret 分開；未設定時不提供 pairwise_id */
  pairwiseKey: () => process.env.KYC_PAIRWISE_KEY ?? "",
  /** KYC 人工複核後台（/admin/kyc）的登入密碼；未設定時後台停用 */
  kycReviewToken: () => process.env.KYC_REVIEW_TOKEN ?? "",
};
