import { readFileSync } from "fs";
import { MODEL_FILES, modelPath, ort, sample, session, type Rgb } from "./runtime";

/**
 * PP-OCRv5（繁簡中文，Apache-2.0）文字偵測＋辨識，onnxruntime-node 本機推論。
 * 前處理與 PaddleOCR 相同：BGR、偵測用 ImageNet mean/std、辨識高 48 並正規化到 [-1, 1]。
 */
export type OcrLine = { text: string; score: number; box: [number, number, number, number] };

let dict: string[] | null = null;
function charset() {
  // 索引 0 為 CTC blank，最後一個為空白字元
  dict ??= ["", ...readFileSync(/*turbopackIgnore: true*/ modelPath(MODEL_FILES.ocrDict), "utf8").split("\n"), " "];
  return dict;
}

async function detect(img: Rgb): Promise<[number, number, number, number][]> {
  const s = await session(MODEL_FILES.ocrDet);
  const limit = 960;
  const r = Math.min(1, limit / Math.max(img.width, img.height));
  const W = Math.max(32, Math.round((img.width * r) / 32) * 32);
  const H = Math.max(32, Math.round((img.height * r) / 32) * 32);
  const sx = img.width / W, sy = img.height / H;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const v = sample(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, 2 - c) / 255; // BGR
        input[c * W * H + y * W + x] = (v - mean[c]) / std[c];
      }
    }
  }
  const out = await s.run({ x: new ort.Tensor("float32", input, [1, 3, H, W]) });
  const prob = out[s.outputNames[0]].data as Float32Array;
  // 二值化＋連通區塊 → 外接矩形（證件已對齊方框，不需要旋轉框）
  const seen = new Uint8Array(W * H);
  const boxes: [number, number, number, number][] = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || prob[i] < 0.3) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, sum = 0, n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p - x) / W;
      sum += prob[p];
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || seen[q] || prob[q] < 0.3) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (n < 12 || sum / n < 0.6) continue;
    // unclip（ratio 1.5）：往外擴 area·ratio/perimeter
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const dist = (w * h * 1.5) / (2 * (w + h));
    boxes.push([
      Math.max(0, (x0 - dist) * sx),
      Math.max(0, (y0 - dist) * sy),
      Math.min(img.width, (x1 + 1 + dist) * sx),
      Math.min(img.height, (y1 + 1 + dist) * sy),
    ]);
  }
  return boxes;
}

async function recognize(img: Rgb, box: [number, number, number, number]): Promise<{ text: string; score: number }> {
  const s = await session(MODEL_FILES.ocrRec);
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  const H = 48;
  const W = Math.min(1600, Math.max(16, Math.ceil((H * bw) / bh / 8) * 8));
  const input = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x0 + ((x + 0.5) / W) * bw - 0.5;
      const py = y0 + ((y + 0.5) / H) * bh - 0.5;
      for (let c = 0; c < 3; c++) input[c * H * W + y * W + x] = (sample(img, px, py, 2 - c) / 255 - 0.5) / 0.5;
    }
  }
  const out = await s.run({ x: new ort.Tensor("float32", input, [1, 3, H, W]) });
  const t = out[s.outputNames[0]];
  const [, T, C] = t.dims as number[];
  const data = t.data as Float32Array;
  const chars = charset();
  let text = "", last = -1, conf = 0, cnt = 0;
  for (let i = 0; i < T; i++) {
    let best = 0, bv = -Infinity;
    for (let c = 0; c < C; c++) if (data[i * C + c] > bv) { bv = data[i * C + c]; best = c; }
    if (best !== 0 && best !== last) {
      text += chars[best] ?? "";
      conf += bv;
      cnt++;
    }
    last = best;
  }
  return { text: text.trim(), score: cnt ? conf / cnt : 0 };
}

/** 整張影像的文字行（由上而下、由左而右） */
export async function readText(img: Rgb): Promise<OcrLine[]> {
  const boxes = await detect(img);
  const lines: OcrLine[] = [];
  for (const b of boxes) {
    const r = await recognize(img, b);
    if (r.text) lines.push({ ...r, box: [b[0], b[1], b[2] - b[0], b[3] - b[1]] });
  }
  return lines.sort((a, b) => (Math.abs(a.box[1] - b.box[1]) < Math.min(a.box[3], b.box[3]) * 0.5 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]));
}
