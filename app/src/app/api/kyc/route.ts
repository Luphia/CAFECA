import { keccak256, toHex, zeroAddress, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { authorizeGuardian, currentGuardian, guardianAddress } from "@/server/guardian";
import { intakeEvidence } from "@/server/kyc";
import { runPipeline } from "@/server/kyc-pipeline";
import { handle, requireSession } from "@/server/session";
import { update } from "@/server/store";

function merkleRoot(leaves: Hex[]): Hex {
  let level = [...leaves];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const [a, b] = [level[i], level[i + 1] ?? level[i]];
      next.push(keccak256(a < b ? `${a}${b.slice(2)}` as Hex : `${b}${a.slice(2)}` as Hex));
    }
    level = next;
  }
  return level[0];
}

/**
 * L2 KYC（規格 §14）：使用者只提交「即時拍攝、已疊浮水印」的身分證正反面，以及依 6 個隨機動作錄製的臉部影像。
 * 不輸入任何欄位；姓名、生日、統一編號由團隊自建的後台 OCR 擷取。
 * 通過後：
 * 1. 鏈上寫入 L2 等級證明（只存證據雜湊的 Merkle root，不含個資）
 * 2. 平台為此身分產生獨立的備援金鑰並以根金鑰授權，由使用者裝置送出 setGuardian
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const form = await req.formData();
  const intake = await intakeEvidence(me, form, "onboard");
  const c = await runPipeline(intake);
  await update((s) => {
    const prev = s.kyc[me];
    s.kyc[me] = { level: c.status === "approved" ? 2 : prev?.level ?? 0, ts: Date.now(), idHash: prev?.idHash, cases: [...(prev?.cases ?? []), c] };
  });
  if (c.status !== "approved") {
    return Response.json({ status: c.status, caseId: c.id, checks: c.checks });
  }

  const leaves = (["front", "back", "face"] as const).map((k) => keccak256(toHex(`${k}:${c.hashes[k]}`)) as Hex);
  const claimsRoot = merkleRoot(leaves);
  const expiry = Math.floor(Date.now() / 1000) + 365 * 86400;
  const digest = await publicClient.readContract({
    address: DEPLOYMENT.attestation,
    abi: attestationRegistryAbi,
    functionName: "attestationDigest",
    args: [me, 2, claimsRoot, expiry],
  });
  const sig = await signerOf(env.kycSignerKey()).sign({ hash: digest });
  const r = await operatorTx({
    address: DEPLOYMENT.attestation,
    abi: attestationRegistryAbi,
    functionName: "attest",
    args: [me, 2, claimsRoot, expiry, sig],
  });

  const onChain = await currentGuardian(me);
  const guardian =
    onChain === zeroAddress
      ? { address: guardianAddress(me), authoritySig: await authorizeGuardian(me, guardianAddress(me)) }
      : null;
  return Response.json({ status: c.status, caseId: c.id, checks: c.checks, claimsRoot, txHash: r.transactionHash, guardian });
});
