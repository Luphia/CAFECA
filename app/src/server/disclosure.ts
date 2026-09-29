import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { CompactEncrypt, CompactSign, importJWK, type JWK } from "jose";
import { p256 } from "@noble/curves/p256";
import { getAddress, hashMessage, type Address, type Hex } from "viem";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { verifySignInResponse, type SignInResponse } from "@/lib/signin";
import { writeAudit } from "./audit";
import { publicClient } from "./chain";
import { membersOf } from "./entity";
import { queryEvents } from "./indexer";
import { pairwiseId } from "./kyc-credential";
import { caseDir } from "./kyc-pipeline";
import { HttpError } from "./session";
import { read, update, type Disclosure, type RelyingParty, type Store } from "./store";

/**
 * 依賴方資料調閱（規格 §16.6 P2、issue #2 §4）
 *
 * 依賴方（例如交易所）平常只拿得到使用者同意提供的 claims；遇到洗錢防制調查、司法機關調閱等情況，
 * 需要 CAFECA 保存的實名資料時，走這個流程：
 *
 *   1. CAFECA 登記依賴方（名稱、統編、網域、聯絡人、P-256 加密公鑰），發給 API 金鑰
 *   2. 依賴方以 API 送出調閱申請：帳戶、欄位、法律依據、案號；洗錢防制與當事人同意類須證明對方是自己的客戶
 *      （該帳戶登入過依賴方網域的 SignIn 回應，或依賴方持有的 pairwise_id）
 *   3. 當事人同意類 → 使用者在錢包以 Passkey 同意或拒絕
 *   4. CAFECA 法遵雙人覆核：第一位核准欄位，第二位（不同人）放行
 *   5. 放行後產生資料包：CAFECA 以 ES256 簽章（JWS），再以依賴方公鑰加密（JWE ECDH-ES＋A256GCM）；7 天內可下載
 *   6. 使用者在「安全」頁看得到被誰、依什麼依據調閱了哪些資料；司法機關要求暫緩通知時，到期後才顯示
 *   7. 每個步驟都寫入 hash-chained 稽核紀錄
 *
 * 服務條款、資料處理約定、各類法律依據的審核標準與保存期限，須由法遵確認後才能正式上線。
 */

export const FIELDS = ["legal_name", "birthday", "sex", "doc_type", "nationality", "issue_date", "kyc_history", "doc_images", "entity"] as const;
export type DisclosureField = (typeof FIELDS)[number];
export const FIELD_LABEL: Record<DisclosureField, string> = {
  legal_name: "證件姓名",
  birthday: "出生日期",
  sex: "性別",
  doc_type: "證件類型",
  nationality: "國籍",
  issue_date: "證件發證日期",
  kyc_history: "實名驗證歷程（簽發、暫停、撤銷）",
  doc_images: "證件影像（浮水印版）",
  entity: "法人資料（統編、登記名稱、成員、代簽紀錄）",
};

export const BASES = ["court", "prosecutor", "police", "aml", "consent"] as const;
export type LegalBasisType = (typeof BASES)[number];
export const BASIS_LABEL: Record<LegalBasisType, string> = {
  court: "法院裁定或命令",
  prosecutor: "檢察機關調取",
  police: "司法警察機關調查",
  aml: "洗錢防制（客戶審查、可疑交易調查）",
  consent: "當事人同意",
};
/** 需要證明對方是自己客戶的依據 */
const NEEDS_RELATIONSHIP: LegalBasisType[] = ["aml", "consent"];
/** 可以要求暫緩通知當事人的依據 */
const MAY_DEFER: LegalBasisType[] = ["court", "prosecutor", "police"];
export const RELEASE_TTL_MS = 7 * 24 * 3600 * 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ───────────────────────── 依賴方與 API 金鑰 ─────────────────────────

