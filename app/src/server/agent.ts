import "server-only";
import { encodeFunctionData, erc20Abi, formatUnits, keccak256, toHex, type Address, type Hex } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { channelValidatorAbi } from "@/lib/contracts/abis";
import { execCall } from "@/lib/userop";
import { publicClient } from "./chain";
import { channelExec } from "./channel";
import { CATALOG, merchantAddress, quote, verifyPayment, type ItemId } from "./merchant";
import { HttpError } from "./session";
import { update, type AgentRecord } from "./store";

/**
 * AI 代理執行器（測試網）：規則式代理，示範 x402 付款流程與政策邊界。
 * 金鑰由伺服器保管，代表規格中的 TEE；正式版在 TDX enclave 內執行並附 attestation。
 */

type Step = { ts: number; text: string; tx?: string };

async function log(id: string, text: string, tx?: string): Promise<Step> {
  const step = { ts: Date.now(), text, tx };
  await update((s) => {
    s.agents[id]?.log.unshift(step);
    if (s.agents[id]) s.agents[id].log = s.agents[id].log.slice(0, 50);
  });
  return step;
}

export async function runPurchase(id: string, rec: AgentRecord, item: ItemId) {
  if (!rec.channel) throw new HttpError(400, "代理尚未建立支出通道");
  const channel = rec.channel as Address;
  const steps: Step[] = [];
  const it = CATALOG[item];

  steps.push(await log(id, `向商家請求「${it.name}」`));
  const q = quote(item);
  const price = BigInt(q.accepts[0].maxAmountRequired);
  steps.push(await log(id, `收到 HTTP 402：需支付 ${formatUnits(price, TWDC_DECIMALS)} TWDC`));

  const [, perTx, , threshold, validUntil] = await publicClient.readContract({
    address: DEPLOYMENT.channelValidator,
    abi: channelValidatorAbi,
    functionName: "policyOf",
    args: [channel],
  });
  if (Number(validUntil) * 1000 < Date.now()) throw new HttpError(400, "通道政策已過期");

  if (price <= threshold && price <= perTx) {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [merchantAddress(), price] });
    const res = await channelExec(channel, execCall(DEPLOYMENT.twdc, data), rec.operatorKey as Hex);
    steps.push(await log(id, "在政策額度內，直接付款", res.txHash));
    const ok = await verifyPayment(res.txHash, item);
    steps.push(await log(id, ok ? `取得資源：${JSON.stringify(it.content())}` : "商家驗證付款失敗"));
    return { status: "paid" as const, steps };
  }

  // 超過門檻：發出 intent，等待主人以卡片確認
  const reasonHash = keccak256(toHex(`${item}|${Date.now()}`));
  const data = encodeFunctionData({
    abi: channelValidatorAbi,
    functionName: "requestIntent",
    args: [merchantAddress(), price, reasonHash],
  });
  const res = await channelExec(channel, execCall(DEPLOYMENT.channelValidator, data), rec.operatorKey as Hex);
  const intentId = await publicClient.readContract({
    address: DEPLOYMENT.channelValidator,
    abi: channelValidatorAbi,
    functionName: "intentCountOf",
    args: [channel],
  });
  steps.push(await log(id, `金額超過確認門檻，已送出請求 #${intentId}，等待主人以卡片確認`, res.txHash));
  await update((s) => {
    s.messages.push({
      id: crypto.randomUUID(),
      from: "system",
      to: rec.owner,
      kind: "agent.intent",
      body: {
        agentId: id,
        agentName: rec.name,
        channel,
        intentId: intentId.toString(),
        token: DEPLOYMENT.twdc,
        to: merchantAddress(),
        amount: price.toString(),
        item,
        itemName: it.name,
      },
      ts: Date.now(),
    });
  });
  return { status: "intent" as const, intentId: intentId.toString(), steps };
}

/** 主人核准後，代理憑交易雜湊向商家取貨 */
export async function claimAfterApproval(id: string, item: ItemId, txHash: Hex) {
  const ok = await verifyPayment(txHash, item);
  const step = await log(
    id,
    ok ? `主人已核准，取得資源：${JSON.stringify(CATALOG[item].content())}` : "商家尚未看到付款",
    txHash,
  );
  return { ok, steps: [step] };
}
