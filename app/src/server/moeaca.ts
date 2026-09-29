import "server-only";
import { readFileSync } from "fs";
import { X509Certificate, webcrypto } from "crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { GRCA2, GRCA3, MOEACA2, MOEACA3 } from "./moeaca-anchors";

/**
 * 工商憑證（MOEACA）簽章驗證（規格 §16.4、P1.5）
 *
 * 工商憑證 IC 卡的簽章憑證（以台積電公開的憑證核對過，2026-09）：
 *   Subject      C=TW, O=<公司名稱>, serialNumber=<統一編號>
 *   Issuer       C=TW, O=行政院, OU=工商憑證管理中心（第三代由 GRCA G3 簽發；第二代由 GRCA 簽發）
 *   Key Usage    Digital Signature（加密用的是另一張憑證）
 *   Policy       2.16.886.101.0.3.3
 *   Subject Directory Attributes
 *     2.16.886.1.100.2.1   主體類別（2.16.886.1.100.3.2.2.1.1 …）
 *     2.16.886.1.100.2.2   卡別：primary（正卡）／secondary（附卡）
 *     2.16.886.1.100.2.101 統一編號
 *   CRL          分區 CRL（CRL Distribution Points 第一個 URI），另有 complete.crl
 *
 * 驗證：CMS SignedData（HiPKI 跨平台網頁元件 MakeSignature, signatureType=PKCS7）→ 簽章者憑證 →
 *       MOEACA 中繼 → GRCA 根（內建、以指紋固定）→ 效期 → 金鑰用途 → 政策 → CRL（驗證 CRL 簽章與 nextUpdate）。
 */

const OID_SDA = "2.5.29.9";
const OID_SUBJECT_CLASS = "2.16.886.1.100.2.1";
const OID_CARD_RANK = "2.16.886.1.100.2.2";
const OID_UBN = "2.16.886.1.100.2.101";
const OID_POLICY_MOEACA = "2.16.886.101.0.3.3";
const OID_KEY_USAGE = "2.5.29.15";
const OID_CERT_POLICIES = "2.5.29.32";
const OID_CRL_DP = "2.5.29.31";
const OID_SERIAL_NUMBER = "2.5.4.5";
const OID_ORG = "2.5.4.10";

const engine = new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto });
pkijs.setEngine("node", engine);

type Anchors = { roots: X509Certificate[]; cas: X509Certificate[]; test: boolean };