export function originOf(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function createRelyingParty(by: string, p: { name: string; ubn?: string; domains: string[]; contact: string; encJwk: JWK }) {
  const name = p.name.trim().slice(0, 80);
  if (!name) throw new HttpError(400, "請填寫依賴方名稱");
  const domains = [...new Set(p.domains.map(originOf))].filter((d): d is string => !!d);
  if (!domains.length) throw new HttpError(400, "至少需要一個 https 網域（與 Sign in with CAFECA 的 domain 相同）");
  if (p.encJwk?.kty !== "EC" || p.encJwk.crv !== "P-256" || !p.encJwk.x || !p.encJwk.y || p.encJwk.d) throw new HttpError(400, "加密公鑰必須是 P-256 公鑰 JWK（不可包含私鑰 d）");
  await importJWK({ kty: "EC", crv: "P-256", x: p.encJwk.x, y: p.encJwk.y }, "ECDH-ES").catch(() => {
    throw new HttpError(400, "加密公鑰無效");
  });
  const id = "rp" + randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const apiKey = `cafeca_${id}_${secret}`;
  const rp: RelyingParty = {
    id,
    name,
    ubn: p.ubn?.trim() || undefined,
    domains,
    contact: p.contact.trim().slice(0, 200),
    keyHash: sha(apiKey),
    encJwk: { kty: "EC", crv: "P-256", x: p.encJwk.x, y: p.encJwk.y },
    createdAt: Date.now(),
    createdBy: by,
    active: true,
  };
  await update((s) => {
    s.relyingParties ??= {};
    s.relyingParties[id] = rp;
  });
  await writeAudit({ who: by, action: "rp.create", rp: id, name, domains });
  return { rp: publicRp(rp), apiKey };
}

export function publicRp(r: RelyingParty) {
  return { id: r.id, name: r.name, ubn: r.ubn ?? null, domains: r.domains, contact: r.contact, active: r.active, createdAt: r.createdAt, createdBy: r.createdBy };
}

export async function setRpActive(by: string, id: string, active: boolean) {
  await update((s) => {
    const r = s.relyingParties?.[id];
    if (!r) throw new HttpError(404, "找不到依賴方");
    r.active = active;
  });
  await writeAudit({ who: by, action: active ? "rp.enable" : "rp.disable", rp: id });
}

/** Authorization: Bearer cafeca_<id>_<secret> */
export async function requireRp(req: Request): Promise<RelyingParty> {
  const m = /^Bearer\s+(cafeca_(rp[0-9a-f]{12})_[A-Za-z0-9_-]{20,})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "缺少依賴方 API 金鑰");
  const r = (await read()).relyingParties?.[m[2]];
  const ok = !!r && timingSafeEqual(Buffer.from(sha(m[1]), "hex"), Buffer.from(r.keyHash, "hex"));
  if (!r || !ok) throw new HttpError(401, "API 金鑰無效");
  if (!r.active) throw new HttpError(403, "這個依賴方已停用");
  return r;
}

// ───────────────────────── 申請 ─────────────────────────

async function proveRelationship(rp: RelyingParty, account: Address, p: { signIn?: SignInResponse; pairwiseId?: string }): Promise<Disclosure["relationship"]> {
  if (p.signIn) {
    const m = p.signIn.message;
    if (!m || !rp.domains.includes(m.domain)) throw new HttpError(400, "SignIn 回應的網域不是這個依賴方登記的網域");
    if (p.signIn.account?.toLowerCase() !== account.toLowerCase()) throw new HttpError(400, "SignIn 回應的帳戶與調閱帳戶不同");
    try {
      await verifySignInResponse(p.signIn, {
        domain: m.domain,
        nonce: m.nonce,
        chainId: CHAIN_ID,
        now: m.issuedAt + 1,
        readContract: (q) => publicClient.readContract(q as Parameters<typeof publicClient.readContract>[0]),
      });
    } catch (e) {
      throw new HttpError(400, `SignIn 回應驗證失敗：${(e as Error).message}（使用者恢復身分後舊簽章可能失效，請改用 pairwise_id）`);
    }
    return { type: "signin", detail: `${m.domain} 於 ${new Date(m.issuedAt * 1000).toISOString()} 的登入簽章` };
  }
  if (p.pairwiseId) {
    const rec = Object.entries((await read()).kyc).find(([k]) => k.toLowerCase() === account.toLowerCase())?.[1];
    // 與 KYC Credential 相同的來源：帳戶的 idHash，或最近一次核准案件的證號 HMAC
    const approved = (rec?.cases ?? []).filter((x) => x.status === "approved").sort((a, b) => (b.processedAt ?? b.createdAt) - (a.processedAt ?? a.createdAt))[0];
    const idHash = rec?.idHash ?? approved?.fields?.idNumberHash;
    const hit = idHash && rp.domains.find((d) => pairwiseId(idHash, d)?.toLowerCase() === p.pairwiseId!.toLowerCase());
    if (!hit) throw new HttpError(400, "pairwise_id 與這個帳戶及依賴方網域不符");
    return { type: "pairwise", detail: `pairwise_id（${hit}）` };
  }
  return { type: "none", detail: "未提供（司法機關依職權調閱）" };
}

