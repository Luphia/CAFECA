// 把 MediaPipe 的 wasm 與臉部模型放到 public/mediapipe（自架，KYC 期間不向第三方 CDN 取檔）
// 由 npm install（postinstall）自動執行；離線時略過，之後可手動執行 npm run fetch-models
import { cpSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const out = path.join(root, "public", "mediapipe");
const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

mkdirSync(out, { recursive: true });
if (existsSync(wasmSrc)) {
  cpSync(wasmSrc, path.join(out, "wasm"), { recursive: true });
  console.log("MediaPipe wasm → public/mediapipe/wasm");
}
const model = path.join(out, "face_landmarker.task");
if (!existsSync(model)) {
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(model, Buffer.from(await res.arrayBuffer()));
    console.log("face_landmarker.task → public/mediapipe");
  } catch (e) {
    console.warn(`無法下載臉部模型（${e.message}），請稍後執行 npm run fetch-models`);
  }
}

// ───────────────────────── KYC 後台模型（伺服器端，規格 §14.6） ─────────────────────────
// 放在 models/kyc（不進 git、不對外提供）。來源皆為 Hugging Face 上 Apache-2.0 授權的權重：
// - YuNet 人臉偵測、SFace 人臉特徵（OpenCV Zoo）
// - MediaPipe 臉部 478 點（與裝置端同一份權重，轉成 ONNX）
// - PP-OCRv5 文字偵測與辨識（繁簡中文）
// - Whisper base（語音辨識，核對念出的數字）
const kyc = path.join(root, "models", "kyc");
const HF = "https://huggingface.co";
const FILES = [
  ["face_detection_yunet_2023mar.onnx", "opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx"],
  ["face_recognition_sface_2021dec.onnx", "opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx"],
  ["face_landmarks_478.onnx", "senty-au/face_landmarks_detector-ONNX/resolve/main/onnx/model.onnx"],
  ["ppocrv5_det.onnx", "breezedeus/cnstd-ppocr-ch_PP-OCRv5_det/resolve/main/ch_PP-OCRv5_det_infer.onnx"],
  ["ppocrv5_rec.onnx", "breezedeus/cnocr-ppocr-ch_PP-OCRv5/resolve/main/ch_PP-OCRv5_rec_infer.onnx"],
  ["ppocrv5_rec.yml", "PaddlePaddle/PP-OCRv5_mobile_rec/resolve/main/inference.yml"],
  ...["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"].map(
    (f) => [`whisper/onnx-community/whisper-base/${f}`, `onnx-community/whisper-base/resolve/main/${f}`],
  ),
];
if (process.env.KYC_SKIP_MODELS === "1") {
  console.log("KYC_SKIP_MODELS=1：略過 KYC 後台模型");
} else {
  let failed = 0;
  for (const [name, src] of FILES) {
    const dest = path.join(kyc, name);
    if (existsSync(dest)) continue;
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      const res = await fetch(`${HF}/${src}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`${name} → models/kyc`);
    } catch (e) {
      failed++;
      console.warn(`無法下載 ${name}（${e.message}）`);
    }
  }
  // PP-OCRv5 字典：從 inference.yml 的 character_dict 取出
  const yml = path.join(kyc, "ppocrv5_rec.yml");
  const dict = path.join(kyc, "ppocrv5_dict.txt");
  if (existsSync(yml) && !existsSync(dict)) {
    const lines = (await import("fs")).readFileSync(yml, "utf8").split("\n");
    const start = lines.findIndex((l) => l.trim() === "character_dict:");
    const chars = [];
    for (let i = start + 1; i < lines.length && /^\s*- /.test(lines[i]); i++) chars.push(lines[i].replace(/^\s*- /, "").replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1"));
    writeFileSync(dict, chars.join("\n"));
    console.log(`PP-OCRv5 字典 ${chars.length} 字 → models/kyc/ppocrv5_dict.txt`);
  }
  if (failed) console.warn("部分 KYC 模型下載失敗，後台驗證會把案件全部轉人工複核；請稍後執行 npm run fetch-models");
}
