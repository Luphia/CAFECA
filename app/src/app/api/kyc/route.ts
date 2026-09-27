import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { handle, HttpError, requireSession } from "@/server/session";
import { update } from "@/server/store";

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
 * 模擬 L2 KYC（測試網）：正式版由持照 KYC 單位執行證件＋活體辨識。
 * 鏈上只寫入 claimsRoot；欄位原文與 salt 回傳給使用者裝置保存，伺服器不留存。
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const b = (await req.json()) as { name: string; idNumber: string; birthday: string };
  if (!b.name || !/^[A-Z][12]\d{8}$/.test(b.idNumber ?? "") || !b.birthday) {
    throw new HttpError(400, "請填寫姓名、身分證字號（例：A123456789）與生日");
  }
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
    s.kyc[me] = { level: 2, ts: Date.now() };
  });
  return Response.json({ level: 2, claimsRoot, leaves, txHash: r.transactionHash });
});