export async function createDisclosure(
  rp: RelyingParty,
  b: { account?: string; fields?: string[]; legalBasis?: { type?: string; ref?: string; text?: string }; caseRef?: string; reason?: string; deferNoticeUntil?: string; signIn?: SignInResponse; pairwiseId?: string },
) {
  if (!b.account || !/^0x[0-9a-fA-F]{40}$/.test(b.account)) throw new HttpError(400, "account 格式錯誤");
  const account = getAddress(b.account);
  const fields = [...new Set(b.fields ?? [])].filter((f): f is DisclosureField => (FIELDS as readonly string[]).includes(f));
  if (!fields.length) throw new HttpError(400, `fields 至少需要一項：${FIELDS.join("、")}`);
  const type = b.legalBasis?.type as LegalBasisType;
  if (!BASES.includes(type)) throw new HttpError(400, `legalBasis.type 必須是 ${BASES.join("、")}`);
  const ref = (b.legalBasis?.ref ?? "").trim().slice(0, 200);
  const text = (b.legalBasis?.text ?? "").trim().slice(0, 2000);
  if (type !== "consent" && (!ref || !text)) throw new HttpError(400, "請提供法律依據的文號（legalBasis.ref）與內容說明（legalBasis.text）");
  const reason = (b.reason ?? "").trim().slice(0, 2000);
  if (!reason) throw new HttpError(400, "請說明調閱原因（reason）");
  let noticeDeferredUntil: number | undefined;
  if (b.deferNoticeUntil) {
    if (!MAY_DEFER.includes(type)) throw new HttpError(400, "只有司法機關調閱可以要求暫緩通知當事人");
    const t = Date.parse(b.deferNoticeUntil);
    if (!Number.isFinite(t) || t < Date.now() || t > Date.now() + 366 * 86400_000) throw new HttpError(400, "deferNoticeUntil 必須是一年內的日期");
    noticeDeferredUntil = t;
  }
  const s = await read();
  const known = Object.keys(s.kyc).some((k) => k.toLowerCase() === account.toLowerCase()) || !!s.entities?.[account.toLowerCase()];
  if (!known) throw new HttpError(404, "CAFECA 沒有這個帳戶的實名資料");
  if (type === "consent" && s.entities?.[account.toLowerCase()]) throw new HttpError(400, "法人帳戶目前不支援「當事人同意」類申請，請附法律依據或洗錢防制申請");
  if (NEEDS_RELATIONSHIP.includes(type) && !b.signIn && !b.pairwiseId) throw new HttpError(400, "洗錢防制與當事人同意類申請，須附上該帳戶登入你網站的 SignIn 回應（signIn）或 pairwise_id");
  const relationship = await proveRelationship(rp, account, b);
  const id = "dr" + randomBytes(8).toString("hex");
  const d: Disclosure = {
    id,
    rp: rp.id,
    account,
    fields,
    legalBasis: { type, ref, text },
    caseRef: (b.caseRef ?? "").trim().slice(0, 100) || undefined,
    reason,
    relationship,
    noticeDeferredUntil,
    status: type === "consent" ? "consent" : "review",
    consent: type === "consent" ? { status: "pending" } : undefined,
    approvals: [],
    createdAt: Date.now(),
  };
  await update((st) => {
    st.disclosures ??= {};
    st.disclosures[id] = d;
  });
  await writeAudit({ who: `rp:${rp.id}`, action: "disclosure.request", disclosure: id, account, fields, basis: type, ref, relationship: relationship.type });
  return rpView(d);
}

export function rpView(d: Disclosure) {
  return {
    id: d.id,
    status: d.status,
    account: d.account,
    fields: d.fields,
    approvedFields: d.approvals[1]?.fields ?? d.approvals[0]?.fields ?? null,
    legalBasis: { type: d.legalBasis.type, ref: d.legalBasis.ref },
    consent: d.consent?.status ?? null,
    rejection: d.rejection ?? null,
    release: d.release ? { at: d.release.at, expiresAt: d.release.expiresAt } : null,
    createdAt: d.createdAt,
  };
}

// ───────────────────────── 當事人同意 ─────────────────────────

