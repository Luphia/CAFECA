import "server-only";
import { formatUnits, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient } from "./chain";

/**
 * 交易額度管理（KeyringValidator v2）：只有 limitAdmin 能調升或調降，使用者不能自行修改。
 * 測試網 limitAdmin＝營運錢包；正式環境改為多簽，後台只負責產生交易。
 */

export const LIMIT_REASONS: Record<number, string> = { 1: "使用者申請", 2: "風控調降", 3: "實名等級變更", 4: "法遵要求", 255: "其他" };

const ADMIN_EVENT = parseAbiItem(
  "event LimitsSetByAdmin(address indexed account, address indexed token, uint128 perTx, uint128 daily, uint8 reason, address admin)",
);

/** 目前部署的 KeyringValidator 是否支援管理者調整（v1 沒有 limitAdmin） */
export async function limitAdmin(): Promise<Address | null> {
  return publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "limitAdmin" }).catch(() => null);
}

export async function limitsOf(account: Address) {
  const [lim, sp, st] = await Promise.all([
    publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "limits", args: [DEPLOYMENT.twdc, account] }),
    publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "spent", args: [DEPLOYMENT.twdc, account] }),
    publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "accountState", args: [account] }),
  ]);
  const now = Number((await publicClient.getBlock()).timestamp);
  const inWindow = now - Number(sp[1]) < 24 * 3600;
  return {
    initialized: st[2],
    perTx: formatUnits(lim[0], TWDC_DECIMALS),
    daily: formatUnits(lim[1], TWDC_DECIMALS),
    spentToday: inWindow ? formatUnits(sp[0], TWDC_DECIMALS) : "0",
  };
}

export async function limitHistory(account: Address) {
  const head = await publicClient.getBlockNumber({ cacheTime: 0 }); // 不用快取：剛送出的調整要馬上出現在紀錄裡
  const from = BigInt(DEPLOYMENT.startBlock ?? 0);
  const out: { block: number; tx: Hex; perTx: string; daily: string; reason: number; admin: Address }[] = [];
  for (let lo = from; lo <= head; lo += 10_000n) {
    const hi = lo + 9_999n > head ? head : lo + 9_999n;
    const logs = await publicClient.getLogs({ address: DEPLOYMENT.keyring, event: ADMIN_EVENT, args: { account }, fromBlock: lo, toBlock: hi }).catch(() => []);
    for (const l of logs)
      out.push({ block: Number(l.blockNumber), tx: l.transactionHash, perTx: formatUnits(l.args.perTx!, TWDC_DECIMALS), daily: formatUnits(l.args.daily!, TWDC_DECIMALS), reason: l.args.reason!, admin: l.args.admin! });
  }
  return out.reverse();
}

export async function setLimitsFor(account: Address, perTx: string, daily: string, reason: number): Promise<Hex> {
  const p = parseUnits(perTx, TWDC_DECIMALS);
  const d = parseUnits(daily, TWDC_DECIMALS);
  const rc = await operatorTx({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "setLimitsFor", args: [account, DEPLOYMENT.twdc, p, d, reason] } as never);
  return rc.transactionHash;
}
