import { encodeAbiParameters, keccak256, toHex, zeroHash, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { publicClient, signerOf } from "@/server/chain";
import { env } from "@/server/env";
import { effectiveLevel } from "@/server/identity";
import { handle, HttpError, requireSession } from "@/server/session";
import { settleOrders } from "@/server/cards";
import { update } from "@/server/store";

/**
 * 發卡方：確認 (1) 已完成 L2 KYC (2) 有一筆已付款、未使用的訂單，然後對卡片公鑰簽署 card attestation。
 * 掛失補發時帶 replacesKeyId：新卡綁定的同時汰換舊卡（舊卡無法再使用）。
 * 實體卡流程中，這一步還會驗證卡片晶片的 FIDO attestation 憑證鏈（測試網以模擬卡代替）；
 * 補發在正式版還需重新進行臉部影像比對。
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const { qx, qy, rpIdHash, replacesKeyId } = (await req.json()) as { qx: Hex; qy: Hex; rpIdHash: Hex; replacesKeyId?: Hex };
  // 以 v2 的有效等級為準：撤銷、暫停、簽章者失效的身分不能購買或綁定實體卡
  const level = await effectiveLevel(me);
  if (level < 2) throw new HttpError(403, "需先完成實名驗證才能取得實體卡");
  const replaces = replacesKeyId ?? zeroHash;
  if (replaces !== zeroHash) {
    const k = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [me, replaces] });
    if (k.keyClass !== 2) throw new HttpError(400, "要汰換的不是這個身分的卡片");
  }
  const order = (await settleOrders(me)).find((o) => !o.used);
  if (!order) throw new HttpError(402, "請先完成購買付款");

  const serialHash = keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));
  const digest = await publicClient.readContract({
    address: DEPLOYMENT.keyring,
    abi: keyringValidatorAbi,
    functionName: "cardAttestationDigest",
    args: [me, qx, qy, rpIdHash, serialHash, replaces],
  });
  const sig = await signerOf(env.cardIssuerKey()).sign({ hash: digest });
  const id = order.id;
  await update((s) => {
    s.cardOrders[id].issuedFor = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));
    if (replaces !== zeroHash) s.cardOrders[id].replaces = replaces;
  });
  return Response.json({ serialHash, replacesKeyId: replaces, issuerSig: sig });
});