function pemList(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

let anchors: Anchors | null = null;
/**
 * 信任錨：內建 GRCA／GRCA G3 根與 MOEACA 第二、三代中繼。
 * MOEACA_TEST_ANCHORS=<PEM 檔>（第一張為根，其餘為中繼）只供自動化測試使用測試 PKI，正式環境不得設定。
 */
function trust(): Anchors {
  if (anchors) return anchors;
  const file = process.env.MOEACA_TEST_ANCHORS;
  if (file) {
    const certs = pemList(readFileSync(/*turbopackIgnore: true*/ file, "utf8")).map((p) => new X509Certificate(p));
    anchors = { roots: certs.slice(0, 1), cas: certs.slice(1), test: true };
  } else {
    anchors = { roots: [new X509Certificate(GRCA2), new X509Certificate(GRCA3)], cas: [new X509Certificate(MOEACA2), new X509Certificate(MOEACA3)], test: false };
  }
  return anchors;
}

export type MoeacaCert = {
  ubn: string;
  companyName: string;
  cardRank: "primary" | "secondary" | "unknown";
  subjectClass: string | null;
  serial: string;
  notBefore: string;
  notAfter: string;
  issuer: string;
  fingerprint256: string;
  crl: { url: string; checkedAt: number; nextUpdate: string } | null;
  testPki: boolean;
};

export class MoeacaError extends Error {}

const toAB = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");

function parsePki(der: Uint8Array): pkijs.Certificate {
  const asn = asn1js.fromBER(toAB(der));
  if (asn.offset === -1) throw new MoeacaError("憑證格式錯誤");
  return new pkijs.Certificate({ schema: asn.result });
}

function ext(c: pkijs.Certificate, oid: string) {
  return c.extensions?.find((e) => e.extnID === oid);
}

function rdn(c: pkijs.Certificate, oid: string): string | null {
  const t = c.subject.typesAndValues.find((x) => x.type === oid);
  return t ? String(t.value.valueBlock.value) : null;
}

/** Subject Directory Attributes → { oid: [值...] } */
function subjectDirectoryAttributes(c: pkijs.Certificate): Record<string, string[]> {
  const e = ext(c, OID_SDA);
  if (!e) return {};
  const asn = asn1js.fromBER(e.extnValue.valueBlock.valueHexView.slice().buffer);
  const out: Record<string, string[]> = {};
  const seq = asn.result as asn1js.Sequence;
  for (const attr of seq.valueBlock.value as asn1js.Sequence[]) {
    const [oid, set] = attr.valueBlock.value as [asn1js.ObjectIdentifier, asn1js.Set];
    const k = oid.valueBlock.toString();
    out[k] = (set.valueBlock.value as asn1js.AsnType[]).map((v) => {
      const anyV = v as unknown as { valueBlock: { value?: unknown; toString?: () => string } };
      if (v instanceof asn1js.ObjectIdentifier) return v.valueBlock.toString();
      return String(anyV.valueBlock.value ?? "");
    });
  }
  return out;
}

function keyUsageDigitalSignature(c: pkijs.Certificate): boolean {
  const e = ext(c, OID_KEY_USAGE);
  if (!e) return false;
  const bits = (e.parsedValue as asn1js.BitString | undefined)?.valueBlock.valueHexView;
  return !!bits && bits.length > 0 && (bits[0] & 0x80) !== 0;
}

function policies(c: pkijs.Certificate): string[] {
  const e = ext(c, OID_CERT_POLICIES);
  const p = e?.parsedValue as pkijs.CertificatePolicies | undefined;
  return p?.certificatePolicies.map((x) => x.policyIdentifier) ?? [];
}

function crlUrls(c: pkijs.Certificate): string[] {
  const e = ext(c, OID_CRL_DP);
  const d = e?.parsedValue as pkijs.CRLDistributionPoints | undefined;
  const urls: string[] = [];
  for (const dp of d?.distributionPoints ?? []) {
    const names = dp.distributionPoint as pkijs.GeneralName[] | undefined;
    for (const n of Array.isArray(names) ? names : []) if (n.type === 6) urls.push(String(n.value));
  }
  return urls;
}

// ───────────────────────── 憑證鏈 ─────────────────────────

function chainOf(leaf: X509Certificate): { issuer: X509Certificate; root: X509Certificate } {
  const t = trust();
  for (const ca of t.cas) {
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) continue;
    for (const root of t.roots) {
      if (ca.checkIssued(root) && ca.verify(root.publicKey) && root.verify(root.publicKey)) return { issuer: ca, root };
    }
  }
  throw new MoeacaError("憑證不是由工商憑證管理中心（MOEACA）簽發，或憑證鏈無法驗證");
}

// ───────────────────────── CRL ─────────────────────────

const crlCache = new Map<string, { crl: pkijs.CertificateRevocationList; nextUpdate: number; fetchedAt: number }>();

async function loadCrl(url: string, issuer: X509Certificate) {
  const c = crlCache.get(url);
  if (c && c.nextUpdate > Date.now()) return c;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new MoeacaError(`無法下載憑證廢止清冊（HTTP ${r.status}）`);
  const der = new Uint8Array(await r.arrayBuffer());
  const asn = asn1js.fromBER(toAB(der));
  if (asn.offset === -1) throw new MoeacaError("憑證廢止清冊格式錯誤");
  const crl = new pkijs.CertificateRevocationList({ schema: asn.result });
  const issuerPki = parsePki(new Uint8Array(issuer.raw));
  if (!(await crl.verify({ issuerCertificate: issuerPki }))) throw new MoeacaError("憑證廢止清冊的簽章無效");
  const nextUpdate = crl.nextUpdate?.value.getTime() ?? 0;
  if (nextUpdate && nextUpdate < Date.now()) throw new MoeacaError("憑證廢止清冊已過期，無法確認憑證狀態");
  const entry = { crl, nextUpdate: nextUpdate || Date.now() + 3600_000, fetchedAt: Date.now() };
  crlCache.set(url, entry);
  return entry;
}

async function checkRevocation(leaf: pkijs.Certificate, issuer: X509Certificate) {
  const urls = crlUrls(leaf);
  if (!urls.length) throw new MoeacaError("憑證沒有 CRL 發布點，無法確認是否已廢止");
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const { crl, nextUpdate, fetchedAt } = await loadCrl(url, issuer);
      const serial = hex(leaf.serialNumber.valueBlock.valueHexView).replace(/^0+/, "");
      const revoked = (crl.revokedCertificates ?? []).some((rc) => hex(rc.userCertificate.valueBlock.valueHexView).replace(/^0+/, "") === serial);
      if (revoked) throw new MoeacaError("這張工商憑證已被廢止或停用");
      return { url, checkedAt: fetchedAt, nextUpdate: new Date(nextUpdate).toISOString() };
    } catch (e) {
      if (e instanceof MoeacaError && /廢止或停用/.test(e.message)) throw e;
      lastErr = e as Error;
    }
  }
  throw new MoeacaError(`無法確認憑證狀態：${lastErr?.message ?? "CRL 無法取得"}`);
}

