import { DEPLOYMENT, CHAIN_ID } from "@/lib/config";
import { CLAIMS, SIGNIN_VERSION } from "@/lib/signin";

/**
 * GET /.well-known/cafeca-configuration（next.config rewrite 到這裡）
 * 第三方網站或 SDK 取得錢包入口、鏈與合約位址；公開資訊，不含任何秘密，開放 CORS。
 */
export function GET(req: Request) {
  const origin = process.env.PUBLIC_ORIGIN ?? new URL(req.url).origin;
  const body = {
    issuer: origin,
    protocol: "cafeca-signin",
    versions: [SIGNIN_VERSION],
    authorization_endpoint: `${origin}/dl/auth`,
    custom_scheme: "cafeca://auth",
    sdk: `${origin}/sdk/cafeca-connect.js`,
    modes: ["popup", "redirect", "post"],
    channel: { endpoint: `${origin}/dl/sign`, relay: `${origin}/api/channel`, methods: ["sign_message", "sign_typed_data", "send_calls"], max_ttl_seconds: 30 * 24 * 3600 },
    claims_supported: CLAIMS,
    max_ttl_seconds: 600,
    chain: { id: CHAIN_ID, rpc: process.env.PUBLIC_RPC_URL ?? "https://boltchain.cafeca.io" },
    contracts: DEPLOYMENT.deployed
      ? { factory: DEPLOYMENT.factory, keyring: DEPLOYMENT.keyring, attestation: DEPLOYMENT.attestation, recovery: DEPLOYMENT.recovery, twdc: DEPLOYMENT.twdc, entryPoint: DEPLOYMENT.entryPoint }
      : null,
    eip712: { name: "CAFECA Sign-In", version: "1", primaryType: "SignIn", verifyingContract: "<account>" },
  };
  return Response.json(body, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  });
}
