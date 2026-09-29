import { DEPLOYMENT, CHAIN_ID } from "@/lib/config";
import { CLAIMS, SIGNIN_VERSION } from "@/lib/signin";

/**
 * GET /.well-known/cafeca-configuration（next.config rewrite 到這裡）
 * 第三方網站或 SDK 取得錢包入口、鏈與合約位址；公開資訊，不含任何秘密，開放 CORS。
 */
/**
 * 對外網址：PUBLIC_ORIGIN 優先；沒有設定時依反向代理的 X-Forwarded-Host／X-Forwarded-Proto 推算，
 * 避免部署在代理後方時公布成 http://localhost:10002。
 */
function publicOrigin(req: Request): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

export function GET(req: Request) {
  const origin = publicOrigin(req);
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
    chain: { id: CHAIN_ID, rpc: process.env.PUBLIC_RPC_URL ?? `${origin}/api/rpc`, explorer: "https://boltchain.cafeca.io" },
    contracts: DEPLOYMENT.deployed
      ? { factory: DEPLOYMENT.factory, keyring: DEPLOYMENT.keyring, attestation: DEPLOYMENT.attestation, recovery: DEPLOYMENT.recovery, twdc: DEPLOYMENT.twdc, entryPoint: DEPLOYMENT.entryPoint, identityRegistry: DEPLOYMENT.identityRegistry ?? null }
      : null,
    eip712: { name: "CAFECA Sign-In", version: "1", primaryType: "SignIn", verifyingContract: "<account>" },
  };
  return Response.json(body, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" },
  });
}
