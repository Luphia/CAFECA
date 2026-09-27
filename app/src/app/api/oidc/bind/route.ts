import { encodeFunctionData, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { identityAccountFactoryAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { accountOf, attest, ensureJwksRegistered, nonceMatches, verifyIdToken } from "@/server/oidc";
import { handle, HttpError } from "@/server/session";

/**
 * 開戶綁定：JWT 的 nonce 必須等於 factory.bindNonce(qx, qy, rpIdHash, expiry)，
 * 也就是這張 JWT 只能用來綁定「這一把」passkey。
 * 回傳 UserOp 的 initCode（factory.createAccount）。
 */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { idToken: string; qx: Hex; qy: Hex; rpIdHash: Hex; expiry: number };
  const t = await verifyIdToken(b.idToken);
  const expiry = BigInt(b.expiry);
  const expected = await publicClient.readContract({
    address: DEPLOYMENT.factory,
    abi: identityAccountFactoryAbi,
    functionName: "bindNonce",
    args: [b.qx, b.qy, b.rpIdHash, expiry],
  });
  if (!nonceMatches(t.payload.nonce, expected)) throw new HttpError(400, "JWT nonce 與 passkey 不符");

  const acct = await accountOf(t.idCommitment);
  if (acct.deployed) throw new HttpError(409, "此帳號已開戶，請改用登入或恢復");

  await ensureJwksRegistered(t);
  const proof = await attest([BigInt(t.idCommitment), BigInt(t.keyHash), expected, expiry]);
  const bind = { qx: b.qx, qy: b.qy, rpIdHash: b.rpIdHash, jwksKeyHash: t.keyHash, expiry, proof };
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
