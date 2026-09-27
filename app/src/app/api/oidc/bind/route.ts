import { encodeFunctionData, isAddress, recoverAddress, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { identityAccountFactoryAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { accountOf, attest, ensureJwksRegistered, nonceMatches, verifyIdToken } from "@/server/oidc";
import { handle, HttpError } from "@/server/session";

/**
 * 開戶綁定（先登入、後建金鑰）：
 * - JWT 的 nonce 必須等於 factory.bindNonce(ephemeral, expiry)：登入前瀏覽器產生的一次性金鑰
 * - ephemeral 金鑰簽署「此身分綁定此 passkey」，攔截到 JWT 的人沒有 ephemeral 私鑰
 * 回傳 UserOp 的 initCode（factory.createAccount）。
 */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as {
    idToken: string;
    ephemeral: Address;
    expiry: number;
    qx: Hex;
    qy: Hex;
    rpIdHash: Hex;
    ephemeralSig: Hex;
  };
  if (!isAddress(b.ephemeral)) throw new HttpError(400, "ephemeral 地址錯誤");
  if (b.expiry * 1000 < Date.now()) throw new HttpError(400, "登入授權已過期，請重新登入");

  const t = await verifyIdToken(b.idToken);
  const expiry = BigInt(b.expiry);
  const expected = await publicClient.readContract({
    address: DEPLOYMENT.factory,
    abi: identityAccountFactoryAbi,
    functionName: "bindNonce",
    args: [b.ephemeral, expiry],
  });
  if (!nonceMatches(t.payload.nonce, expected)) throw new HttpError(400, "登入憑證的 nonce 與本次開戶不符，請重新登入");

  const digest = await publicClient.readContract({
    address: DEPLOYMENT.factory,
    abi: identityAccountFactoryAbi,
    functionName: "bindAuthorizationDigest",
    args: [t.idCommitment, b.qx, b.qy, b.rpIdHash],
  });
  const signer = await recoverAddress({ hash: digest, signature: b.ephemeralSig }).catch(() => null);
  if (!signer || signer.toLowerCase() !== b.ephemeral.toLowerCase()) throw new HttpError(400, "金鑰綁定授權簽章無效");

  const acct = await accountOf(t.idCommitment);
  if (acct.deployed) throw new HttpError(409, "此帳號已開戶，請改用登入或恢復");

  await ensureJwksRegistered(t);
  const proof = await attest([BigInt(t.idCommitment), BigInt(t.keyHash), expected, expiry]);
  const bind = {
    qx: b.qx,
    qy: b.qy,
    rpIdHash: b.rpIdHash,
    jwksKeyHash: t.keyHash,
    ephemeral: b.ephemeral,
    expiry,
    proof,
    ephemeralSig: b.ephemeralSig,
  };
  const initCode = (DEPLOYMENT.factory +
    encodeFunctionData({
      abi: identityAccountFactoryAbi,
      functionName: "createAccount",
      args: [t.idCommitment, bind],
    }).slice(2)) as Hex;

  return Response.json({
    address: acct.address,
    idCommitment: t.idCommitment,
    email: t.payload.email ?? null,
    provider: t.provider,
    initCode,
  });
});
