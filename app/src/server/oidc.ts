import "server-only";
import { createHmac } from "crypto";
import {
  decodeProtectedHeader,
  exportJWK,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestedOidcVerifierAbi, identityAccountFactoryAbi, jwksRegistryAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient, signerOf } from "./chain";
import { env } from "./env";
import { HttpError } from "./session";

/**
 * OIDC 驗證服務（測試網替代 ZK 電路）
 * 1. 驗證 Google／Apple（或測試網開發者登入）的 id_token 簽章、aud、有效期
 * 2. 以 salt 服務算出 idCommitment = keccak(iss, aud, sub, salt) >> 8
 * 3. 確認 JWT 的 nonce 等於合約要求的 nonce（綁定 passkey 公鑰或恢復請求）
 * 4. 確保簽章公鑰已登記在 JwksRegistry（測試網由營運錢包代替共識層寫入）
 * 5. 對公開輸入簽章，作為 AttestedOidcVerifier 的 proof
 */

const ISSUERS = {
  google: { iss: ["https://accounts.google.com", "accounts.google.com"], jwks: "https://www.googleapis.com/oauth2/v3/certs", id: 1 },
  apple: { iss: ["https://appleid.apple.com"], jwks: "https://appleid.apple.com/auth/keys", id: 2 },
  dev: { iss: ["https://dev.cafeca.local"], jwks: "", id: 9 },
} as const;
type Provider = keyof typeof ISSUERS;

const DEV_AUD = "cafeca-testnet-dev";

let jwksCache: Record<string, { at: number; keys: JWK[] }> = {};

async function fetchJwks(provider: Provider): Promise<JWK[]> {
  if (provider === "dev") {
    const priv = JSON.parse(env.devOidcJwk()) as JWK;
    const pub = { ...priv };
    delete pub.d;
    return [{ ...pub, kid: "dev-1", alg: "ES256" }];
  }
  const c = jwksCache[provider];
  if (c && Date.now() - c.at < 10 * 60_000) return c.keys;
  const res = await fetch(ISSUERS[provider].jwks, { cache: "no-store" });
  const json = (await res.json()) as { keys: JWK[] };
  jwksCache = { ...jwksCache, [provider]: { at: Date.now(), keys: json.keys } };
  return json.keys;
}

function b64(s: string): Hex {
  return toHex(Buffer.from(s, "base64url"));
}

/** keyHash = keccak256(abi.encode(bytes, bytes)) >> 8；RSA 用 (n, e)，EC 用 (x, y) */
export function jwkKeyHash(jwk: JWK): Hex {
  const [a, b] = jwk.kty === "RSA" ? [jwk.n!, jwk.e!] : [jwk.x!, jwk.y!];
  const h = keccak256(encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [b64(a), b64(b)]));
  return toHex(BigInt(h) >> 8n, { size: 32 });
}

export function idCommitmentOf(iss: string, aud: string, sub: string): Hex {
  const salt = createHmac("sha256", env.saltSecret()).update(`${iss}|${sub}`).digest();
  const h = keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "bytes32" }],
      [iss, aud, sub, toHex(salt)],
    ),
  );
  return toHex(BigInt(h) >> 8n, { size: 32 });
}

export type VerifiedToken = {
  provider: Provider;
  payload: JWTPayload & { nonce?: string; email?: string };
  jwk: JWK;
  keyHash: Hex;
  idCommitment: Hex;
};

export async function verifyIdToken(idToken: string): Promise<VerifiedToken> {
  const header = decodeProtectedHeader(idToken);
  const unverified = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString()) as JWTPayload;
  const provider = (Object.keys(ISSUERS) as Provider[]).find((p) =>
    (ISSUERS[p].iss as readonly string[]).includes(unverified.iss ?? ""),
  );
  if (!provider) throw new HttpError(400, "不支援的登入提供者");
  if (provider === "dev" && !env.devLogin) throw new HttpError(400, "開發者登入未啟用");

  const keys = await fetchJwks(provider);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(400, "找不到 JWT 的簽章公鑰");
  const audience =
    provider === "google" ? env.googleClientId : provider === "apple" ? env.appleClientId : DEV_AUD;
  if (!audience) throw new HttpError(500, `未設定 ${provider} Client ID`);

  const { payload } = await jwtVerify(idToken, await importJWK(jwk, header.alg), {
    issuer: ISSUERS[provider].iss as unknown as string[],
    audience,
  });
  if (!payload.sub) throw new HttpError(400, "JWT 缺少 sub");
  const iss = provider === "google" ? "https://accounts.google.com" : (payload.iss as string);
  return {
    provider,
    payload: payload as VerifiedToken["payload"],
    jwk,
    keyHash: jwkKeyHash(jwk),
    idCommitment: idCommitmentOf(iss, audience, payload.sub),
  };
}

/** 測試網：營運錢包代替共識層把公鑰寫入 JwksRegistry */
export async function ensureJwksRegistered(t: VerifiedToken) {
  const known = await publicClient.readContract({
    address: DEPLOYMENT.jwks,
    abi: jwksRegistryAbi,
    functionName: "isKnown",
    args: [t.keyHash],
  });
  if (known) return;
  await operatorTx({
    address: DEPLOYMENT.jwks,
    abi: jwksRegistryAbi,
    functionName: "addKey",
    args: [t.keyHash, ISSUERS[t.provider].id],
  });
}

export async function attest(publicInputs: readonly [bigint, bigint, bigint, bigint]): Promise<Hex> {
  const digest = await publicClient.readContract({
    address: DEPLOYMENT.oidcVerifier,
    abi: attestedOidcVerifierAbi,
    functionName: "digest",
    args: [publicInputs],
  });
  return signerOf(env.oidcAttestorKey()).sign({ hash: digest });
}

export async function accountOf(idCommitment: Hex): Promise<{ address: Address; deployed: boolean }> {
  const address = await publicClient.readContract({
    address: DEPLOYMENT.factory,
    abi: identityAccountFactoryAbi,
    functionName: "getAddress",
    args: [idCommitment],
  });
  const code = await publicClient.getCode({ address });
  return { address, deployed: !!code && code !== "0x" };
}

export function nonceMatches(tokenNonce: string | undefined, expected: bigint): boolean {
  if (!tokenNonce) return false;
  try {
    return BigInt(tokenNonce) === expected;
  } catch {
    return false;
  }
}

// ───────────────────────── 測試網開發者登入 ─────────────────────────

export async function issueDevToken(email: string, nonce: string): Promise<string> {
  const jwk = JSON.parse(env.devOidcJwk()) as JWK;
  const key = await importJWK(jwk, "ES256");
  const sub = createHmac("sha256", "dev-sub").update(email.toLowerCase()).digest("hex").slice(0, 24);
  return new SignJWT({ email, nonce })
    .setProtectedHeader({ alg: "ES256", kid: "dev-1" })
    .setIssuer("https://dev.cafeca.local")
    .setAudience(DEV_AUD)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

export async function generateDevJwk(): Promise<string> {
  const { generateKeyPair } = await import("jose");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return JSON.stringify(await exportJWK(privateKey));
}