export function consentMessage(d: Disclosure, rpName: string, decision: "approve" | "deny") {
  return [
    "CAFECA 資料調閱",
    `申請單位：${rpName}`,
    `案件：${d.id}`,
    `欄位：${d.fields.map((f) => FIELD_LABEL[f]).join("、")}`,
    `原因：${d.reason}`,
    `我的決定：${decision === "approve" ? "同意提供" : "拒絕提供"}`,
  ].join("\n");
}

const ERC1271 = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] }] as const;

export async function decideConsent(me: Address, id: string, decision: "approve" | "deny", signature: Hex) {
  const s = await read();
  const d = s.disclosures?.[id];
  if (!d || d.account.toLowerCase() !== me.toLowerCase()) throw new HttpError(404, "找不到這個調閱請求");
  if (d.status !== "consent" || d.consent?.status !== "pending") throw new HttpError(409, "這個請求不需要或已經回覆同意");
  const rp = s.relyingParties![d.rp];
  const msg = consentMessage(d, rp.name, decision);
  const magic = await publicClient.readContract({ address: me, abi: ERC1271, functionName: "isValidSignature", args: [hashMessage(msg), signature] }).catch(() => "0x");
  if (magic !== "0x1626ba7e") throw new HttpError(400, "Passkey 簽章驗證失敗");
  await update((st) => {
    const x = st.disclosures![id];
    x.consent = { status: decision === "approve" ? "granted" : "denied", at: Date.now(), signature };
    x.status = decision === "approve" ? "review" : "rejected";
    if (decision === "deny") x.rejection = { by: "當事人", at: Date.now(), reason: "當事人拒絕提供" };
  });
  await writeAudit({ who: `user:${me}`, action: decision === "approve" ? "disclosure.consent" : "disclosure.consent.deny", disclosure: id });
}

// ───────────────────────── 覆核與放行（雙人） ─────────────────────────

export async function approveDisclosure(who: string, id: string, fields: string[], note?: string) {
  const d = (await read()).disclosures?.[id];
  if (!d) throw new HttpError(404, "找不到調閱申請");
  const f = fields.filter((x): x is DisclosureField => d.fields.includes(x as DisclosureField));
  if (!f.length) throw new HttpError(400, "至少核准一項申請的欄位");
  if (d.status === "review") {
    await update((st) => {
      const x = st.disclosures![id];
      x.approvals = [{ who, at: Date.now(), fields: f, note }];
      x.status = "approved1";
    });
    await writeAudit({ who, action: "disclosure.approve", disclosure: id, fields: f, note });
    return { status: "approved1" as const };
  }
  if (d.status === "approved1") {
    if (d.approvals[0].who === who) throw new HttpError(409, "放行必須由另一位複核人員執行（雙人覆核）");
    const first = d.approvals[0].fields;
    const final = f.filter((x) => first.includes(x));
    if (!final.length) throw new HttpError(400, "放行的欄位必須在第一位核准的範圍內");
    await update((st) => {
      const x = st.disclosures![id];
      x.approvals = [x.approvals[0], { who, at: Date.now(), fields: final, note }];
      x.status = "released";
      x.release = { at: Date.now(), by: who, expiresAt: Date.now() + RELEASE_TTL_MS, fetched: [] };
    });
    await writeAudit({ who, action: "disclosure.release", disclosure: id, fields: final, firstApprover: d.approvals[0].who, note });
    return { status: "released" as const };
  }
  throw new HttpError(409, `目前狀態（${d.status}）不能核准`);
}

export async function rejectDisclosure(who: string, id: string, reason: string) {
  const d = (await read()).disclosures?.[id];
  if (!d) throw new HttpError(404, "找不到調閱申請");
  if (["released", "rejected"].includes(d.status)) throw new HttpError(409, "已結案");
  if (!reason.trim()) throw new HttpError(400, "請填寫退件原因");
  await update((st) => {
    const x = st.disclosures![id];
    x.status = "rejected";
    x.rejection = { by: who, at: Date.now(), reason: reason.trim().slice(0, 500) };
  });
  await writeAudit({ who, action: "disclosure.reject", disclosure: id, reason });
}

// ───────────────────────── 資料包 ─────────────────────────

/** 放行資料包的簽章金鑰（DISCLOSURE_SIGNING_KEY，P-256 私鑰 hex；deploy 自動產生） */
function signingJwk(): JWK | null {
  const hex = process.env.DISCLOSURE_SIGNING_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const d = Buffer.from(hex, "hex");
  const pub = p256.getPublicKey(d, false);
  return { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: Buffer.from(pub.slice(1, 33)).toString("base64url"), y: Buffer.from(pub.slice(33)).toString("base64url") };
}

