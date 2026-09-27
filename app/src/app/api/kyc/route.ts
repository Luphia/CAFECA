import { encodeAbiParameters, keccak256, toHex, zeroAddress, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { authorizeGuardian, currentGuardian, guardianAddress } from "@/server/guardian";
import { checkEvidence, kycIdHash } from "@/server/kyc";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update } from "@/server/store";

function leafHash(field: string, value: string, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "bytes32" }], [field, value, salt]));
}

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
 * L2 KYC（測試網模擬持照 KYC 單位）：身分證件＋引導式臉部影像。
 * 通過後：
 * 1. 鏈上寫入 L2 等級證明（只存欄位的 Merkle root；原文與 salt 回傳給使用者裝置保存）
 * 2. 平台為此身分產生一把獨立的「平台備援金鑰」（HSM 託管），並以平台根金鑰授權，
 *    由使用者的裝置送出 setGuardian 安裝（之後任何裝置或卡片都無法移除）
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const form = await req.formData();
  const b = {
    name: String(form.get("name") ?? "").trim().toUpperCase(),
    idNumber: String(form.get("idNumber") ?? "").trim().toUpperCase(),
    birthday: String(form.get("birthday") ?? ""),
  };
  if (!b.name || !/^[A-Z][12]\d{8}$/.test(b.idNumber) || !b.birthday) {
    throw new HttpError(400, "請填寫姓名、身分證字號（例：A123456789）與生日");
  }
  const existing = (await read()).kyc[me];
  if (existing?.idHash && existing.idHash !== kycIdHash(b.idNumber)) {
    throw new HttpError(403, "此身分已綁定另一份證件，無法更換");
  }
  const evidence = await checkEvidence(form);

  const fields = { name: b.name, idNumber: b.idNumber, birthday: b.birthday, country: "TW" };
  const leaves = Object.entries(fields).map(([field, value]) => {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    return { field, value, salt, hash: leafHash(field, value, salt) };
  });
  const claimsRoot = merkleRoot(leaves.map((l) => l.hash));
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
  await update((s) => {
    const prev = s.kyc[me];
    s.kyc[me] = { level: 2, ts: Date.now(), idHash: kycIdHash(b.idNumber), evidence: [...(prev?.evidence ?? []), evidence] };
  });

  const onChain = await currentGuardian(me);
  const guardian =
    onChain === zeroAddress
      ? { address: guardianAddress(me), authoritySig: await authorizeGuardian(me, guardianAddress(me)) }
      : null;
  return Response.json({ level: 2, claimsRoot, leaves, txHash: r.transactionHash, guardian });
});
