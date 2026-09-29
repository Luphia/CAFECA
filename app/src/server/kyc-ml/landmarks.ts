import { MODEL_FILES, ort, session, warp, type Rgb } from "./runtime";
import type { Face } from "./face";

/**
 * MediaPipe 臉部 478 點（與裝置端 face_landmarker.task 同一份權重，轉成 ONNX）。
 * 頭部轉向的算法與裝置端 src/lib/kyc-vision.ts headPose 相同，避免判定不一致。
 */
export type Pt = { x: number; y: number };

async function runCrop(img: Rgb, cx: number, cy: number, size: number, roll: number): Promise<{ pts: Pt[]; presence: number }> {
  const s = await session(MODEL_FILES.landmarks);
  const cos = Math.cos(roll), sin = Math.sin(roll);
  const k = size / 256;
  // crop(u,v) → 原圖：以 (cx,cy) 為中心、旋轉 roll
  const m: [number, number, number, number, number, number] = [
    k * cos, -k * sin, cx - k * 128 * cos + k * 128 * sin,
    k * sin, k * cos, cy - k * 128 * sin - k * 128 * cos,
  ];
  const crop = warp(img, 256, 256, m);
  const input = new Float32Array(256 * 256 * 3);
  for (let i = 0; i < input.length; i++) input[i] = crop.data[i] / 255;
  const out = await s.run({ input_12: new ort.Tensor("float32", input, [1, 256, 256, 3]) });
  const raw = out.Identity.data as Float32Array;
  const pts: Pt[] = [];
  for (let i = 0; i < 478; i++) {
    const u = raw[i * 3], v = raw[i * 3 + 1];
    pts.push({ x: m[0] * u + m[1] * v + m[2], y: m[3] * u + m[4] * v + m[5] });
  }
  const logit = (out.Identity_1.data as Float32Array)[0];
  return { pts, presence: 1 / (1 + Math.exp(-logit)) };
}

/** 由 YuNet 的框開始，再以第一輪的點修正一次（MediaPipe 追蹤的做法） */
export async function faceLandmarks(img: Rgb, face: Face) {
  const [x, y, w, h] = face.box;
  const [le, re] = face.kps;
  let roll = Math.atan2(re[1] - le[1], re[0] - le[0]);
  let r = await runCrop(img, x + w / 2, y + h / 2, Math.max(w, h) * 1.6, roll);
  const xs = r.pts.map((p) => p.x), ys = r.pts.map((p) => p.y);
  const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
  roll = Math.atan2(r.pts[263].y - r.pts[33].y, r.pts[263].x - r.pts[33].x);
  r = await runCrop(img, bx + bw / 2, by + bh / 2, Math.max(bw, bh) * 1.35, roll);
  return r;
}

const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** 與裝置端相同的頭部轉向定義 */
export function headPose(lm: Pt[]) {
  const nose = lm[1], cheekA = lm[234], cheekB = lm[454], top = lm[10], chin = lm[152];
  const yaw = (nose.x - cheekA.x) / (cheekB.x - cheekA.x || 1e-6) - 0.5;
  const pitch = (nose.y - top.y) / (chin.y - top.y || 1e-6);
  return { yaw, pitch };
}

/** 眼睛張開程度（上下眼瞼距離／眼寬，兩眼平均）；閉眼時明顯下降 */
export function eyeOpenness(lm: Pt[]) {
  const a = d(lm[159], lm[145]) / (d(lm[33], lm[133]) || 1e-6);
  const b = d(lm[386], lm[374]) / (d(lm[362], lm[263]) || 1e-6);
  return (a + b) / 2;
}

/** 嘴巴張開程度（內唇上下距離／臉高） */
export function mouthOpenness(lm: Pt[]) {
  return d(lm[13], lm[14]) / (d(lm[10], lm[152]) || 1e-6);
}
