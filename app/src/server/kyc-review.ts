import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { p256 } from "@noble/curves/p256";
import { writeAudit } from "./audit";
import { env } from "./env";
import { productionMode } from "./mode";
import { HttpError } from "./session";
import { read, update, type Staff, type StaffRole } from "./store";

/**
 * 管理後台人員（規格 §16.6 P3-A3）：每人一個帳號、以 Passkey 登入，稽核紀錄的「誰」是已驗證的人員帳號。
 *
 * - 角色：admin（人員與依賴方管理）、kyc（KYC 與法人複核）、disclosure（資料調閱核准）、limits（交易額度）、audit（稽核紀錄唯讀）
 * - 第一位管理者：尚無啟用中的 admin 時，以 KYC_REVIEW_TOKEN 建立（bootstrap）；之後這個密碼不能再登入
 * - 其他人員：admin 發邀請碼（72 小時、一次性），受邀者在自己的裝置建立 Passkey
 * - 每次請求都重新讀取人員狀態，停用或調整角色立即生效
 */

export const ROLES: StaffRole[] = ["admin", "kyc", "disclosure", "limits", "audit"];
export const ROLE_LABEL: Record<StaffRole, string> = {
  admin: "人員與依賴方管理",
  kyc: "KYC 與法人複核",
  disclosure: "資料調閱核准",
  limits: "交易額度",
  audit: "稽核紀錄（唯讀）",
};

const COOKIE = "cafeca_staff";
const CHAL = "cafeca_staff_chal";
const INVITE_TTL = 72 * 3600 * 1000;
const key = () => new TextEncoder().encode(env.sessionSecret() + ":staff");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** 稽核與畫面上顯示的人員身分：姓名＋帳號 id（同名也分得開） */
export const whoOf = (s: Pick<Staff, "id" | "name">) => `${s.name}（${s.id}）`;

export type PasskeyReg = { credentialId: string; qx: string; qy: string; label?: string };

function checkPasskey(p: PasskeyReg | undefined) {
  if (!p || !/^[A-Za-z0-9_-]{16,}$/.test(p.credentialId) || !/^0x[0-9a-fA-F]{64}$/.test(p.qx) || !/^0x[0-9a-fA-F]{64}$/.test(p.qy)) throw new HttpError(400, "Passkey 資料錯誤");
  try {
    p256.ProjectivePoint.fromHex("04" + p.qx.slice(2) + p.qy.slice(2)).assertValidity();
  } catch {
    throw new HttpError(400, "Passkey 公鑰無效");
  }
  return { credentialId: p.credentialId, qx: p.qx.toLowerCase(), qy: p.qy.toLowerCase(), label: (p.label ?? "").slice(0, 40) || "Passkey", addedAt: Date.now() };
}

function cleanRoles(roles: unknown): StaffRole[] {
  const r = [...new Set(Array.isArray(roles) ? roles : [])].filter((x): x is StaffRole => ROLES.includes(x as StaffRole));
  if (!r.length) throw new HttpError(400, "至少指定一個角色");
  return r;
}

const activeAdmins = (s: Record<string, Staff>) => Object.values(s).filter((x) => x.active && x.roles.includes("admin"));

