import "server-only";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getAddress, keccak256, toHex, type Address } from "viem";
import { DEPLOYMENT, IdentityStatus } from "@/lib/config";
import { memberValidatorAbi } from "@/lib/contracts/abis";
import { publicClient } from "./chain";
import { attestIdentity, changeIdentityStatus, identityState } from "./identity";
import { legalNameOf } from "./kyc-credential";
import { HttpError } from "./session";
import { read, update, type EntityRecord, type GcisCompany } from "./store";

/**
 * 法人帳戶驗證（規格 §16.4、issue #1）
 *
 * 1. 經濟部商工登記公示資料（data.gcis.nat.gov.tw）依統編查詢，只接受「核准設立」。
 * 2. 申請人必須是這個法人帳戶的 ADMIN，而且是有效 L2；證件姓名與登記的代表人姓名相同 → 自動通過。
 * 3. 不是代表人本人 → 代理人路徑：上傳代表人簽章的授權書，由人工複核（/admin/entity）。
 * 4. 通過後以 IdentityRegistry v2 簽發 subjectType = 1 的 L2 證明；一個統編只綁一個法人帳戶。
 * 5. 每日重新查詢：公司狀況改變 → 撤銷（原因碼 3）；代表人或變更日期改變 → 暫停（原因碼 4），需重新驗證。
 *
 * 目前只支援公司登記；商業登記（行號）、有限合夥與財團／社團法人之後加入。
 */

export const REASON_ENTITY_DISSOLVED = 3;
export const REASON_REPRESENTATIVE_CHANGED = 4;
/** 經濟部商工登記公示資料：公司登記基本資料（可用 GCIS_COMPANY_URL 覆寫，測試用） */
const GCIS_COMPANY = process.env.GCIS_COMPANY_URL ?? "https://data.gcis.nat.gov.tw/od/data/api/5F64D864-61CB-4D0D-8AD9-492047CC1EA6";
const ACTIVE_STATUS = "核准設立";

export enum Role {
  NONE = 0,
  OPERATOR = 1,
  ADMIN = 2,
}

/** 統一編號檢查碼（財政部 2023 年起：加權和可被 5 整除；第 7 碼為 7 時另一種算法也可） */
export function validUbn(ubn: string): boolean {
  if (!/^\d{8}$/.test(ubn)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  const sum = ubn.split("").reduce((acc, d, i) => {
    const p = Number(d) * w[i];
    return acc + Math.floor(p / 10) + (p % 10);
  }, 0);
  return sum % 5 === 0 || (ubn[6] === "7" && (sum + 1) % 5 === 0);
}

/** 姓名比對：去掉空白、全形轉半形 */
export function normName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s　·．.]/g, "")
    .trim();
}

