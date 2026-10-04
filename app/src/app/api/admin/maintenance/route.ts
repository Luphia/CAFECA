import { requireStaff, whoOf } from "@/server/kyc-review";
import { runMaintenance } from "@/server/maintenance";
import { policy } from "@/server/policy";
import { retentionTargets } from "@/server/retention";
import { termsStats } from "@/server/terms";
import { handle } from "@/server/session";

/** 政策與保存期限：GET 目前的政策值與將被清除的案件（預覽）；POST 立即執行排程工作（admin） */
export const GET = handle(async () => {
  await requireStaff("admin", "audit");
  const t = await retentionTargets();
  return Response.json({ policy: policy(), terms: await termsStats(), pending: t.map((x) => ({ account: x.account, caseId: x.caseId, why: x.why, days: Math.floor(x.age / 86400_000) })) });
});

export const POST = handle(async () => {
  const me = await requireStaff("admin");
  return Response.json(await runMaintenance(whoOf(me)));
});
