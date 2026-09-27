import { encodeFunctionData, getAddress, isAddress, isHex, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { execCall } from "@/lib/userop";
import { prepareUserOp, sendUserOp } from "@/server/bundler";
import { publicClient } from "@/server/chain";
import { currentGuardian, guardianAddress, guardianSigner } from "@/server/guardian";
import { checkEvidence, kycIdHash } from "@/server/kyc";
import { handle, HttpError } from "@/server/session";
import { read, update } from "@/server/store";

/**
 * 裝置全部遺失時：在新裝置重新拍證件、錄臉部影像，平台比對開戶時的 KYC 紀錄後，
 * 以此身分的「平台備援金鑰」簽署 initiateRecovery（48 小時；已綁卡 7 天）。
 * 期間主帳戶轉出凍結，所有舊裝置與卡片都能取消。
 */
export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const account = String(form.get("account") ?? "");
  const [qx, qy, rpIdHash] = ["qx", "qy", "rpIdHash"].map((k) => String(form.get(k) ?? "")) as Hex[];
  const idNumber = String(form.get("idNumber") ?? "");
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
  const guardian = await currentGuardian(a);
  if (guardian.toLowerCase() !== guardianAddress(a).toLowerCase()) {
    throw new HttpError(403, "此身分尚未啟用平台備援金鑰");
  }
  const rec = Object.entries((await read()).kyc).find(([k]) => k.toLowerCase() === a.toLowerCase())?.[1];
  // 先比對證件號碼，再消耗活體挑戰
  if (!rec?.idHash || rec.idHash !== kycIdHash(idNumber)) throw new HttpError(403, "身分驗證未通過：證件資料與開戶 KYC 紀錄不符");
  const evidence = await checkEvidence(form);

  const callData = execCall(
    DEPLOYMENT.recovery,
    encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "initiateRecovery", args: [qx, qy, rpIdHash, false] }),
  );
  const { userOp, userOpHash } = await prepareUserOp({ sender: a, validator: DEPLOYMENT.recovery, callData });
  userOp.signature = await guardianSigner(a).signMessage({ message: { raw: userOpHash } });
  const res = await sendUserOp(userOp);
  if (!res.success) throw new HttpError(400, `恢復請求執行失敗：${res.reason ?? "未知原因"}`);
  await update((s) => {
    const k = Object.keys(s.kyc).find((x) => x.toLowerCase() === a.toLowerCase());
    if (k) s.kyc[k].evidence = [...(s.kyc[k].evidence ?? []), evidence];
  });
  const p = await publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [a] });
  return Response.json({ txHash: res.txHash, readyAt: Number(p[2]) });
});
