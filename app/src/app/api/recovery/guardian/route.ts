import { getAddress, isAddress, isHex, type Hex } from "viem";
import { DEPLOYMENT, IdentityStatus } from "@/lib/config";
import { attestationRegistryAbi } from "@/lib/contracts/abis";
import { publicClient } from "@/server/chain";
import { currentGuardian, guardianAddress } from "@/server/guardian";
import { intakeEvidence } from "@/server/kyc";
import { enqueue, findCase, publicView, saveCase } from "@/server/kyc-queue";
import { identityState } from "@/server/identity";
import { handle, HttpError } from "@/server/session";
import { read } from "@/server/store";

/**
 * 裝置全部遺失時：在新裝置重新即時拍攝證件（浮水印版）、依 6 個隨機動作錄臉部影像，後台確認與開戶時是同一人後，
 * 以此身分的「平台備援金鑰」簽署 initiateRecovery（48 小時；已綁卡 7 天）。
 * 期間主帳戶轉出凍結，所有舊裝置與卡片都能取消。
 */
export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const account = String(form.get("account") ?? "");
  const [qx, qy, rpIdHash] = ["qx", "qy", "rpIdHash"].map((k) => String(form.get(k) ?? "")) as Hex[];
  if (!isAddress(account) || ![qx, qy, rpIdHash].every((v) => isHex(v) && v.length === 66)) {
    throw new HttpError(400, "參數格式錯誤");
  }
  const a = getAddress(account);
  const level = await publicClient.readContract({
    address: DEPLOYMENT.attestation,
    abi: attestationRegistryAbi,
    functionName: "levelOf",
    args: [a],
  });
  if (level < 2) throw new HttpError(403, "此身分沒有完成實名驗證，平台沒有備援金鑰可以協助恢復");
  // v2 被撤銷（例如證據偽造）時不協助恢復；因前一次恢復而暫停的仍可重新驗證
  if ((await identityState(a))?.status === IdentityStatus.REVOKED) throw new HttpError(403, "此身分的實名證明已被撤銷，無法以平台備援金鑰恢復");
  const guardian = await currentGuardian(a);
  if (guardian.toLowerCase() !== guardianAddress(a).toLowerCase()) {
    throw new HttpError(403, "此身分尚未啟用平台備援金鑰");
  }
  const key = Object.keys((await read()).kyc).find((k) => k.toLowerCase() === a.toLowerCase());
  const rec = key ? (await read()).kyc[key] : undefined;
  const onboard = rec?.cases?.find((c) => c.purpose === "onboard" && c.status === "approved");
  if (!rec || !onboard) throw new HttpError(403, "找不到此身分的實名驗證紀錄");
  // 重新拍證件＋錄臉部影像；後台驗證並確認與開戶時是同一人後，才以平台備援金鑰發起恢復
  const c = await intakeEvidence(a, form, "recover");
  await saveCase(a, { ...c, account: a, recovery: { qx, qy, rpIdHash } });
  enqueue(a, c.id);
  return Response.json(publicView(c));
});

/** 查詢恢復案件：GET ?account=<地址>&case=<id>（案件 id 只有送出的裝置知道） */
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const account = q.get("account") ?? "";
  const id = q.get("case") ?? "";
  if (!isAddress(account) || !/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, "參數格式錯誤");
  const c = await findCase(account, id);
  if (!c || c.purpose !== "recover") throw new HttpError(404, "找不到這個恢復案件");
  return Response.json(publicView(c));
});
