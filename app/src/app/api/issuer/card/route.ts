import { keccak256, toHex, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi, keyringValidatorAbi } from "@/lib/contracts/abis";
import { publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { handle, HttpError, requireSession } from "@/server/session";

/**
 * 發卡方：確認使用者已完成 L2 KYC，並對卡片公鑰簽署 card attestation。
 * 實體卡流程中，這一步會先驗證卡片晶片的 FIDO attestation 憑證鏈（測試網以模擬卡代替）。
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { qx, qy, rpIdHash } = (await req.json()) as { qx: Hex; qy: Hex; rpIdHash: Hex };
  const level = await publicClient.readContract({
    address: DEPLOYMENT.attestation,
    abi: attestationRegistryAbi,
    functionName: "levelOf",
    args: [me],
  });
  if (level < 2) throw new HttpError(403, "需先完成 L2 實名驗證才能申請卡片");
  const serialHash = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const digest = await publicClient.readContract({
    address: DEPLOYMENT.keyring,
    abi: keyringValidatorAbi,
    functionName: "cardAttestationDigest",
    args: [me, qx, qy, rpIdHash, serialHash],
  });
  const sig = await signerOf(env.cardIssuerKey()).sign({ hash: digest });
  return Response.json({ serialHash, issuerSig: sig });
});
