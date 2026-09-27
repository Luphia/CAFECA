import { encodeFunctionData, getAddress, isAddress, isHex, type Hex } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { execCall } from "@/lib/userop";
import { prepareUserOp, sendUserOp } from "@/server/bundler";
import { publicClient } from "@/server/chain";
import { currentGuardian, guardianAddress, guardianSigner } from "@/server/guardian";
import { intakeEvidence } from "@/server/kyc";
import { runPipeline, sameSubject } from "@/server/kyc-pipeline";
import { handle, HttpError } from "@/server/session";
import { read, update } from "@/server/store";

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
  const guardian = await currentGuardian(a);
  if (guardian.toLowerCase() !== guardianAddress(a).toLowerCase()) {
    throw new HttpError(403, "此身分尚未啟用平台備援金鑰");
  }
  const key = Object.keys((await read()).kyc).find((k) => k.toLowerCase() === a.toLowerCase());
  const rec = key ? (await read()).kyc[key] : undefined;
  const onboard = rec?.cases?.find((c) => c.purpose === "onboard" && c.status === "approved");
  if (!rec || !onboard) throw new HttpError(403, "找不到此身分的實名驗證紀錄");
  // 重新拍證件＋錄臉部影像，後台確認與開戶時是同一人
  const intake = await intakeEvidence(a, form, "recover");
  const c = await runPipeline(intake);
  const same = await sameSubject(onboard, c);
  c.checks.sameSubject = same;
  if (c.status !== "approved" || !same.ok) {
    c.status = c.status === "rejected" ? "rejected" : "review";
    await update((s) => {
      s.kyc[key!].cases = [...(s.kyc[key!].cases ?? []), c];
    });
    throw new HttpError(403, "身分驗證未通過或需要人工複核，我們會通知你結果");
  }

  const callData = execCall(
    DEPLOYMENT.recovery,
    encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "initiateRecovery", args: [qx, qy, rpIdHash, false] }),
  );
  const { userOp, userOpHash } = await prepareUserOp({ sender: a, validator: DEPLOYMENT.recovery, callData });
  userOp.signature = await guardianSigner(a).signMessage({ message: { raw: userOpHash } });
  const res = await sendUserOp(userOp);
  if (!res.success) throw new HttpError(400, `恢復請求執行失敗：${res.reason ?? "未知原因"}`);
  await update((s) => {
    s.kyc[key!].cases = [...(s.kyc[key!].cases ?? []), c];
  });
  const p = await publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "pending", args: [a] });
  return Response.json({ txHash: res.txHash, readyAt: Number(p[2]) });
});
