import { zeroAddress } from "viem";
import { authorizeGuardian, currentGuardian, guardianAddress } from "@/server/guardian";
import { intakeEvidence } from "@/server/kyc";
import { enqueue, findCase, publicView, saveCase } from "@/server/kyc-queue";
import { handle, HttpError, requireSession } from "@/server/session";
import { effectiveLevel } from "@/server/identity";
import { read } from "@/server/store";

/**
 * L2 KYC（規格 §14）：使用者只提交「即時拍攝、已疊浮水印」的身分證正反面，以及依 6 個隨機動作錄製的臉部影像。
 * 不輸入任何欄位；姓名、生日、統一編號由團隊自建的後台 OCR 擷取。
 *
 * POST 收件後立即回應 pending，後台依序驗證（src/server/kyc-pipeline.ts）：
 *   高信心 → 自動通過、寫入 L2；中信心 → 人工複核（/admin/kyc）；明確失敗 → 退件並說明原因
 * GET ?case=<id> 查詢結果；通過時一併回傳平台備援金鑰的授權，由使用者裝置送出 setGuardian。
 */
export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  // 已送出的案件還在審核中、或已經通過且仍有效時，不能再送出
  const s = await read();
  const last = Object.entries(s.kyc).find(([k]) => k.toLowerCase() === me.toLowerCase())?.[1]?.cases?.filter((x) => x.purpose === "onboard").sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && ["pending", "processing", "review"].includes(last.status)) throw new HttpError(409, "你已經送出實名驗證，正在審核中，不需要重新送出");
  if (last?.status === "approved" && (await effectiveLevel(me)) >= 2) throw new HttpError(409, "你的實名驗證已經通過");
  const form = await req.formData();
  const c = await intakeEvidence(me, form, "onboard");
  await saveCase(me, { ...c, account: me });
  enqueue(me, c.id);
  return Response.json(publicView(c));
});

export const GET = handle(async (req: Request) => {
  const me = await requireSession();
  const id = new URL(req.url).searchParams.get("case");
  let c;
  if (id) c = await findCase(me, id);
  else {
    const s = await read();
    const rec = Object.entries(s.kyc).find(([k]) => k.toLowerCase() === me.toLowerCase())?.[1];
    c = rec?.cases?.filter((x) => x.purpose === "onboard").sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  if (!c) throw new HttpError(404, "找不到這個驗證案件");
  const view = publicView(c);
  if (c.status === "approved" && c.purpose === "onboard" && c.result?.txHash && (await currentGuardian(me)) === zeroAddress) {
    const address = guardianAddress(me);
    return Response.json({ ...view, guardian: { address, authoritySig: await authorizeGuardian(me, address) } });
  }
  return Response.json({ ...view, guardian: null });
});