/** 公開驗章金鑰（/.well-known/cafeca-configuration 的 disclosure.jwks） */
export function disclosureJwks() {
  const j = signingJwk();
  if (!j) return null;
  return { keys: [{ kty: j.kty, crv: j.crv, x: j.x, y: j.y, kid: kidOf(j), alg: "ES256", use: "sig" }] };
}

function kidOf(j: JWK) {
  return "cafeca-disclosure-" + sha(`${j.x}.${j.y}`).slice(0, 16);
}

async function collect(s: Store, d: Disclosure, fields: DisclosureField[]) {
  const out: Record<string, unknown> = {};
  const rec = Object.entries(s.kyc).find(([k]) => k.toLowerCase() === d.account.toLowerCase())?.[1];
  const c = (rec?.cases ?? []).filter((x) => x.status === "approved").sort((a, b) => (b.processedAt ?? b.createdAt) - (a.processedAt ?? a.createdAt))[0];
  const f = c?.fields ?? null;
  if (fields.includes("legal_name")) out.legal_name = f?.name ?? null;
  if (fields.includes("birthday")) out.birthday = f?.birthday ?? null;
  if (fields.includes("sex")) out.sex = f?.sex ?? null;
  if (fields.includes("doc_type")) out.doc_type = f?.docType ?? null;
  if (fields.includes("nationality")) out.nationality = f?.nationality ?? null;
  if (fields.includes("issue_date")) out.issue_date = f?.issueDate ?? null;
  if (fields.includes("kyc_history")) {
    const ev = DEPLOYMENT.identityRegistry
      ? await queryEvents({ names: ["Attested", "Suspended", "Revoked"], contract: DEPLOYMENT.identityRegistry, where: { account: d.account }, limit: 100 })
      : [];
    out.kyc_history = {
      cases: (rec?.cases ?? []).map((x) => ({ id: x.id, purpose: x.purpose, status: x.status, createdAt: new Date(x.createdAt).toISOString(), decidedBy: x.decidedBy ?? null, reviewedAt: x.review ? new Date(x.review.at).toISOString() : null })),
      onchain: ev.map((e) => ({ event: e.e, block: e.b, tx: e.tx, at: new Date(e.t).toISOString(), ...e.a })),
    };
  }
  if (fields.includes("doc_images") && c) {
    const imgs: { kind: string; mime: string; sha256: string; data: string }[] = [];
    for (const kind of ["front", "back"] as const) {
      const buf = await fs.readFile(path.join(caseDir(d.account, c.id), c.files[kind])).catch(() => null);
      if (buf) imgs.push({ kind, mime: "image/jpeg", sha256: createHash("sha256").update(buf).digest("hex"), data: buf.toString("base64") });
    }
    out.doc_images = imgs;
  }
  if (fields.includes("entity")) {
    const e = s.entities?.[d.account.toLowerCase()];
    if (e) {
      const members = await membersOf(d.account as Address).catch(() => []);
      const auths = DEPLOYMENT.memberValidator ? await queryEvents({ names: ["MemberAuthorized"], contract: DEPLOYMENT.memberValidator, where: { entity: d.account }, limit: 500 }) : [];
      out.entity = {
        ubn: e.verified?.ubn ?? null,
        name: e.verified?.name ?? null,
        verification: e.application ? { path: e.application.path, at: new Date(e.application.at).toISOString(), applicant: e.application.applicant } : null,
        members: members.map((m) => ({ member: m.member, role: ["NONE", "OPERATOR", "ADMIN"][m.role] })),
        authorizations: auths.map((a) => ({ member: a.a.member, userOpHash: a.a.userOpHash, tx: a.tx, at: new Date(a.t).toISOString() })),
      };
    } else out.entity = null;
  }
  return out;
}

