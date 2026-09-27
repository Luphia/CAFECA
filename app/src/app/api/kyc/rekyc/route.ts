import type { Address, Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { accountOf, verifyIdToken } from "@/server/oidc";
import { handle, HttpError } from "@/server/session";

/**
 * R2 恢復：KYC 單位重新驗證本人後，對「新公鑰＋恢復序號」簽章。
 * 測試網以「再次輸入身分證字號」模擬；正式版為視訊或臨櫃驗證。
 */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { idToken: string; account: Address; qx: Hex; qy: Hex; rpIdHash: Hex; idNumber: string };
  const t = await verifyIdToken(b.idToken);
  const acct = await accountOf(t.idCommitment);
  if (acct.address.toLowerCase() !== b.account.toLowerCase()) throw new HttpError(400, "登入帳號與錢包不符");
  const level = await publicClient.readContract({
    address: DEPLOYMENT.attestation,
    abi: attestationRegistryAbi,
    functionName: "levelOf",
    args: [b.account],
  });
  if (level < 2) throw new HttpError(403, "此錢包沒有 L2 實名紀錄，無法走重新 KYC 恢復");
  if (!/^[A-Z][12]\d{8}$/.test(b.idNumber ?? "")) throw new HttpError(400, "請輸入身分證字號");
  const [, n] = await publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "state",
    args: [b.account],
  });
  const digest = await publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "rekycDigest",
    args: [b.account, b.qx, b.qy, b.rpIdHash, n],
  });
  return Response.json({ kycSig: await signerOf(env.kycSignerKey()).sign({ hash: digest }) });
});
