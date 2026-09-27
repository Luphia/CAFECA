import "server-only";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { boltchain } from "@/lib/config";
import { env } from "./env";

export const publicClient = createPublicClient({ chain: boltchain, transport: http(env.rpcUrl, { timeout: 30_000 }) });

export function operatorWallet() {
  return createWalletClient({
    account: privateKeyToAccount(env.operatorKey()),
    chain: boltchain,
    transport: http(env.rpcUrl, { timeout: 60_000 }),
  });
}

export function signerOf(pk: Hex) {
  return privateKeyToAccount(pk);
}

/** 營運錢包的交易需要序列化，避免 nonce 衝突 */
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** 送出營運錢包交易並等待確認 */
export async function operatorTx(params: Parameters<ReturnType<typeof operatorWallet>["writeContract"]>[0]) {
  return serialize(async () => {
    const wallet = operatorWallet();
    const hash = await wallet.writeContract(params);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`交易失敗 ${hash}`);
    return receipt;
  });
}
