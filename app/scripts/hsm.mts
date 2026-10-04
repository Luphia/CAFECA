/**
 * HSM（PKCS#11）檢查：npm run hsm -- status
 * 讀 .env.local 的 PKCS11_* 設定，確認每把金鑰存在、不可匯出，並各做一次簽章自我測試。
 * 建立金鑰與切換由 npm run cutover -- prepare（KEY_BACKEND_NEXT=pkcs11）處理。
 */
import { existsSync, readFileSync } from "fs";

if (existsSync(".env.local"))
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
const { pkcs11DigestSigner, pkcs11Extractable, pkcs11Mac, pkcs11P256 } = await import("../src/server/keys-pkcs11");
const { keccak256, toHex, recoverAddress } = await import("viem");
const { p256 } = await import("@noble/curves/p256");
const { createHash } = await import("crypto");

let bad = 0;
const row = (ok: boolean, msg: string) => {
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✕"} ${msg}`);
};
console.log(`PKCS11_MODULE=${process.env.PKCS11_MODULE} token=${process.env.PKCS11_TOKEN_LABEL}`);
for (const env of ["PKCS11_KYC_SIGNER_LABEL", "PKCS11_NEXT_KYC_SIGNER_LABEL"]) {
  if (!process.env[env]) continue;
  try {
    const s = pkcs11DigestSigner(env);
    const addr = await s.address();
    const d = keccak256(toHex(`hsm-selftest-${Date.now()}`));
    const ok = (await recoverAddress({ hash: d, signature: await s.signDigest(d) })) === addr;
    const ex = await pkcs11Extractable("ec", process.env[env]!);
    row(ok && !ex, `${env}「${process.env[env]}」secp256k1 ${addr}${ex ? "（可匯出！）" : ""}`);
  } catch (e) {
    row(false, `${env}：${(e as Error).message}`);
  }
}
if (process.env.PKCS11_DISCLOSURE_LABEL) {
  try {
    const s = pkcs11P256("PKCS11_DISCLOSURE_LABEL")!;
    const { x, y } = await s.publicXY();
    const msg = new TextEncoder().encode("hsm-selftest");
    const sig = await s.signSha256(msg);
    const ok = p256.verify(sig, createHash("sha256").update(msg).digest(), new Uint8Array([4, ...x, ...y]), { lowS: false });
    const ex = await pkcs11Extractable("ec", process.env.PKCS11_DISCLOSURE_LABEL);
    row(ok && !ex, `PKCS11_DISCLOSURE_LABEL「${process.env.PKCS11_DISCLOSURE_LABEL}」P-256${ex ? "（可匯出！）" : ""}`);
  } catch (e) {
    row(false, `PKCS11_DISCLOSURE_LABEL：${(e as Error).message}`);
  }
}
for (const env of ["PKCS11_PAIRWISE_LABEL", "PKCS11_NEXT_PAIRWISE_LABEL"]) {
  if (!process.env[env]) continue;
  try {
    const m = pkcs11Mac(env)!;
    const a = await m.hmacHex("selftest"), b = await m.hmacHex("selftest");
    const ex = await pkcs11Extractable("hmac", process.env[env]!);
    row(a === b && a.length === 66 && !ex, `${env}「${process.env[env]}」HMAC-SHA256${ex ? "（可匯出！）" : ""}`);
  } catch (e) {
    row(false, `${env}：${(e as Error).message}`);
  }
}
process.exit(bad ? 1 : 0);
