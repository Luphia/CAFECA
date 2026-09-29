import { MODEL_FILES, ort, session, warp, type Rgb } from "./runtime";

/**
 * 人臉偵測（YuNet）與人臉特徵（SFace），OpenCV Zoo，Apache-2.0，可商用。
 * SFace 同一人判定門檻：餘弦相似度 ≥ 0.363（OpenCV 建議值）。
 */
export const SFACE_SAME = 0.363;

export type Face = {
  box: [number, number, number, number]; // x, y, w, h（原圖座標）
  score: number;
  /** 5 點：畫面左眼、畫面右眼、鼻尖、畫面左嘴角、畫面右嘴角 */
  kps: [number, number][];
};

const SIZE = 640;

export async function detectFaces(img: Rgb, minScore = 0.6): Promise<Face[]> {
  const s = await session(MODEL_FILES.yunet);
  const scale = Math.min(SIZE / img.width, SIZE / img.height);
  const input = new Float32Array(3 * SIZE * SIZE);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  // letterbox 到 640×640（右、下補 0），BGR、0–255、NCHW
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const i = (sy * img.width + sx) * 3;
      const o = y * SIZE + x;
      input[o] = img.data[i + 2];
      input[SIZE * SIZE + o] = img.data[i + 1];
      input[2 * SIZE * SIZE + o] = img.data[i];
    }
  }
  const out = await s.run({ input: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  const faces: Face[] = [];
  for (const stride of [8, 16, 32]) {
    const cls = out[`cls_${stride}`].data as Float32Array;
    const obj = out[`obj_${stride}`].data as Float32Array;
    const bbox = out[`bbox_${stride}`].data as Float32Array;
    const kps = out[`kps_${stride}`].data as Float32Array;
    const cols = SIZE / stride;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < minScore) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = (c + bbox[i * 4]) * stride;
      const cy = (r + bbox[i * 4 + 1]) * stride;
      const bw = Math.exp(bbox[i * 4 + 2]) * stride;
      const bh = Math.exp(bbox[i * 4 + 3]) * stride;
      const pts: [number, number][] = [];
      for (let k = 0; k < 5; k++) pts.push([((c + kps[i * 10 + 2 * k]) * stride) / scale, ((r + kps[i * 10 + 2 * k + 1]) * stride) / scale]);
      faces.push({ box: [(cx - bw / 2) / scale, (cy - bh / 2) / scale, bw / scale, bh / scale], score, kps: pts });
    }
  }
  return nms(faces, 0.3);
}

function iou(a: Face["box"], b: Face["box"]) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

function nms(faces: Face[], th: number): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of sorted) if (!keep.some((k) => iou(k.box, f.box) > th)) keep.push(f);
  return keep;
}

export function largest(faces: Face[]): Face | null {
  return faces.reduce<Face | null>((m, f) => (!m || f.box[2] * f.box[3] > m.box[2] * m.box[3] ? f : m), null);
}

/** ArcFace／SFace 的 112×112 對齊樣板 */
const TEMPLATE: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** 最小平方相似轉換（樣板 → 原圖）：x = a·u − b·v + tx，y = b·u + a·v + ty */
function similarity(from: [number, number][], to: [number, number][]) {
  let su = 0, sv = 0, sx = 0, sy = 0, suu = 0, sux = 0, svy = 0, suy = 0, svx = 0;
  const n = from.length;
  for (let i = 0; i < n; i++) {
    const [u, v] = from[i];
    const [x, y] = to[i];
    su += u; sv += v; sx += x; sy += y;
    suu += u * u + v * v;
    sux += u * x; svy += v * y; suy += u * y; svx += v * x;
  }
  const mu = su / n, mv = sv / n, mx = sx / n, my = sy / n;
  const var_ = suu / n - (mu * mu + mv * mv);
  const a = ((sux + svy) / n - (mu * mx + mv * my)) / var_;
  const b = ((suy - svx) / n - (mu * my - mv * mx)) / var_;
  const tx = mx - (a * mu - b * mv);
  const ty = my - (b * mu + a * mv);
  return [a, -b, tx, b, a, ty] as [number, number, number, number, number, number];
}

export function alignFace(img: Rgb, face: Face): Rgb {
  return warp(img, 112, 112, similarity(TEMPLATE, face.kps));
}

/** 128 維特徵（L2 正規化） */
export async function embedFace(img: Rgb, face: Face): Promise<Float32Array> {
  const s = await session(MODEL_FILES.sface);
  const al = alignFace(img, face);
  const input = new Float32Array(3 * 112 * 112);
  for (let i = 0; i < 112 * 112; i++) {
    input[i] = al.data[i * 3];
    input[112 * 112 + i] = al.data[i * 3 + 1];
    input[2 * 112 * 112 + i] = al.data[i * 3 + 2];
  }
  const out = await s.run({ data: new ort.Tensor("float32", input, [1, 3, 112, 112]) });
  const v = Float32Array.from(out[s.outputNames[0]].data as Float32Array);
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
