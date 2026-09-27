import "server-only";
import { createHash, createHmac, randomBytes, randomInt } from "crypto";
import { env } from "./env";
import { HttpError } from "./session";
import { update } from "./store";

/** 模擬 KYC 單位的本人比對紀錄：身分證字號只保存 HMAC */
export function kycIdHash(idNumber: string) {
  return createHmac("sha256", env.kycRecordSecret()).update(idNumber.trim().toUpperCase()).digest("hex");
}

/** 引導式臉部影像的動作指示（前端依序顯示，錄影期間使用者照做） */
export const LIVENESS_STEPS = ["請正視鏡頭", "慢慢把頭轉向左邊", "慢慢把頭轉向右邊", "眨眼兩次"];

/** 產生一次性的活體挑戰：最後一步要念出隨機數字，防止重播預錄影片 */
export async function newLivenessChallenge() {
  const id = randomBytes(12).toString("hex");
  const code = String(randomInt(0, 10000)).padStart(4, "0");
  await update((s) => {
    const now = Date.now();
    for (const [k, v] of Object.entries(s.kycChallenges)) if (v.exp < now) delete s.kycChallenges[k];
    s.kycChallenges[id] = { code, exp: now + 10 * 60_000, used: false };
  });
  return { id, code, steps: [...LIVENESS_STEPS, `念出數字 ${code.split("").join(" ")}`] };
}

export type Evidence = { idImage: string; faceVideo: string; seconds: number; challenge: string };

const MIN_SECONDS = 5;

function sha(buf: ArrayBuffer) {
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

/**
 * 檢查 KYC 證據（測試網）：
 * - 證件影像：圖片、大小合理
 * - 臉部影像：影片、長度足夠、綁定未使用過的活體挑戰
 * 正式版：持照 KYC 單位進行證件真偽（OCR＋防偽特徵）、活體偵測（動作＋念數字）與「證件照 ↔ 臉部」比對。
 */
export async function checkEvidence(form: FormData): Promise<Evidence> {
  const idImage = form.get("idImage");
  const faceVideo = form.get("faceVideo");
  const challengeId = String(form.get("challengeId") ?? "");
  const seconds = Number(form.get("videoSeconds") ?? 0);
  if (!(idImage instanceof File) || !idImage.type.startsWith("image/") || idImage.size < 500) {
    throw new HttpError(400, "請拍攝或上傳身分證件正面");
  }
  if (idImage.size > 10_000_000) throw new HttpError(400, "證件影像過大（上限 10 MB）");
  if (!(faceVideo instanceof File) || !faceVideo.type.startsWith("video/") || faceVideo.size < 2_000) {
    throw new HttpError(400, "請依指示錄製臉部影像");
  }
  if (faceVideo.size > 30_000_000) throw new HttpError(400, "臉部影像過大（上限 30 MB）");
  if (!(seconds >= MIN_SECONDS)) throw new HttpError(400, `臉部影像至少需要 ${MIN_SECONDS} 秒，請依指示完成所有動作`);

  const ok = await update((s) => {
    const c = s.kycChallenges[challengeId];
    if (!c || c.used || c.exp < Date.now()) return false;
    c.used = true;
    return true;
  });
  if (!ok) throw new HttpError(400, "活體驗證挑戰已過期或已使用，請重新錄製");

  return {
    idImage: sha(await idImage.arrayBuffer()),
    faceVideo: sha(await faceVideo.arrayBuffer()),
    seconds,
    challenge: challengeId,
  };
}
