import { spawn } from "child_process";
import type { Rgb } from "./runtime";

/** 影片解碼使用系統的 ffmpeg（可用 FFMPEG_PATH 指定） */
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

function run(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(/*turbopackIgnore: true*/ FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`無法執行 ffmpeg（${e.message}）；請安裝 ffmpeg 或設定 FFMPEG_PATH`)));
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg 失敗：${err.slice(0, 300)}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export async function ffmpegAvailable() {
  return run(["-version"]).then(() => true, () => false);
}

/** 依固定 fps 取出影格（寬 width，保持比例），回傳每格的時間（毫秒）與 RGB */
export async function videoFrames(file: string, fps = 10, width = 480): Promise<{ t: number; img: Rgb }[]> {
  // 先取得縮放後的高度：輸出一張影格的 PNG 標頭太麻煩，改用固定正方形補邊避免猜尺寸
  const size = width;
  const raw = await run([
    "-i", file,
    "-vf", `fps=${fps},scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  const frame = size * size * 3;
  const frames: { t: number; img: Rgb }[] = [];
  for (let i = 0; i + frame <= raw.length; i += frame) {
    frames.push({ t: Math.round(((i / frame) * 1000) / fps), img: { data: new Uint8Array(raw.buffer, raw.byteOffset + i, frame), width: size, height: size } });
  }
  return frames;
}

/** 16 kHz 單聲道 float32 音訊；沒有音軌時回傳空陣列 */
export async function audioPcm(file: string): Promise<Float32Array> {
  const raw = await run(["-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]).catch(() => Buffer.alloc(0));
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
}

export function rms(pcm: Float32Array, fromMs: number, toMs: number) {
  const a = Math.max(0, Math.floor((fromMs / 1000) * 16000));
  const b = Math.min(pcm.length, Math.floor((toMs / 1000) * 16000));
  let s = 0;
  for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}