export async function gcisLookup(ubn: string): Promise<GcisCompany | null> {
  const url = `${GCIS_COMPANY}?$format=json&$filter=Business_Accounting_NO eq ${ubn}&$skip=0&$top=1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`商工登記查詢失敗（HTTP ${r.status}）`);
  const text = await r.text();
  if (!text.trim()) return null;
  const list = JSON.parse(text) as Record<string, unknown>[];
  const c = list[0];
  if (!c) return null;
  return {
    ubn: String(c.Business_Accounting_NO ?? ubn),
    name: String(c.Company_Name ?? ""),
    status: String(c.Company_Status_Desc ?? ""),
    responsible: String(c.Responsible_Name ?? ""),
    changeDate: String(c.Change_Of_Approval_Data ?? ""),
    setupDate: String(c.Company_Setup_Date ?? ""),
    location: String(c.Company_Location ?? ""),
    capital: Number(c.Capital_Stock_Amount ?? 0),
    fetchedAt: Date.now(),
  };
}

export const hasEntity = () => !!DEPLOYMENT.memberValidator && !!DEPLOYMENT.entityFactory;

export async function roleOf(member: Address, entity: Address): Promise<Role> {
  if (!DEPLOYMENT.memberValidator) return Role.NONE;
  return Number(await publicClient.readContract({ address: DEPLOYMENT.memberValidator, abi: memberValidatorAbi, functionName: "roleOf", args: [member, entity] })) as Role;
}

export async function membersOf(entity: Address) {
  const [list, roles] = await publicClient.readContract({ address: DEPLOYMENT.memberValidator!, abi: memberValidatorAbi, functionName: "membersOf", args: [entity] });
  return list.map((m, i) => ({ member: m, role: Number(roles[i]) as Role }));
}

export async function isEntity(entity: Address): Promise<boolean> {
  if (!DEPLOYMENT.memberValidator) return false;
  const st = await publicClient.readContract({ address: DEPLOYMENT.memberValidator, abi: memberValidatorAbi, functionName: "entityState", args: [entity] }).catch(() => null);
  return !!st?.[0];
}

const keyOf = (a: string) => a.toLowerCase();

/** 登記由錢包建立的法人帳戶（鏈上確認是法人帳戶、而且呼叫者是成員） */
export async function registerEntity(me: Address, entity: Address, displayName?: string) {
  if (!hasEntity()) throw new HttpError(503, "法人帳戶合約尚未部署");
  if (!(await isEntity(entity))) throw new HttpError(400, "這個地址不是法人帳戶");
  if ((await roleOf(me, entity)) === Role.NONE) throw new HttpError(403, "你不是這個法人帳戶的成員");
  return update((s) => {
    s.entities ??= {};
    const cur = s.entities[keyOf(entity)];
    const rec: EntityRecord = cur ?? { entity: getAddress(entity), creator: me, createdAt: Date.now() };
    if (displayName !== undefined) rec.displayName = displayName.trim().slice(0, 40) || undefined;
    s.entities[keyOf(entity)] = rec;
    return rec;
  });
}

/** 我所屬的法人帳戶（伺服器已登記的法人中，鏈上仍是成員者） */
export async function myEntities(me: Address) {
  const s = await read();
  const recs = Object.values(s.entities ?? {});
  const out = [];
  for (const r of recs) {
    const role = await roleOf(me, r.entity as Address).catch(() => Role.NONE);
    if (role !== Role.NONE) out.push({ ...publicEntity(r), role });
  }
  return out;
}

export function publicEntity(r: EntityRecord) {
  const a = r.application;
  return {
    entity: r.entity,
    displayName: r.displayName ?? r.verified?.name ?? null,
    verified: r.verified ? { ubn: r.verified.ubn, name: r.verified.name, approvedAt: r.verified.approvedAt } : null,
    monitor: r.monitor ?? null,
    application: a
      ? {
          id: a.id,
          ubn: a.ubn,
          status: a.status,
          path: a.path,
          at: a.at,
          companyName: a.gcis?.name ?? null,
          reasons: a.status === "rejected" ? [a.review?.note ?? Object.values(a.checks).find((c) => !c.ok)?.detail ?? "未通過"] : [],
          result: a.result ?? null,
        }
      : null,
  };
}

function claimsRootOf(c: GcisCompany): `0x${string}` {
  return keccak256(toHex(`ubn:${c.ubn}|name:${c.name}|responsible:${c.responsible}|change:${c.changeDate}`));
}

/** 申請驗證 */
export async function applyEntity(me: Address, entity: Address, ubn: string, letter?: File | null) {
  if (!hasEntity()) throw new HttpError(503, "法人帳戶合約尚未部署");
  if (!validUbn(ubn)) throw new HttpError(400, "統一編號格式或檢查碼錯誤");
  if ((await roleOf(me, entity)) !== Role.ADMIN) throw new HttpError(403, "只有法人帳戶的管理者可以申請驗證");
  const s0 = await read();
  const rec0 = s0.entities?.[keyOf(entity)];
  if (!rec0) throw new HttpError(404, "請先登記這個法人帳戶");
  if (rec0.application && ["pending", "review"].includes(rec0.application.status)) throw new HttpError(409, "已經送出申請，審核中");
  if (rec0.verified && rec0.monitor?.status !== "suspended") throw new HttpError(409, "這個法人帳戶已經通過驗證");
  if (rec0.verified && rec0.verified.ubn !== ubn) throw new HttpError(409, `這個法人帳戶已綁定統一編號 ${rec0.verified.ubn}，不能改綁`);
  const bound = Object.values(s0.entities ?? {}).find((r) => r.verified?.ubn === ubn && keyOf(r.entity) !== keyOf(entity));
  if (bound) throw new HttpError(409, "這個統一編號已經綁定其他法人帳戶");

  const applicantName = await legalNameOf(me);
  if (!applicantName) throw new HttpError(403, "申請人需要有效的 L2 實名驗證（證件姓名）");

  const gcis = await gcisLookup(ubn).catch((e: Error) => {
    throw new HttpError(502, e.message);
  });
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  checks.registry = gcis ? { ok: true, detail: `商工登記：${gcis.name}` } : { ok: false, detail: "商工登記查無此統一編號（目前只支援公司登記）" };
  if (gcis) {
    checks.status = gcis.status === ACTIVE_STATUS ? { ok: true, detail: "公司狀況：核准設立" } : { ok: false, detail: `公司狀況為「${gcis.status || "未知"}」，只接受核准設立` };
  }
  const isRep = !!gcis && normName(gcis.responsible) === normName(applicantName);
  checks.representative = isRep
    ? { ok: true, detail: `申請人證件姓名與代表人「${gcis!.responsible}」相同` }
    : { ok: false, detail: gcis ? `申請人不是登記的代表人（${gcis.responsible}），需上傳代表人授權書並由人工複核` : "無法比對代表人" };

  const hardFail = !checks.registry.ok || checks.status?.ok === false;
  const id = randomBytes(8).toString("hex");
  let letterFile: string | undefined;
  if (!hardFail && !isRep) {
    if (!letter || !letter.size) throw new HttpError(400, "你不是登記的代表人：請上傳代表人簽署的授權書（圖片或 PDF）");
    if (letter.size > 10_000_000) throw new HttpError(413, "授權書不能超過 10 MB");
    const ext = letter.type === "application/pdf" ? "pdf" : letter.type === "image/png" ? "png" : "jpg";
    if (!["application/pdf", "image/png", "image/jpeg"].includes(letter.type)) throw new HttpError(400, "授權書只接受 PDF、PNG、JPEG");
    const dir = entityDir(entity, id);
    await fs.mkdir(dir, { recursive: true });
    letterFile = `letter.${ext}`;
    await fs.writeFile(path.join(dir, letterFile), Buffer.from(await letter.arrayBuffer()));
    checks.letter = { ok: true, detail: "已上傳授權書，待人工複核" };
  }
  const status = hardFail ? "rejected" : isRep ? "approved" : "review";
  const application: NonNullable<EntityRecord["application"]> = {
    id,
    ubn,
    applicant: me,
    applicantName,
    at: Date.now(),
    path: isRep ? "representative" : "agent",
    status,
    gcis,
    checks,
    ...(letterFile ? { letter: letterFile } : {}),
  };
  await update((s) => {
    s.entities![keyOf(entity)].application = application;
  });
  if (status === "approved") await finalizeEntity(entity);
  return publicEntity((await read()).entities![keyOf(entity)]);
}

export function entityDir(entity: string, id: string) {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "entity", entity.toLowerCase(), id);
}

/** 核准後簽發法人證明（自動通過與人工核准共用） */
export async function finalizeEntity(entity: Address, reviewer?: string) {
  const rec = (await read()).entities?.[keyOf(entity)];
  const a = rec?.application;
  if (!rec || !a || a.status !== "approved" || !a.gcis || a.result?.txHash) return;
  // 核准時再確認一次：統編沒有被搶先綁到別的帳戶
  const bound = Object.values((await read()).entities ?? {}).find((r) => r.verified?.ubn === a.ubn && keyOf(r.entity) !== keyOf(entity));
  if (bound) {
    await update((s) => {
      const x = s.entities![keyOf(entity)].application!;
      x.status = "rejected";
      x.checks.unique = { ok: false, detail: "這個統一編號已經綁定其他法人帳戶" };
    });
    return;
  }
  try {
    const r = await attestIdentity(getAddress(entity), {
      subjectType: 1,
      level: 2,
      claimsRoot: claimsRootOf(a.gcis),
      expiry: Math.floor(Date.now() / 1000) + 365 * 86400,
      jurisdiction: "TW",
    });
    await update((s) => {
      const x = s.entities![keyOf(entity)];
      x.application!.result = { txHash: r.v2Tx };
      x.verified = { ubn: a.ubn, name: a.gcis!.name, responsible: a.gcis!.responsible, changeDate: a.gcis!.changeDate, approvedAt: Date.now(), txHash: r.v2Tx };
      x.displayName ??= a.gcis!.name;
      x.monitor = { lastCheck: Date.now(), status: "ok", detail: reviewer ? `人工核准（${reviewer}）` : "代表人本人申請，自動通過" };
    });
  } catch (e) {
    await update((s) => {
      s.entities![keyOf(entity)].application!.result = { error: (e as Error).message.slice(0, 300) };
    });
    throw e;
  }
}

/**
 * 每日監控：重新查詢商工登記。
 * - 公司狀況不再是「核准設立」→ 撤銷（原因碼 3）
 * - 代表人或最後核准變更日期改變 → 暫停（原因碼 4），需要重新驗證
 */
export async function monitorEntities(opts: { force?: boolean } = {}) {
  const s = await read();
  const out: { entity: string; action: "ok" | "suspend" | "revoke" | "error" | "skip"; detail?: string; tx?: string | null }[] = [];
  for (const r of Object.values(s.entities ?? {})) {
    if (!r.verified) continue;
    if (!opts.force && r.monitor && Date.now() - r.monitor.lastCheck < 20 * 3600 * 1000) {
      out.push({ entity: r.entity, action: "skip" });
      continue;
    }
    const st = await identityState(r.entity as Address).catch(() => null);
    if (!st || st.status === IdentityStatus.REVOKED || st.status === IdentityStatus.NONE) {
      out.push({ entity: r.entity, action: "skip", detail: "證明已撤銷或不存在" });
      continue;
    }
    let c: GcisCompany | null;
    try {
      c = await gcisLookup(r.verified.ubn);
    } catch (e) {
      await update((x) => {
        x.entities![keyOf(r.entity)].monitor = { lastCheck: r.monitor?.lastCheck ?? 0, status: "error", detail: (e as Error).message };
      });
      out.push({ entity: r.entity, action: "error", detail: (e as Error).message });
      continue;
    }
    let action: "ok" | "suspend" | "revoke" = "ok";
    let detail = "登記資料未變更";
    if (!c || c.status !== ACTIVE_STATUS) {
      action = "revoke";
      detail = c ? `公司狀況變更為「${c.status}」` : "商工登記查無資料";
    } else if (normName(c.responsible) !== normName(r.verified.responsible) || c.changeDate !== r.verified.changeDate) {
      action = st.status === IdentityStatus.SUSPENDED ? "ok" : "suspend";
      detail = normName(c.responsible) !== normName(r.verified.responsible) ? `代表人變更為「${c.responsible}」，需要重新驗證` : `登記事項已變更（${c.changeDate}），需要重新驗證`;
    }
    let tx: string | null = null;
    if (action === "revoke") tx = await changeIdentityStatus(r.entity as Address, "revoke", REASON_ENTITY_DISSOLVED);
    if (action === "suspend") tx = await changeIdentityStatus(r.entity as Address, "suspend", REASON_REPRESENTATIVE_CHANGED);
    await update((x) => {
      const e = x.entities![keyOf(r.entity)];
      e.monitor = { lastCheck: Date.now(), status: action === "revoke" ? "revoked" : action === "suspend" || st.status === IdentityStatus.SUSPENDED ? "suspended" : "ok", detail, ...(tx ? { tx } : {}) };
      // 統編綁定（verified）保留，避免別人趁暫停期間綁走；同一個法人帳戶可以用新的登記資料重新申請
    });
    out.push({ entity: r.entity, action, detail, tx });
  }
  return out;
}
