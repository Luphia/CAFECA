import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { DEPLOYMENT, KeyClass } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { handle, HttpError } from "@/server/session";
import { read, update } from "@/server/store";

/**
 * 既有裝置已送出 addDailyKey 後回填身分地址。不需信任呼叫者：伺服器直接查鏈上，
 * 只有這把公鑰確實是該身分的裝置金鑰時才接受。
 */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { id: string; address: Address };
  if (!isAddress(b.address)) throw new HttpError(400, "地址格式錯誤");
  const p = (await read()).pairings[b.id];
  if (!p) throw new HttpError(404, "找不到配對請求");
  const keyId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [p.qx as Hex, p.qy as Hex]));
  const k = await publicClient.readContract({
    address: DEPLOYMENT.keyring,
    abi: keyringValidatorAbi,
    functionName: "getKey",
    args: [getAddress(b.address), keyId],
  });
  if (k.keyClass !== KeyClass.DAILY) throw new HttpError(409, "這把金鑰尚未加入該身分");
  await update((s) => {
    s.pairings[b.id].address = getAddress(b.address);
  });
  return Response.json({ ok: true });
});