async function startSession(st: Staff) {
  const jwt = await new SignJWT({ sid: st.id }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(key());
  (await cookies()).set(COOKIE, jwt, { httpOnly: true, sameSite: "strict", secure: productionMode(), path: "/", maxAge: 8 * 3600 });
}

// ───────────────────────── 第一位管理者 ─────────────────────────

export async function staffStatus() {
  const s = (await read()).staff ?? {};
  return { bootstrap: activeAdmins(s).length === 0 && !!env.kycReviewToken() };
}

export async function bootstrapAdmin(token: string, name: string, passkey: PasskeyReg) {
  const expected = env.kycReviewToken();
  if (!expected) throw new HttpError(503, "尚未設定 KYC_REVIEW_TOKEN");
  if (!timingSafeEqual(createHash("sha256").update(token).digest(), createHash("sha256").update(expected).digest())) {
    await writeAudit({ who: "anonymous", action: "staff.bootstrap.fail" });
    throw new HttpError(401, "密碼錯誤");
  }
  const n = name.trim().slice(0, 40);
  if (!n) throw new HttpError(400, "請填寫姓名");
  const pk = checkPasskey(passkey);
  let created: Staff | null = null;
  await update((s) => {
    s.staff ??= {};
    if (activeAdmins(s.staff).length) throw new HttpError(409, "已經有管理者；請向管理者索取邀請碼");
    created = { id: "st" + randomBytes(4).toString("hex"), name: n, roles: [...ROLES], passkeys: [pk], active: true, createdAt: Date.now(), createdBy: "bootstrap" };
    s.staff[created.id] = created;
  });
  const st = created as unknown as Staff;
  await writeAudit({ who: whoOf(st), action: "staff.bootstrap", staff: st.id, roles: st.roles });
  await startSession(st);
  return publicStaff(st);
}

// ───────────────────────── 邀請與加入 ─────────────────────────

export async function inviteStaff(by: Staff, p: { name?: string; roles?: unknown; staffId?: string }) {
  const code = randomBytes(18).toString("base64url");
  let target: { name: string; roles: StaffRole[]; staffId?: string };
  if (p.staffId) {
    const st = (await read()).staff?.[p.staffId];
    if (!st) throw new HttpError(404, "找不到人員");
    target = { name: st.name, roles: st.roles, staffId: st.id };
  } else {
    const name = (p.name ?? "").trim().slice(0, 40);
    if (!name) throw new HttpError(400, "請填寫姓名");
    target = { name, roles: cleanRoles(p.roles) };
  }
  await update((s) => {
    s.staffInvites ??= {};
    for (const [k, v] of Object.entries(s.staffInvites)) if (v.exp < Date.now() || v.used) delete s.staffInvites[k];
    s.staffInvites[sha(code)] = { ...target, by: by.id, exp: Date.now() + INVITE_TTL, used: false };
  });
  await writeAudit({ who: whoOf(by), action: target.staffId ? "staff.invite.key" : "staff.invite", name: target.name, roles: target.roles, staff: target.staffId });
  return { code, expiresAt: Date.now() + INVITE_TTL };
}

export async function inviteInfo(code: string) {
  const inv = (await read()).staffInvites?.[sha(code)];
  if (!inv || inv.used || inv.exp < Date.now()) throw new HttpError(404, "邀請碼無效或已過期");
  return { name: inv.name, roles: inv.roles, addKey: !!inv.staffId };
}

export async function joinStaff(code: string, passkey: PasskeyReg) {
  const pk = checkPasskey(passkey);
  let st: Staff | null = null;
  await update((s) => {
    const h = sha(code);
    const inv = s.staffInvites?.[h];
    if (!inv || inv.used || inv.exp < Date.now()) throw new HttpError(404, "邀請碼無效或已過期");
    s.staff ??= {};
    if (Object.values(s.staff).some((x) => x.passkeys.some((k) => k.credentialId === pk.credentialId))) throw new HttpError(409, "這把 Passkey 已經登記過");
    inv.used = true;
    if (inv.staffId) {
      const cur = s.staff[inv.staffId];
      if (!cur) throw new HttpError(404, "找不到人員");
      cur.passkeys.push(pk);
      st = cur;
    } else {
      st = { id: "st" + randomBytes(4).toString("hex"), name: inv.name, roles: inv.roles, passkeys: [pk], active: true, createdAt: Date.now(), createdBy: inv.by };
      s.staff[st.id] = st;
    }
  });
  const x = st as unknown as Staff;
  await writeAudit({ who: whoOf(x), action: "staff.join", staff: x.id, credential: pk.credentialId.slice(0, 16) });
  await startSession(x);
  return publicStaff(x);
}

// ───────────────────────── Passkey 登入 ─────────────────────────

export async function loginChallenge() {
  const c = randomBytes(32);
  const jwt = await new SignJWT({ c: b64u(c) }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key());
  (await cookies()).set(CHAL, jwt, { httpOnly: true, sameSite: "strict", secure: productionMode(), path: "/", maxAge: 300 });
  return { challenge: b64u(c) };
}

/** 驗證 WebAuthn assertion：challenge、origin、rpId、UP／UV 旗標與 ES256 簽章 */
export async function staffLogin(req: Request, a: { credentialId?: string; authenticatorData?: string; clientDataJSON?: string; signature?: string }) {
  const jar = await cookies();
  const chal = jar.get(CHAL)?.value;
  jar.delete(CHAL);
  if (!chal) throw new HttpError(400, "登入逾時，請重試");
  let expected: string;
  try {
    expected = String((await jwtVerify(chal, key())).payload.c);
  } catch {
    throw new HttpError(400, "登入逾時，請重試");
  }
  const s = (await read()).staff ?? {};
  const st = Object.values(s).find((x) => x.passkeys.some((k) => k.credentialId === a.credentialId));
  const pk = st?.passkeys.find((k) => k.credentialId === a.credentialId);
  const fail = async (m: string) => {
    await writeAudit({ who: st ? whoOf(st) : "anonymous", action: "staff.login.fail", reason: m });
    return new HttpError(401, m);
  };
  if (!st || !pk) throw await fail("這把 Passkey 不是管理後台人員的 Passkey");
  if (!st.active) throw await fail("帳號已停用");
  const cdRaw = Buffer.from(a.clientDataJSON ?? "", "base64url");
  const auth = Buffer.from(a.authenticatorData ?? "", "base64url");
  let cd: { type?: string; challenge?: string; origin?: string };
  try {
    cd = JSON.parse(cdRaw.toString("utf8"));
  } catch {
    throw await fail("clientDataJSON 格式錯誤");
  }
  const origin = allowedOrigin(req);
  if (cd.type !== "webauthn.get" || cd.challenge !== expected) throw await fail("challenge 不符");
  if (!origin || cd.origin !== origin) throw await fail("來源網址不符");
  if (auth.length < 37 || !auth.subarray(0, 32).equals(createHash("sha256").update(new URL(origin).hostname).digest())) throw await fail("rpId 不符");
  if ((auth[32] & 0x05) !== 0x05) throw await fail("需要使用者驗證（指紋、臉部或 PIN）");
  const digest = createHash("sha256").update(Buffer.concat([auth, createHash("sha256").update(cdRaw).digest()])).digest();
  let ok = false;
  try {
    const sig = p256.Signature.fromDER(Buffer.from(a.signature ?? "", "base64url").toString("hex"));
    ok = p256.verify(sig, digest, "04" + pk.qx.slice(2) + pk.qy.slice(2), { lowS: false });
  } catch {
    ok = false;
  }
  if (!ok) throw await fail("Passkey 簽章驗證失敗");
  await update((x) => {
    const cur = x.staff![st.id];
    cur.lastLoginAt = Date.now();
    const k = cur.passkeys.find((y) => y.credentialId === pk.credentialId);
    if (k) k.lastUsedAt = Date.now();
  });
  await writeAudit({ who: whoOf(st), action: "login", staff: st.id });
  await startSession(st);
  return publicStaff(st);
}

/** 正式環境只接受 PUBLIC_ORIGIN；開發環境接受瀏覽器送來的 Origin（同源 fetch 一定帶） */
function allowedOrigin(req: Request): string | null {
  const pub = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, "");
  const o = req.headers.get("origin");
  if (productionMode()) return pub ?? null;
  return o ?? pub ?? null;
}

