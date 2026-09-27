"use client";

/**
 * KYC 裝置端影像處理（只負責引導與品質，所有判定都會在後台重新驗證）
 * - 證件：引導框四邊的邊緣強度、清晰度、反光
 * - 浮水印：原圖只存在記憶體，上傳前一定先疊浮水印
 * - 臉部：由 MediaPipe 臉部特徵點估計頭部轉向（與鏡像與否無關）
 */

/** 身分證 ID-1 尺寸比例 85.6 × 54 mm */
export const ID1_RATIO = 85.6 / 54;

export type Rect = { x: number; y: number; w: number; h: number };

/** 畫面上的引導框（以顯示容器座標）轉換成影片像素座標（video 以 object-cover 顯示） */
export function displayToVideoRect(r: Rect, box: { w: number; h: number }, video: { w: number; h: number }): Rect {
  const scale = Math.max(box.w / video.w, box.h / video.h);
  const ox = (box.w - video.w * scale) / 2;
  const oy = (box.h - video.h * scale) / 2;
  return { x: (r.x - ox) / scale, y: (r.y - oy) / scale, w: r.w / scale, h: r.h / scale };
}

export type DocQuality = {
  sides: [number, number, number, number]; // 上、右、下、左 的邊緣分數（>1 代表明顯邊緣）
  aligned: boolean;
  sharpness: number;
  glare: number; // 過曝像素比例
  ok: boolean;
  reason: string;
};

const AW = 320; // 分析用的縮圖寬度

/**
 * 分析一格影像：證件是否對齊引導框
 * 作法：取引導框外加 12% 邊界的區域縮成 320px，計算 Sobel 梯度；
 * 在引導框四邊的窄帶中取「垂直於該邊」的梯度平均，相對於整體平均的倍數即為該邊分數。
 */
export function analyzeDocFrame(video: HTMLVideoElement, guide: Rect, ctx: CanvasRenderingContext2D): DocQuality {
  const mx = guide.w * 0.12;
  const my = guide.h * 0.12;
  const sx = Math.max(0, guide.x - mx);
  const sy = Math.max(0, guide.y - my);
  const sw = Math.min(video.videoWidth - sx, guide.w + 2 * mx);
  const sh = Math.min(video.videoHeight - sy, guide.h + 2 * my);
  const k = AW / sw;
  const W = AW;
  const H = Math.max(8, Math.round(sh * k));
  ctx.canvas.width = W;
  ctx.canvas.height = H;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  const g = new Float32Array(W * H);
  let bright = 0;
  for (let i = 0; i < W * H; i++) {
    const v = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    g[i] = v;
  }
  // 引導框在縮圖中的位置
  const gx0 = Math.round((guide.x - sx) * k);
  const gy0 = Math.round((guide.y - sy) * k);
  const gx1 = Math.round((guide.x + guide.w - sx) * k);
  const gy1 = Math.round((guide.y + guide.h - sy) * k);

  const gxArr = new Float32Array(W * H);
  const gyArr = new Float32Array(W * H);
  let total = 0;
  let n = 0;
  let lapSum = 0;
  let lapSq = 0;
  let lapN = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const a = g[i - W - 1], b = g[i - W], c = g[i - W + 1];
      const d = g[i - 1], f = g[i + 1];
      const gg = g[i + W - 1], h = g[i + W], ii = g[i + W + 1];
      const dx = c + 2 * f + ii - (a + 2 * d + gg);
      const dy = gg + 2 * h + ii - (a + 2 * b + c);
      gxArr[i] = Math.abs(dx);
      gyArr[i] = Math.abs(dy);
      total += Math.abs(dx) + Math.abs(dy);
      n++;
      if (x > gx0 + 4 && x < gx1 - 4 && y > gy0 + 4 && y < gy1 - 4) {
        const lap = b + d + f + h - 4 * g[i];
        lapSum += lap;
        lapSq += lap * lap;
        lapN++;
        if (g[i] > 245) bright++;
      }
    }
  }
  const mean = total / Math.max(1, n) / 2 + 1;
  const band = Math.max(2, Math.round(Math.min(gx1 - gx0, gy1 - gy0) * 0.05));

  const sideScore = (horizontal: boolean, pos: number, from: number, to: number) => {
    let best = 0;
    // 容許證件邊緣落在框線附近的窄帶內：取帶內梯度最強的那一條線
    for (let o = -band; o <= band; o++) {
      let s = 0;
      let c = 0;
      for (let t = from; t < to; t++) {
        const x = horizontal ? t : pos + o;
        const y = horizontal ? pos + o : t;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        s += horizontal ? gyArr[y * W + x] : gxArr[y * W + x];
        c++;
      }
      if (c) best = Math.max(best, s / c);
    }
    return best / mean;
  };
  const inset = (a: number, b: number) => [Math.round(a + (b - a) * 0.1), Math.round(b - (b - a) * 0.1)] as const;
  const [hx0, hx1] = inset(gx0, gx1);
  const [vy0, vy1] = inset(gy0, gy1);
  const sides: [number, number, number, number] = [
    sideScore(true, gy0, hx0, hx1),
    sideScore(false, gx1, vy0, vy1),
    sideScore(true, gy1, hx0, hx1),
    sideScore(false, gx0, vy0, vy1),
  ];
  const aligned = sides.every((s) => s > 2.2);
  const lapMean = lapSum / Math.max(1, lapN);
  const sharpness = lapSq / Math.max(1, lapN) - lapMean * lapMean;
  const glare = bright / Math.max(1, lapN);
  let reason = "";
  if (!aligned) reason = "請把證件四邊對齊框線";
  else if (sharpness < 40) reason = "影像模糊，請保持穩定、對焦";
  else if (glare > 0.04) reason = "有反光，請稍微調整角度";
  return { sides, aligned, sharpness, glare, ok: !reason, reason: reason || "很好，請保持不動" };
}

