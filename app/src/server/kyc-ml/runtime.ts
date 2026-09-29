import { existsSync } from "fs";
import path from "path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

/**
 * KYC 後台模型執行環境（規格 §14.6）：全部在本機以 onnxruntime-node 推論，影像不送往任何第三方。
 * 模型由 npm run fetch-models 下載到 models/kyc（可用 KYC_MODEL_DIR 覆寫）。
 */
export const MODEL_DIR = process.env.KYC_MODEL_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "models", "kyc");
/** 模型檔的絕對路徑（執行期才決定，不讓建置工具追蹤整個專案） */
export const modelPath = (f: string) => path.join(/*turbopackIgnore: true*/ MODEL_DIR, f);

export const MODEL_FILES = {
  yunet: "face_detection_yunet_2023mar.onnx",
  sface: "face_recognition_sface_2021dec.onnx",
  landmarks: "face_landmarks_478.onnx",
  ocrDet: "ppocrv5_det.onnx",
  ocrRec: "ppocrv5_rec.onnx",
  ocrDict: "ppocrv5_dict.txt",
  whisper: "whisper/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx",
} as const;

export function missingModels(): string[] {
  return Object.values(MODEL_FILES).filter((f) => !existsSync(/*turbopackIgnore: true*/ modelPath(f)));
}

const sessions = new Map<string, Promise<ort.InferenceSession>>();
export function session(file: string): Promise<ort.InferenceSession> {
  let s = sessions.get(file);
  if (!s) {
    s = ort.InferenceSession.create(modelPath(file), { logSeverityLevel: 3, intraOpNumThreads: Number(process.env.KYC_THREADS ?? 2) });
    sessions.set(file, s);
  }
  return s;
}

export { ort };

/** RGB 影像（每像素 3 bytes） */
export type Rgb = { data: Uint8Array; width: number; height: number };

export async function decodeImage(input: Buffer | string, maxSide = 1600): Promise<Rgb> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/** 雙線性取樣 */
export function sample(img: Rgb, x: number, y: number, c: number): number {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const p = (xx: number, yy: number) => img.data[(yy * img.width + xx) * 3 + c];
  return p(x0, y0) * (1 - fx) * (1 - fy) + p(x1, y0) * fx * (1 - fy) + p(x0, y1) * (1 - fx) * fy + p(x1, y1) * fx * fy;
}

/** 仿射取樣：dst(u,v) = src(a*u + b*v + c, d*u + e*v + f) */
export function warp(img: Rgb, w: number, h: number, m: [number, number, number, number, number, number]): Rgb {
  const out = new Uint8Array(w * h * 3);
  const [a, b, c, d, e, f] = m;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const x = a * u + b * v + c;
      const y = d * u + e * v + f;
      const inside = x >= 0 && y >= 0 && x <= img.width - 1 && y <= img.height - 1;
      for (let k = 0; k < 3; k++) out[(v * w + u) * 3 + k] = inside ? sample(img, x, y, k) : 0;
    }
  }
  return { data: out, width: w, height: h };
}
