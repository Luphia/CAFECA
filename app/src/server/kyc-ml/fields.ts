import type { OcrLine } from "./ocr";

/**
 * 國民身分證版面解析（規格 §14.3）：以標籤列（姓名、出生年月日…）找同一列右側的值，
 * 統一編號以正規式＋檢查碼從全文擷取。浮水印造成的雜訊行不會落在標籤列上，因此不影響。
 */
export type IdFields = {
  name: string | null;
  birthday: string | null; // 西元 YYYY-MM-DD
  sex: "M" | "F" | null;
  issueDate: string | null;
  issueType: string | null; // 初發／補發／換發
  idNumber: string | null;
  docType: "national_id" | "resident_permit" | null;
  address: string | null;
  birthplace: string | null;
};

const LETTER: Record<string, number> = {
  A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21,
  N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33,
};

/** 國民身分證／新式居留證統一編號檢查碼 */
export function validTwId(id: string): boolean {
  if (!/^[A-Z][1289]\d{8}$/.test(id)) return false;
  const n = LETTER[id[0]];
  let sum = Math.floor(n / 10) + (n % 10) * 9;
  for (let i = 1; i < 9; i++) sum += Number(id[i]) * (9 - i);
  sum += Number(id[9]);
  return sum % 10 === 0;
}

const norm = (s: string) =>
  s
    .replace(/别/g, "別")
    .replace(/[证証]/g, "證")
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .replace(/[oO](?=\d)/g, "0");

function rocDate(s: string): string | null {
  const m = norm(s).match(/民國?(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const y = Number(m[1]) + 1911, mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 與標籤同一列、在標籤右側、高度相近且彼此相鄰的文字 */
function valueRight(lines: OcrLine[], label: RegExp): string | null {
  const l = lines.find((x) => label.test(norm(x.text)));
  if (!l) return null;
  const t = norm(l.text);
  const inline = t.slice(t.search(label)).replace(label, "");
  const [lx, ly, lw, lh] = l.box;
  const overlap = (x: OcrLine) => {
    const a = Math.max(ly, x.box[1]), b = Math.min(ly + lh, x.box[1] + x.box[3]);
    return Math.max(0, b - a) / Math.min(lh, x.box[3]);
  };
  const right = lines
    .filter((x) => x !== l && x.box[0] > lx + lw * 0.6 && overlap(x) > 0.5 && x.box[3] < lh * 2.2)
    .sort((a, b) => a.box[0] - b.box[0]);
  const parts = [inline];
  let edge = lx + lw;
  for (const x of right) {
    if (x.box[0] - edge > lh * 6) break;
    parts.push(norm(x.text));
    edge = x.box[0] + x.box[2];
  }
  const v = parts.join("");
  return v || null;
}

/** 浮水印（「僅供 CAFECA 身分驗證使用」）的片段：一行裡大多是這些字就視為雜訊 */
const WM_CHARS = new Set("僅催供CAFEcafe身分驗證使用用".split(""));
const isWatermark = (t: string) => {
  const s = norm(t);
  const hit = [...s].filter((c) => WM_CHARS.has(c)).length;
  return /CAFECA/i.test(s) || (s.length > 0 && hit / s.length >= 0.5);
};
const WATERMARK = { test: isWatermark };

export function parseFront(lines: OcrLine[]): Pick<IdFields, "name" | "birthday" | "sex" | "issueDate" | "issueType" | "idNumber" | "docType"> {
  const clean = lines
    .map((l) => ({ ...l, text: norm(l.text).replace(/^.*?(?=[A-Z][1289]\d{8})/, (m) => (isWatermark(m) ? "" : m)) }))
    .filter((l) => l.score >= 0.5 && (!isWatermark(l.text) || /[A-Z][1289]\d{8}/.test(l.text.toUpperCase())));
  const all = clean.map((l) => norm(l.text).toUpperCase()).join("\n");
  const ids = [...all.matchAll(/[A-Z][1289]\d{8}/g)].map((m) => m[0]).filter(validTwId);
  const idNumber = ids[0] ?? null;
  const nameRaw = valueRight(clean, /姓名/);
  const name = nameRaw ? nameRaw.replace(/[^一-鿿‧·．.]/g, "").replace(/[·．.]/g, "‧").slice(0, 20) || null : null;
  const birthday = rocDate(valueRight(clean, /出生年月日|出生日期/) ?? "") ?? null;
  const sexRaw = valueRight(clean, /性別/) ?? "";
  const sex = /男/.test(sexRaw) ? "M" : /女/.test(sexRaw) ? "F" : null;
  const issue = valueRight(clean, /發證日期/) ?? "";
  const issueType = issue.match(/(初發|補發|換發)/)?.[1] ?? null;
  const docType = idNumber ? (/[12]/.test(idNumber[1]) ? "national_id" : "resident_permit") : null;
  return { name, birthday, sex, issueDate: rocDate(issue), issueType, idNumber, docType };
}

export function parseBack(lines: OcrLine[]): Pick<IdFields, "address" | "birthplace"> {
  const clean = lines.filter((l) => l.score >= 0.5 && !WATERMARK.test(l.text));
  const address = valueRight(clean, /住址/)?.replace(/^[:：]/, "") || null;
  const birthplace = valueRight(clean, /出生地/)?.replace(/^[:：]/, "") || null;
  return { address, birthplace };
}

/** 欄位之間的合理性檢查 */
export function consistency(f: IdFields): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!f.idNumber) issues.push("找不到有效的統一編號（檢查碼不符或無法辨識）");
  if (!f.name) issues.push("無法辨識姓名");
  if (!f.birthday) issues.push("無法辨識出生年月日");
  if (f.idNumber && f.sex && f.docType === "national_id") {
    const s = f.idNumber[1] === "1" ? "M" : "F";
    if (s !== f.sex) issues.push("性別與統一編號第二碼不符");
  }
  const now = new Date().toISOString().slice(0, 10);
  if (f.birthday && (f.birthday > now || f.birthday < "1900-01-01")) issues.push("出生日期不合理");
  if (f.issueDate && (f.issueDate > now || (f.birthday && f.issueDate < f.birthday))) issues.push("發證日期不合理");
  return { ok: issues.length === 0, issues };
}