/** 在裝置端計算的翻拍相關特徵（以原圖計算，隨浮水印影像一起上傳） */
export type DocFeatures = { sharpness: number; glare: number; moire: number; width: number; height: number; capturedAt: number };

/** 擷取引導框內的影像、計算特徵、疊上浮水印，回傳只含浮水印版的 JPEG */
export async function captureDoc(
  video: HTMLVideoElement,
  guide: Rect,
  stamp: { session: string; side: "front" | "back" },
): Promise<{ blob: Blob; url: string; features: DocFeatures }> {
  const pad = 0.03;
  const sx = Math.max(0, guide.x - guide.w * pad);
  const sy = Math.max(0, guide.y - guide.h * pad);
  const sw = Math.min(video.videoWidth - sx, guide.w * (1 + 2 * pad));
  const sh = Math.min(video.videoHeight - sy, guide.h * (1 + 2 * pad));
  const scale = Math.min(1, 1600 / sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const features = computeFeatures(ctx, canvas.width, canvas.height);
  drawWatermark(ctx, canvas.width, canvas.height, stamp);

  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("無法產生影像"))), "image/jpeg", 0.9));
  // 原圖只在這個 canvas 上，疊完浮水印後即不存在未加浮水印的版本
  return { blob, url: URL.createObjectURL(blob), features };
}

function computeFeatures(ctx: CanvasRenderingContext2D, w: number, h: number): DocFeatures {
  const d = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(1, Math.floor(w / 400));
  let lapS = 0, lapQ = 0, lapN = 0, bright = 0, hf = 0, lf = 0;
  const lum = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      const c = lum(x, y);
      const lap = lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1) - 4 * c;
      lapS += lap;
      lapQ += lap * lap;
      lapN++;
      if (c > 245) bright++;
      // 翻拍螢幕常見的高頻週期紋路：相鄰像素交錯差 vs 較大尺度差
      hf += Math.abs(lum(x + 1, y) - 2 * c + lum(x - 1, y));
      lf += Math.abs(lum(x + 2, y) - lum(x - 2, y)) + 1;
    }
  }
  const m = lapS / lapN;
  return { sharpness: lapQ / lapN - m * m, glare: bright / lapN, moire: hf / lf, width: w, height: h, capturedAt: Date.now() };
}

/** 浮水印：滿版斜向「僅供 CAFECA 身分驗證使用」＋底部戳記（日期時間、session） */
export function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, stamp: { session: string; side: string }) {
  const text = "僅供 CAFECA 身分驗證使用";
  const fs = Math.round(h * 0.055);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-24 * Math.PI) / 180);
  ctx.font = `600 ${fs}px "Noto Sans TC", "PingFang TC", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width + fs * 2.5;
  const lh = fs * 3.2;
  const span = Math.hypot(w, h);
  for (let y = -span; y < span; y += lh) {
    const shift = (Math.round(y / lh) % 2) * (tw / 2);
    for (let x = -span; x < span; x += tw) {
      ctx.lineWidth = Math.max(1, fs * 0.06);
      ctx.strokeStyle = "rgba(0,0,0,0.13)";
      ctx.strokeText(text, x + shift, y);
      ctx.fillStyle = "rgba(255,255,255,0.24)";
      ctx.fillText(text, x + shift, y);
    }
  }
  ctx.restore();

  const bh = Math.round(h * 0.075);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, h - bh, w, bh);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `600 ${Math.round(bh * 0.46)}px "Noto Sans TC", "PingFang TC", sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const when = new Date().toLocaleString("zh-TW", { hour12: false });
  ctx.fillText(`${text} · ${stamp.side === "front" ? "正面" : "反面"} · ${when} · ${stamp.session.slice(0, 10).toUpperCase()}`, bh * 0.4, h - bh / 2);
}

// ───────────────────────── 臉部 ─────────────────────────

export type Landmark = { x: number; y: number };

/**
 * 頭部轉向（與鏡像無關，以原始相機影像的特徵點計算）
 * - yaw：鼻尖在左右臉頰之間的位置，偏離 0.5 的量（正值＝使用者往自己的左邊轉）
 * - pitch：鼻尖在額頭與下巴之間的位置（數值變小＝抬頭）
 */
export function headPose(lm: Landmark[]) {
  const nose = lm[1];
  const cheekA = lm[234];
  const cheekB = lm[454];
  const top = lm[10];
  const chin = lm[152];
  const yaw = (nose.x - cheekA.x) / (cheekB.x - cheekA.x || 1e-6) - 0.5;
  const pitch = (nose.y - top.y) / (chin.y - top.y || 1e-6);
  const cx = (cheekA.x + cheekB.x) / 2;
  const cy = (top.y + chin.y) / 2;
  const size = Math.hypot(cheekB.x - cheekA.x, chin.y - top.y);
  return { yaw, pitch, cx, cy, size };
}