/** 依賴方下載資料包：JWE(ECDH-ES, A256GCM) 包著 CAFECA 的 JWS(ES256) */
export async function fetchPackage(rp: RelyingParty, id: string) {
  const s = await read();
  const d = s.disclosures?.[id];
  if (!d || d.rp !== rp.id) throw new HttpError(404, "找不到調閱申請");
  if (d.status !== "released" || !d.release) return { ...rpView(d), package: null };
  if (Date.now() > d.release.expiresAt) throw new HttpError(410, "資料包已過期（放行後 7 天內可下載），請重新申請");
  const jwk = signingJwk();
  if (!jwk) throw new HttpError(503, "尚未設定 DISCLOSURE_SIGNING_KEY");
  const fields = d.approvals[1].fields;
  const payload = {
    iss: "CAFECA",
    typ: "cafeca-disclosure+json",
    id: d.id,
    rp: { id: rp.id, name: rp.name },
    account: d.account,
    chainId: CHAIN_ID,
    legalBasis: d.legalBasis,
    caseRef: d.caseRef ?? null,
    fields,
    data: await collect(s, d, fields),
    releasedAt: new Date(d.release.at).toISOString(),
    issuedAt: new Date().toISOString(),
  };
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", kid: kidOf(jwk), typ: "cafeca-disclosure+jws" })
    .sign(await importJWK(jwk, "ES256"));
  const jwe = await new CompactEncrypt(new TextEncoder().encode(jws))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", kid: rp.id, cty: "JWT" })
    .encrypt(await importJWK(rp.encJwk as JWK, "ECDH-ES"));
  await update((st) => {
    st.disclosures![id].release!.fetched.push(Date.now());
  });
  await writeAudit({ who: `rp:${rp.id}`, action: "disclosure.fetch", disclosure: id, fields });
  return { ...rpView(d), package: jwe };
}

// ───────────────────────── 當事人檢視 ─────────────────────────

export async function myDisclosures(me: Address) {
  const s = await read();
  const now = Date.now();
  return Object.values(s.disclosures ?? {})
    .filter((d) => d.account.toLowerCase() === me.toLowerCase())
    .filter((d) => d.status === "consent" || !d.noticeDeferredUntil || d.noticeDeferredUntil <= now)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((d) => {
      const rp = s.relyingParties?.[d.rp];
      return {
        id: d.id,
        rp: rp ? { name: rp.name, ubn: rp.ubn ?? null, domains: rp.domains } : null,
        status: d.status,
        fields: (d.approvals[1]?.fields ?? d.fields).map((f) => ({ key: f, label: FIELD_LABEL[f] })),
        legalBasis: { type: d.legalBasis.type, label: BASIS_LABEL[d.legalBasis.type], ref: d.legalBasis.ref },
        reason: d.reason,
        createdAt: d.createdAt,
        releasedAt: d.release?.at ?? null,
        consent: d.consent?.status ?? null,
        consentMessage: d.status === "consent" && rp ? { approve: consentMessage(d, rp.name, "approve"), deny: consentMessage(d, rp.name, "deny") } : null,
      };
    });
}

// ───────────────────────── 複核後台 ─────────────────────────

export async function adminDisclosures(status: string) {
  const s = await read();
  return Object.values(s.disclosures ?? {})
    .filter((d) => status === "all" || d.status === status || (status === "open" && ["consent", "review", "approved1"].includes(d.status)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((d) => ({ ...d, rpName: s.relyingParties?.[d.rp]?.name ?? d.rp, handle: s.profiles[d.account]?.handle ?? null, consent: d.consent ? { status: d.consent.status, at: d.consent.at } : undefined }));
}

/** 複核人員檢視單一申請與將要提供的資料（證件影像只列雜湊，不在這裡顯示）；寫入稽核紀錄 */
export async function adminDisclosureDetail(who: string, id: string) {
  const s = await read();
  const d = s.disclosures?.[id];
  if (!d) throw new HttpError(404, "找不到調閱申請");
  const rp = s.relyingParties?.[d.rp];
  const data = await collect(s, d, d.approvals[d.approvals.length - 1]?.fields ?? d.fields);
  if (Array.isArray(data.doc_images)) data.doc_images = (data.doc_images as { kind: string; sha256: string; data: string }[]).map((i) => ({ kind: i.kind, sha256: i.sha256, bytes: Math.floor((i.data.length * 3) / 4) }));
  await writeAudit({ who, action: "disclosure.view", disclosure: id, account: d.account });
  return { disclosure: { ...d, consent: d.consent ? { status: d.consent.status, at: d.consent.at } : undefined }, rp: rp ? publicRp(rp) : null, handle: s.profiles[d.account]?.handle ?? null, preview: data };
}

export async function listRelyingParties() {
  return Object.values((await read()).relyingParties ?? {})
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicRp);
}

export async function rpDisclosures(rp: RelyingParty) {
  return Object.values((await read()).disclosures ?? {})
    .filter((d) => d.rp === rp.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200)
    .map(rpView);
}
