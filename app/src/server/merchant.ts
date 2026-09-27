import "server-only";
import { decodeEventLog, erc20Abi, parseUnits, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { publicClient, signerOf } from "./chain";
import { env } from "./env";

/** 模擬的 x402 商家：AI 代理可以用 TWDC 購買資源 */
export const CATALOG = {
  "market-data": {
    name: "即時市場數據 API（100 次呼叫）",
    price: parseUnits("50", TWDC_DECIMALS),
    content: () => ({ BTC: 3_120_000, ETH: 118_000, TWSE: 23_410, note: "模擬資料" }),
  },
  translation: {
    name: "專業翻譯服務（1,000 字）",
    price: parseUnits("120", TWDC_DECIMALS),
    content: () => ({ result: "Hello, this is a simulated professional translation." }),
  },
  "gpu-hour": {
    name: "GPU 算力 1 小時（H200）",
    price: parseUnits("800", TWDC_DECIMALS),
    content: () => ({ endpoint: "ssh gpu-7.cafeca.test", expiresIn: "1h", note: "模擬資源" }),
  },
} as const;
export type ItemId = keyof typeof CATALOG;

export function merchantAddress(): Address {
  return signerOf(env.merchantKey()).address;
}

export function quote(item: ItemId) {
  const it = CATALOG[item];
  return {
    x402Version: 1,
    error: "payment required",
    accepts: [
      {
        scheme: "exact",
        network: "boltchain-testnet",
        asset: DEPLOYMENT.twdc,
        payTo: merchantAddress(),
        maxAmountRequired: it.price.toString(),
        resource: `/api/merchant/${item}`,
        description: it.name,
      },
    ],
  };
}

/** 檢查交易中是否有足額 TWDC 轉給商家 */
export async function verifyPayment(txHash: Hex, item: ItemId): Promise<boolean> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success") return false;
  const payTo = merchantAddress().toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== DEPLOYMENT.twdc.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "Transfer" && ev.args.to.toLowerCase() === payTo && ev.args.value >= CATALOG[item].price) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}