// ───────────────────────── 對外 ─────────────────────────

/** 檢查一張工商憑證（鏈、效期、用途、政策、CRL），回傳統編與卡別 */
export async function inspectMoeacaCert(der: Uint8Array, now = new Date()): Promise<MoeacaCert> {
  const x = new X509Certificate(Buffer.from(der));
  const c = parsePki(der);
  const { issuer } = chainOf(x);
  if (now < new Date(x.validFrom) || now > new Date(x.validTo)) throw new MoeacaError("工商憑證不在有效期間內");
  if (!keyUsageDigitalSignature(c)) throw new MoeacaError("這張憑證不是簽章用憑證（請使用工商憑證的簽章憑證）");
  if (!trust().test && !policies(c).includes(OID_POLICY_MOEACA)) throw new MoeacaError("憑證政策不是工商憑證");
  const sda = subjectDirectoryAttributes(c);
  const ubnSda = sda[OID_UBN]?.[0] ?? null;
  const ubnSubject = rdn(c, OID_SERIAL_NUMBER);
  const ubn = ubnSda ?? ubnSubject;
  if (!ubn || !/^\d{8}$/.test(ubn)) throw new MoeacaError("憑證中找不到統一編號");
  if (ubnSda && ubnSubject && ubnSda !== ubnSubject) throw new MoeacaError("憑證中的統一編號不一致");
  const rank = sda[OID_CARD_RANK]?.[0];
  const crl = await checkRevocation(c, issuer);
  return {
    ubn,
    companyName: rdn(c, OID_ORG) ?? "",
    cardRank: rank === "primary" ? "primary" : rank === "secondary" ? "secondary" : "unknown",
    subjectClass: sda[OID_SUBJECT_CLASS]?.[0] ?? null,
    serial: x.serialNumber,
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    issuer: x.issuer.replace(/\n/g, ", "),
    fingerprint256: x.fingerprint256,
    crl,
    testPki: trust().test,
  };
}

/**
 * 驗證 HiPKI 回傳的 PKCS#7（CMS SignedData）簽章：
 * 簽署內容必須與 expected 完全相同（附加內容，或以 expected 作為分離內容驗證），簽章者必須是有效的工商憑證。
 */
export async function verifyMoeacaSignature(p: { signature: string; expected: Uint8Array; certb64?: string; now?: Date }): Promise<MoeacaCert> {
  let der: Uint8Array;
  try {
    der = new Uint8Array(Buffer.from(p.signature.replace(/\s+/g, ""), "base64"));
  } catch {
    throw new MoeacaError("簽章格式錯誤");
  }
  const asn = asn1js.fromBER(toAB(der));
  if (asn.offset === -1) throw new MoeacaError("簽章格式錯誤（不是 PKCS#7）");
  let sd: pkijs.SignedData;
  try {
    const ci = new pkijs.ContentInfo({ schema: asn.result });
    if (ci.contentType !== pkijs.ContentInfo.SIGNED_DATA) throw new Error();
    sd = new pkijs.SignedData({ schema: ci.content });
  } catch {
    throw new MoeacaError("簽章格式錯誤（不是 CMS SignedData）");
  }
  if (sd.signerInfos.length !== 1) throw new MoeacaError("簽章必須只有一位簽署者");
  if (p.certb64) {
    const extra = parsePki(new Uint8Array(Buffer.from(p.certb64, "base64")));
    sd.certificates = [...(sd.certificates ?? []), extra];
  }
  const attached = sd.encapContentInfo.eContent?.valueBlock.valueHexView;
  if (attached && !Buffer.from(attached).equals(Buffer.from(p.expected))) throw new MoeacaError("簽署的內容與這次的綁定請求不符");
  let signer: pkijs.Certificate | undefined;
  try {
    const r = await sd.verify({ signer: 0, data: attached ? undefined : toAB(p.expected), extendedMode: true, checkChain: false });
    if (!r.signatureVerified) throw new Error();
    signer = r.signerCertificate ?? undefined;
  } catch {
    throw new MoeacaError("工商憑證簽章驗證失敗");
  }
  if (!signer) throw new MoeacaError("簽章中沒有簽署者憑證");
  return inspectMoeacaCert(new Uint8Array(signer.toSchema().toBER(false)), p.now);
}
