import "server-only";
import type { Hex } from "viem";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少環境變數 ${name}：請先執行 npm run deploy 產生 .env.local`);
  return v;
}

/**
 * 伺服器端角色與金鑰（測試網）
 * - OPERATOR：部署者＝bundler＝共識層系統地址（JWKS）＝治理（KYC／發卡方名單）
 * - 其餘各自獨立，對應規格中的不同信任方
 */
export const env = {
  rpcUrl: process.env.RPC_URL ?? "http://211.22.118.149:8545",
  operatorKey: () => req("DEPLOYER_PRIVATE_KEY") as Hex,
  paymasterSignerKey: () => req("PAYMASTER_SIGNER_KEY") as Hex,
  oidcAttestorKey: () => req("OIDC_ATTESTOR_KEY") as Hex,
  cardIssuerKey: () => req("CARD_ISSUER_KEY") as Hex,
  kycSignerKey: () => req("KYC_SIGNER_KEY") as Hex,
  visaOperatorKey: () => req("VISA_OPERATOR_KEY") as Hex,
  merchantKey: () => req("MERCHANT_KEY") as Hex,
  saltSecret: () => req("SALT_SECRET"),
  sessionSecret: () => req("SESSION_SECRET"),
  devOidcJwk: () => req("DEV_OIDC_JWK"),
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
  appleClientId: process.env.NEXT_PUBLIC_APPLE_CLIENT_ID ?? "",
  devLogin: process.env.NEXT_PUBLIC_DEV_LOGIN === "1",
};
