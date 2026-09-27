import "server-only";
import type { Address, Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { publicClient } from "./chain";
import { read, update, type CardOrder } from "./store";

/**
 * 訂單在卡片「實際綁定上鏈」後才算用掉：發卡方簽了證明但綁定失敗時可以重試。
 * 每次查詢時把已綁定的訂單標記為 used，回傳此帳戶的所有訂單。
 */
export async function settleOrders(owner: Address): Promise<(CardOrder & { id: string })[]> {
  const mine = Object.entries((await read()).cardOrders).filter(([, o]) => o.owner.toLowerCase() === owner.toLowerCase());
  const settled: string[] = [];
  for (const [id, o] of mine) {
    if (o.used || !o.issuedFor) continue;
    const k = await publicClient.readContract({
      address: DEPLOYMENT.keyring,
      abi: keyringValidatorAbi,
      functionName: "getKey",
      args: [owner, o.issuedFor as Hex],
    });
    if (k.keyClass === 2) settled.push(id);
  }
  if (settled.length) {
    await update((s) => {
      for (const id of settled) s.cardOrders[id].used = true;
    });
  }
  return mine.map(([id, o]) => ({ id, ...o, used: o.used || settled.includes(id) }));
}
