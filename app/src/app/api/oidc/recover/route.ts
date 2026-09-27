import type { Address, Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { recoveryValidatorAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { accountOf, attest, ensureJwksRegistered, nonceMatches, verifyIdToken } from "@/server/oidc";
import { handle, HttpError } from "@/server/session";

/** 恢復：JWT nonce 必須等於 recovery.recoveryNonce(account, 新公鑰, 恢復序號, expiry) */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as {
    idToken: string;
    account: Address;
    qx: Hex;
    qy: Hex;
    rpIdHash: Hex;
    expiry: number;
  };
  const t = await verifyIdToken(b.idToken);
  const acct = await accountOf(t.idCommitment);
  if (acct.address.toLowerCase() !== b.account.toLowerCase()) throw new HttpError(400, "登入帳號與要恢復的錢包不符");

  const [, n] = await publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "state",
    args: [b.account],
  });
  const expiry = BigInt(b.expiry);
  const expected = await publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "recoveryNonce",
    args: [b.account, b.qx, b.qy, b.rpIdHash, n, expiry],
  });
  if (!nonceMatches(t.payload.nonce, expected)) throw new HttpError(400, "JWT nonce 與恢復請求不符");

  await ensureJwksRegistered(t);
  const proof = await attest([BigInt(t.idCommitment), BigInt(t.keyHash), expected, expiry]);
  return Response.json({
    oidc: { idCommitment: t.idCommitment, jwksKeyHash: t.keyHash, expiry: b.expiry, proof },
  });
});