export async function staffLogout() {
  (await cookies()).delete(COOKIE);
}

// ───────────────────────── 權限檢查 ─────────────────────────

export async function currentStaff(): Promise<Staff | null> {
  const t = (await cookies()).get(COOKIE)?.value;
  if (!t) return null;
  try {
    const { payload } = await jwtVerify(t, key());
    const st = (await read()).staff?.[String(payload.sid)];
    return st && st.active ? st : null;
  } catch {
    return null;
  }
}

/** 需要指定角色之一（admin 不自動擁有其他角色，雙人覆核與職能分離才有意義） */
export async function requireStaff(...roles: StaffRole[]): Promise<Staff> {
  const st = await currentStaff();
  if (!st) throw new HttpError(401, "請先以 Passkey 登入管理後台");
  if (roles.length && !roles.some((r) => st.roles.includes(r))) throw new HttpError(403, `需要以下角色之一：${roles.map((r) => ROLE_LABEL[r]).join("、")}`);
  return st;
}

/** 相容舊呼叫：回傳稽核用的人員身分字串 */
export async function requireReviewer(...roles: StaffRole[]): Promise<string> {
  return whoOf(await requireStaff(...roles));
}

export function publicStaff(s: Staff) {
  return {
    id: s.id,
    name: s.name,
    who: whoOf(s),
    roles: s.roles,
    active: s.active,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
    lastLoginAt: s.lastLoginAt ?? null,
    passkeys: s.passkeys.map((k) => ({ credentialId: k.credentialId, label: k.label, addedAt: k.addedAt, lastUsedAt: k.lastUsedAt ?? null })),
  };
}

