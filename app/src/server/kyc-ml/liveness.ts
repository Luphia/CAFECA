import { detectFaces, largest, type Face } from "./face";
import { eyeOpenness, faceLandmarks, headPose, mouthOpenness } from "./landmarks";
import { audioPcm, rms, videoFrames } from "./media";
import type { Rgb } from "./runtime";
import { digitsOf, transcribe } from "./speech";

/**
 * 伺服器端活體重檢（規格 §14.3）：不採信裝置回報的「完成」，對上傳影片逐格重新計算
 * 頭部轉向（與裝置端同一套特徵點與公式）、眼睛與嘴巴開合，確認 6 個動作依挑戰順序、
 * 在裝置回報的時間窗內真的出現；並以語音辨識核對念出的數字。
 */
export type ActionLog = { action: string; startedAt: number; completedAt: number; peak: number };

export type FrameMetric = { t: number; faces: number; yaw?: number; pitch?: number; eye?: number; mouth?: number };

export type ActionCheck = { action: string; ok: boolean; value: number; need: number; detail: string };

export type LivenessReport = {
  frames: number;
  faceRatio: number; // 有偵測到臉的影格比例
  multiFaceRatio: number; // 出現兩張以上臉的影格比例
  actions: ActionCheck[];
  speech: { text: string; digits: string; expected: string; match: "exact" | "partial" | "none" } | null;
  ok: boolean;
  best: { img: Rgb; face: Face } | null; // 最正面的影格，用於和證件照比對
};

// 裝置端門檻的約 70%（影格取樣較疏、壓縮後特徵點會抖）
const YAW = 0.12;
const PITCH = 0.05;
const BLINK_RATIO = 0.65;
const MOUTH_DELTA = 0.025;

export async function measureFrames(file: string, fps = 8): Promise<{ metrics: FrameMetric[]; best: LivenessReport["best"] }> {
  const frames = await videoFrames(file, fps, 480);
  const metrics: FrameMetric[] = [];
  let best: LivenessReport["best"] = null;
  let bestYaw = Infinity;
  for (const { t, img } of frames) {
    const faces = await detectFaces(img, 0.7);
    const f = largest(faces);
    if (!f) {
      metrics.push({ t, faces: 0 });
      continue;
    }
    const lm = await faceLandmarks(img, f);
    if (lm.presence < 0.5) {
      metrics.push({ t, faces: 0 });
      continue;
    }
    const { yaw, pitch } = headPose(lm.pts);
    metrics.push({ t, faces: faces.length, yaw, pitch, eye: eyeOpenness(lm.pts), mouth: mouthOpenness(lm.pts) });
    if (Math.abs(yaw) < bestYaw) {
      bestYaw = Math.abs(yaw);
      best = { img: { data: Uint8Array.from(img.data), width: img.width, height: img.height }, face: f };
    }
  }
  return { metrics, best };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** 依裝置回報的時間窗逐一核對動作 */
export function evaluate(metrics: FrameMetric[], log: ActionLog[], expected: string[]): ActionCheck[] {
  const withFace = metrics.filter((m) => m.yaw !== undefined);
  const firstStart = log[0]?.startedAt ?? 0;
  const baseFrames = withFace.filter((m) => m.t <= Math.max(400, firstStart + 300));
  const base = baseFrames.length ? baseFrames : withFace.slice(0, 3);
  const by = median(base.map((m) => m.yaw!));
  const bp = median(base.map((m) => m.pitch!));
  const eyeBase = median(withFace.map((m) => m.eye!));
  return expected.map((action, i) => {
    const a = log[i];
    if (!a || a.action !== action) return { action, ok: false, value: 0, need: 1, detail: "動作順序與挑戰不符" };
    const win = withFace.filter((m) => m.t >= a.startedAt - 250 && m.t <= a.completedAt + 400);
    if (!win.length) return { action, ok: false, value: 0, need: 1, detail: "這段時間的影格裡找不到臉" };
    let value = 0, need = 1;
    switch (action) {
      case "left": value = Math.max(...win.map((m) => m.yaw! - by)); need = YAW; break;
      case "right": value = Math.max(...win.map((m) => by - m.yaw!)); need = YAW; break;
      case "up": value = Math.max(...win.map((m) => bp - m.pitch!)); need = PITCH; break;
      case "down": value = Math.max(...win.map((m) => m.pitch! - bp)); need = PITCH; break;
      case "blink": {
        const minEye = Math.min(...win.map((m) => m.eye!));
        value = eyeBase ? 1 - minEye / eyeBase : 0;
        need = 1 - BLINK_RATIO;
        break;
      }
      case "speak": {
        const ms = win.map((m) => m.mouth!);
        value = Math.max(...ms) - Math.min(...ms);
        need = MOUTH_DELTA;
        break;
      }
    }
    const ok = value >= need;
    return { action, ok, value: Number(value.toFixed(3)), need, detail: ok ? "影片中確認有此動作" : "影片中動作幅度不足" };
  });
}

/** LCS 長度：辨識結果裡依序包含多少個挑戰數字 */
function lcs(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

export async function checkSpeech(file: string, log: ActionLog[], code: string): Promise<LivenessReport["speech"]> {
  const a = log.find((x) => x.action === "speak");
  if (!a) return null;
  const pcm = await audioPcm(file);
  if (!pcm.length) return { text: "", digits: "", expected: code, match: "none" };
  const from = Math.max(0, a.startedAt - 500), to = a.completedAt + 1500;
  const seg = pcm.slice(Math.floor((from / 1000) * 16000), Math.floor((to / 1000) * 16000));
  if (rms(seg, 0, (seg.length / 16000) * 1000) < 0.003) return { text: "", digits: "", expected: code, match: "none" };
  let text = await transcribe(seg, "chinese");
  let digits = digitsOf(text);
  if (lcs(code, digits) < code.length) {
    // 有人會用英文念：不指定語言再試一次
    const t2 = await transcribe(seg, null);
    if (lcs(code, digitsOf(t2)) > lcs(code, digits)) {
      text = t2;
      digits = digitsOf(t2);
    }
  }
  const n = lcs(code, digits);
  return { text: text.trim(), digits, expected: code, match: n === code.length ? "exact" : n >= code.length - 1 ? "partial" : "none" };
}

export async function checkLiveness(file: string, log: ActionLog[], expected: string[], code: string): Promise<LivenessReport> {
  const { metrics, best } = await measureFrames(file);
  const n = metrics.length || 1;
  const faceRatio = metrics.filter((m) => m.faces > 0).length / n;
  const multiFaceRatio = metrics.filter((m) => m.faces > 1).length / n;
  const actions = evaluate(metrics, log, expected);
  const speech = await checkSpeech(file, log, code).catch(() => null);
  const ok = faceRatio >= 0.85 && multiFaceRatio < 0.1 && actions.every((a) => a.ok) && speech?.match === "exact";
  return { frames: metrics.length, faceRatio, multiFaceRatio, actions, speech, ok, best };
}
