import "server-only";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { operatorTx, publicClient } from "./chain";
import { queryEvents, syncIndex } from "./indexer";

/**
 * 交易額度管理（KeyringValidator v2）：只有 limitAdmin 能調升或調降，使用者不能自行修改。
 * 測試網 limitAdmin＝營運錢包；正式環境改為多簽，後台只負責產生交易。
 */

export const LIMIT_REASONS: Record<number, string> = { 1: "使用者申請", 2: "風控調降", 3: "實名等級變更", 4: "法遵要求", 255: "其他" };


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
  // 伺服器事件索引（P0-d），不再每次從部署區塊掃描
  const logs = await queryEvents({ names: ["LimitsSetByAdmin"], contract: DEPLOYMENT.keyring, where: { account } });
  return logs.map((l) => ({
    block: l.b,
    tx: l.tx,
    perTx: formatUnits(BigInt(String(l.a.perTx)), TWDC_DECIMALS),
    daily: formatUnits(BigInt(String(l.a.daily)), TWDC_DECIMALS),
    reason: Number(l.a.reason),
    admin: l.a.admin as Address,
  }));
}

export async function setLimitsFor(account: Address, perTx: string, daily: string, reason: number): Promise<Hex> {
  const p = parseUnits(perTx, TWDC_DECIMALS);
  const d = parseUnits(daily, TWDC_DECIMALS);
  const rc = await operatorTx({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "setLimitsFor", args: [account, DEPLOYMENT.twdc, p, d, reason] } as never);
  await syncIndex({ force: true }).catch(() => undefined); // 讓紀錄立刻出現
  return rc.transactionHash;
}
