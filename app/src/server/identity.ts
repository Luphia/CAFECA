import "server-only";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { DEPLOYMENT, IdentityStatus } from "@/lib/config";
import { attestationRegistryAbi, identityRegistryAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient, signerOf } from "./chain";
import { env } from "./env";
import type { KycCase } from "./store";

/**
 * 身分證明寫入（規格 §16.2）：v1 AttestationRegistry 與 v2 IdentityRegistry 雙寫。
 * - v1：只為了 KeyringValidator 的綁卡門檻（immutable 指向 v1），沒有 nonce、不能撤銷
 * - v2：依賴方讀的版本，每筆帶 nonce、可暫停與撤銷、簽章者分 PROTOTYPE／PRODUCTION
 */

export type IdentityState = {
  subjectType: number;
  level: number;
  effectiveLevel: number;
  status: number;
  expiry: number;
  issuedAt: number;
  nonce: bigint;
  signer: Address;
  signerClass: number;
};

export const hasV2 = () => !!DEPLOYMENT.identityRegistry;

export async function identityState(account: Address): Promise<IdentityState | null> {
  if (!DEPLOYMENT.identityRegistry) return null;
  const r = await publicClient.readContract({ address: DEPLOYMENT.identityRegistry, abi: identityRegistryAbi, functionName: "statusOf", args: [account] });
  return { subjectType: r[0], level: r[1], effectiveLevel: r[2], status: r[3], expiry: Number(r[4]), issuedAt: Number(r[5]), nonce: r[7], signer: r[8], signerClass: r[9] };
}

/** 目前實名等級：有 v2 時以 v2 的有效等級為準（撤銷、暫停、簽章者失效都會降為 0），否則讀 v1 */
export async function effectiveLevel(account: Address): Promise<number> {
  if (DEPLOYMENT.identityRegistry) {
    return publicClient.readContract({ address: DEPLOYMENT.identityRegistry, abi: identityRegistryAbi, functionName: "levelOf", args: [account] });
  }
  return publicClient.readContract({ address: DEPLOYMENT.attestation, abi: attestationRegistryAbi, functionName: "levelOf", args: [account] });
}

async function nextNonce(account: Address): Promise<bigint> {
  return (await publicClient.readContract({ address: DEPLOYMENT.identityRegistry!, abi: identityRegistryAbi, functionName: "nonceOf", args: [account] })) + 1n;
}

const jur = (iso2: string) => `0x${Buffer.from(iso2.toUpperCase().slice(0, 2), "ascii").toString("hex")}` as Hex;

/** 簽發證明：v1（綁卡相容）＋ v2（依賴方） */
export async function attestIdentity(
  account: Address,
  p: { subjectType?: 0 | 1; level: number; claimsRoot: Hex; expiry: number; jurisdiction?: string },
): Promise<{ v1Tx: Hex; v2Tx?: Hex; nonce?: bigint }> {
  const kyc = signerOf(env.kycSignerKey());
  // v1 只描述自然人
  let v1Tx: Hex = "0x";
  if ((p.subjectType ?? 0) === 0) {
    const digest = await publicClient.readContract({
      address: DEPLOYMENT.attestation,
      abi: attestationRegistryAbi,
      functionName: "attestationDigest",
      args: [account, p.level, p.claimsRoot, p.expiry],
    });
    const sig = await kyc.sign({ hash: digest });
    v1Tx = (await operatorTx({ address: DEPLOYMENT.attestation, abi: attestationRegistryAbi, functionName: "attest", args: [account, p.level, p.claimsRoot, p.expiry, sig] } as never)).transactionHash;
  }
  if (!DEPLOYMENT.identityRegistry) return { v1Tx };
  const reg = DEPLOYMENT.identityRegistry;
  const st = p.subjectType ?? 0;
  const j = jur(p.jurisdiction ?? "TW");
  const nonce = await nextNonce(account);
  const digest = await publicClient.readContract({ address: reg, abi: identityRegistryAbi, functionName: "attestDigest", args: [account, st, p.level, p.expiry, p.claimsRoot, j, nonce] });
  const sig = await kyc.sign({ hash: digest });
  const rc = await operatorTx({ address: reg, abi: identityRegistryAbi, functionName: "attest", args: [account, st, p.level, p.expiry, p.claimsRoot, j, nonce, sig] } as never);
  return { v1Tx, v2Tx: rc.transactionHash, nonce };
}

/** 暫停或撤銷（v2）。v1 沒有撤銷能力，依賴方一律讀 v2 */
export async function changeIdentityStatus(account: Address, action: "suspend" | "revoke", reason: number): Promise<Hex | null> {
  if (!DEPLOYMENT.identityRegistry) return null;
  const reg = DEPLOYMENT.identityRegistry;
  const cur = await identityState(account);
  if (!cur || cur.status === IdentityStatus.NONE || cur.status === IdentityStatus.REVOKED) return null;
  if (action === "suspend" && cur.status !== IdentityStatus.ACTIVE) return null;
  const nonce = await nextNonce(account);
  const status = action === "suspend" ? IdentityStatus.SUSPENDED : IdentityStatus.REVOKED;
  const digest = await publicClient.readContract({ address: reg, abi: identityRegistryAbi, functionName: "statusDigest", args: [account, status, reason, nonce] });
  const sig = await signerOf(env.kycSignerKey()).sign({ hash: digest });
  const rc = await operatorTx({ address: reg, abi: identityRegistryAbi, functionName: action, args: [account, reason, nonce, sig] } as never);
  return rc.transactionHash;
}

function merkleRoot(leaves: Hex[]): Hex {
  let level = [...leaves];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const [a, b] = [level[i], level[i + 1] ?? level[i]];
      next.push(keccak256((a < b ? `${a}${b.slice(2)}` : `${b}${a.slice(2)}`) as Hex));
    }
    level = next;
  }
  return level[0];
}

/** 目前的 claimsRoot：證據雜湊的 Merkle root（§16.3 會改為各欄位加鹽雜湊） */
export function claimsRootOf(c: KycCase): Hex {
  return merkleRoot((["front", "back", "face"] as const).map((k) => keccak256(toHex(`${k}:${c.hashes[k]}`)) as Hex));
}
