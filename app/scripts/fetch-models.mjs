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
