import "server-only";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENT } from "@/lib/config";
import { recoveryValidatorAbi } from "@/lib/contracts/abis";
import { publicClient, signerOf } from "./chain";
import { env } from "./env";

/**
 * 平台備援金鑰（測試網模擬 HSM）
 * - 每個帳戶一把獨立金鑰：由種子＋帳戶地址衍生，單一金鑰外洩只影響一個帳戶
 * - 正式版：金鑰在 HSM 內產生、不可匯出；簽署需通過重新 KYC 與雙人覆核，並寫入稽核紀錄
 */
function guardianKey(account: Address, generation = 0): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [env.guardianSeed(), account, BigInt(generation)],
    ),
  );
}

export function guardianAddress(account: Address, generation = 0): Address {
  return privateKeyToAccount(guardianKey(account, generation)).address;
}

export function guardianSigner(account: Address, generation = 0) {
  return signerOf(guardianKey(account, generation));
}

/** 平台根金鑰（離線）授權：把這把備援金鑰安裝到帳戶 */
export async function authorizeGuardian(account: Address, guardian: Address) {
  const st = await publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "state",
    args: [account],
  });
  const digest = await publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "guardianDigest",
    args: [account, guardian, st[3]],
  });
  return signerOf(env.guardianRootKey()).sign({ hash: digest });
}

export async function currentGuardian(account: Address): Promise<Address> {
  return publicClient.readContract({
    address: DEPLOYMENT.recovery,
    abi: recoveryValidatorAbi,
    functionName: "guardianOf",
    args: [account],
  });
}
