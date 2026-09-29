import { inviteStaff, listStaff, manageStaff, requireStaff, ROLE_LABEL, ROLES, whoOf } from "@/server/kyc-review";
import { handle } from "@/server/session";

/**
 * 人員管理（admin）
 * GET → 人員列表
 * POST { action: "invite", name, roles[] } → 邀請碼（只顯示一次）
 * POST { action: "invite", staffId } → 為既有人員新增 Passkey 的邀請碼
 * POST { action: "roles" | "active" | "removeKey", staffId, … }
 */
export const GET = handle(async () => {
  const me = await requireStaff("admin");
  return Response.json({ me: whoOf(me), roles: ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r] })), staff: await listStaff() });
});

export const POST = handle(async (req: Request) => {
  const me = await requireStaff("admin");
  const b = (await req.json().catch(() => ({}))) as { action?: string; name?: string; roles?: unknown; staffId?: string; active?: boolean; credentialId?: string };
  if (b.action === "invite") return Response.json(await inviteStaff(me, b));
  await manageStaff(me, b);
  return Response.json({ ok: true });
});