// ───────────────────────── 人員管理 ─────────────────────────

export async function listStaff() {
  return Object.values((await read()).staff ?? {})
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(publicStaff);
}

export async function manageStaff(by: Staff, b: { action?: string; staffId?: string; roles?: unknown; active?: boolean; credentialId?: string }) {
  if (!b.staffId) throw new HttpError(400, "缺少 staffId");
  const id = b.staffId;
  let detail: Record<string, unknown> = {};
  await update((s) => {
    const st = s.staff?.[id];
    if (!st) throw new HttpError(404, "找不到人員");
    if (b.action === "roles") {
      const roles = cleanRoles(b.roles);
      if (st.roles.includes("admin") && !roles.includes("admin") && activeAdmins(s.staff!).length <= 1 && st.active) throw new HttpError(409, "不能移除最後一位管理者");
      detail = { from: st.roles, to: roles };
      st.roles = roles;
    } else if (b.action === "active") {
      if (typeof b.active !== "boolean") throw new HttpError(400, "active 必須是 true 或 false");
      if (!b.active && st.roles.includes("admin") && activeAdmins(s.staff!).length <= 1 && st.active) throw new HttpError(409, "不能停用最後一位管理者");
      st.active = b.active;
      detail = { active: b.active };
    } else if (b.action === "removeKey") {
      if (st.passkeys.length <= 1) throw new HttpError(409, "至少保留一把 Passkey；要停止使用請停用帳號");
      const before = st.passkeys.length;
      st.passkeys = st.passkeys.filter((k) => k.credentialId !== b.credentialId);
      if (st.passkeys.length === before) throw new HttpError(404, "找不到這把 Passkey");
      detail = { credential: String(b.credentialId).slice(0, 16) };
    } else throw new HttpError(400, "action 必須是 roles、active 或 removeKey");
  });
  await writeAudit({ who: whoOf(by), action: `staff.${b.action}`, staff: id, ...detail });
}

/** 稽核紀錄：寫入 hash-chained 的 data/audit/audit.jsonl（見 server/audit.ts） */
export async function audit(e: Record<string, unknown>) {
  const { who, action, ...rest } = e as { who?: string; action?: string };
  await writeAudit({ who: String(who ?? "system"), action: String(action ?? "unknown"), ...rest });
}
