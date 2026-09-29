import { modelPath } from "./runtime";

/**
 * 語音辨識（Whisper base，transformers.js，本機推論）：核對使用者念出的挑戰數字。
 * 只送入「念數字」那段時間的音訊。
 */
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;

async function load(): Promise<Asr> {
  const t = await import("@huggingface/transformers");
  t.env.localModelPath = modelPath("whisper");
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  const p = await t.pipeline("automatic-speech-recognition", "onnx-community/whisper-base", {
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
  } as never);
  return p as unknown as Asr;
}

export async function transcribe(pcm: Float32Array, language: string | null = "chinese"): Promise<string> {
  asr ??= load();
  const f = await asr;
  const r = await f(pcm, { language: language ?? undefined, task: "transcribe", chunk_length_s: 30 });
  return (Array.isArray(r) ? r[0] : r).text ?? "";
}

const DIGIT: Record<string, string> = {
  零: "0", 〇: "0", 洞: "0", 一: "1", 壹: "1", 么: "1", 幺: "1", 二: "2", 貳: "2", 贰: "2", 两: "2", 兩: "2",
  三: "3", 參: "3", 叁: "3", 四: "4", 肆: "4", 五: "5", 伍: "5", 六: "6", 陸: "6", 陆: "6",
  七: "7", 柒: "7", 八: "8", 捌: "8", 九: "9", 玖: "9",
};
const EN: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/** 把辨識結果轉成數字序列：支援阿拉伯數字、中文數字（含大寫、兩、么）與英文 */
export function digitsOf(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9一-鿿〇]+/g, " ").split(" ").filter(Boolean);
  let out = "";
  for (const w of words) {
    if (EN[w]) {
      out += EN[w];
      continue;
    }
    for (const ch of w) {
      if (/[0-9]/.test(ch)) out += ch;
      else if (DIGIT[ch]) out += DIGIT[ch];
    }
  }
  return out;
}
