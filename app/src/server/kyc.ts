import "server-only";
import { createHash, createHmac, randomBytes, randomInt } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { env } from "./env";
import { HttpError } from "./session";
import { update, type KycCase } from "./store";

/** KYC 紀錄的本人識別：身分證字號只保存 HMAC（由後台 OCR 擷取後計算） */
export function kycIdHash(idNumber: string) {
  return createHmac("sha256", env.kycRecordSecret()).update(idNumber.trim().toUpperCase()).digest("hex");
}

export const LIVENESS_ACTIONS = ["up", "down", "left", "right", "blink", "speak"] as const;
export type LivenessAction = (typeof LIVENESS_ACTIONS)[number];

/** 一次性活體挑戰：6 個動作隨機排序（上下左右轉頭、眨眼、念 4 位數字），10 分鐘內有效 */
export async function newLivenessChallenge() {
  const id = randomBytes(12).toString("hex");
  const code = String(randomInt(0, 10000)).padStart(4, "0");
  const actions = [...LIVENESS_ACTIONS];
  for (let i = actions.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [actions[i], actions[j]] = [actions[j], actions[i]];
  }
  const exp = Date.now() + 10 * 60_000;
  await update((s) => {
    const now = Date.now();
    for (const [k, v] of Object.entries(s.kycChallenges)) if (v.exp < now) delete s.kycChallenges[k];
    s.kycChallenges[id] = { code, actions, exp, used: false };
  });
  return { id, actions, code, exp };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function fileOf(form: FormData, key: string, kind: "image" | "video", min: number, max: number) {
  const f = form.get(key);
  if (!(f instanceof File) || !f.type.startsWith(kind + "/")) throw new HttpError(400, `缺少${key === "face" ? "臉部影像" : key === "front" ? "證件正面" : "證件反面"}`);
  if (f.size < min) throw new HttpError(400, "影像內容不足，請重新拍攝");
  if (f.size > max) throw new HttpError(400, "影像過大");
  return Buffer.from(await f.arrayBuffer());
}

/**
 * 收下一份 KYC 證據並建立案件：
 * - 證件正反面：裝置端已疊浮水印的 JPEG（伺服器不會、也無從取得原圖）
 * - 臉部影像＋動作序列：必須與這次挑戰的 6 個動作順序一致、時間合理
 * 檔案存到 data/kyc/<帳戶>/<案件>/，供團隊自建的後台驗證流程處理。
 */
export async function intakeEvidence(account: string, form: FormData, purpose: KycCase["purpose"]): Promise<KycCase> {
  const front = await fileOf(form, "front", "image", 5_000, 8_000_000);
  const back = await fileOf(form, "back", "image", 5_000, 8_000_000);
  const face = await fileOf(form, "face", "video", 2_000, 40_000_000);
  const challengeId = String(form.get("challengeId") ?? "");
  let log: KycCase["actions"];
  let docFeatures: unknown;
  try {
    log = JSON.parse(String(form.get("actions") ?? "[]"));
    docFeatures = JSON.parse(String(form.get("docFeatures") ?? "{}"));
  } catch {
    throw new HttpError(400, "動作序列格式錯誤");
  }

  const ch = await update((s) => {
    const c = s.kycChallenges[challengeId];
    if (!c || c.used || c.exp < Date.now()) return null;
    c.used = true;
    return c;
  });
  if (!ch) throw new HttpError(400, "活體挑戰已過期或已使用，請重新錄製");

  const checks: KycCase["checks"] = {};
  const orderOk = Array.isArray(log) && log.length === ch.actions.length && log.every((a, i) => a.action === ch.actions[i]);
  let timeOk = orderOk;
  let prev = -1;
  for (const a of orderOk ? log : []) {
    const d = a.completedAt - a.startedAt;
    if (!(a.startedAt >= prev && d >= 150 && d <= 20_000 && a.peak >= 0.95)) timeOk = false;
    prev = a.completedAt;
  }
  checks.challengeOrder = { ok: orderOk, detail: orderOk ? "動作順序與挑戰一致" : "動作順序與挑戰不符" };
  checks.actionTiming = { ok: timeOk, detail: timeOk ? "每個動作的時間合理" : "動作時間異常" };
  if (!orderOk || !timeOk) throw new HttpError(400, "活體動作未依指示完成，請重新錄製");

  const id = randomBytes(8).toString("hex");
  const dir = path.join(process.cwd(), "data", "kyc", account.toLowerCase(), id);
  await fs.mkdir(dir, { recursive: true });
  const faceExt = (form.get("face") as File).type.includes("mp4") ? "mp4" : "webm";
  const files = { front: "front.jpg", back: "back.jpg", face: `face.${faceExt}` };
  await Promise.all([
    fs.writeFile(path.join(dir, files.front), front),
    fs.writeFile(path.join(dir, files.back), back),
    fs.writeFile(path.join(dir, files.face), face),
  ]);
  const c: KycCase = {
    id,
    purpose,
    createdAt: Date.now(),
    challenge: challengeId,
    files,
    hashes: { front: sha(front), back: sha(back), face: sha(face) },
    actions: log,
    docFeatures,
    status: "pending",
    checks,
  };
  await fs.writeFile(path.join(dir, "case.json"), JSON.stringify({ ...c, code: ch.code, challengeActions: ch.actions }, null, 2));
  return c;
}
