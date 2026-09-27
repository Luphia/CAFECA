"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { Button, cx, Notice, errMsg } from "./ui";

export type KycEvidence = { idImage: Blob; faceVideo: Blob; seconds: number; challengeId: string };

const STEP_MS = 1800;

/** 送出 multipart（證件影像＋臉部影像＋欄位） */
export async function postKyc<T>(path: string, ev: KycEvidence, fields: Record<string, string>): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("idImage", ev.idImage, "id-front");
  fd.append("faceVideo", ev.faceVideo, ev.faceVideo.type.includes("mp4") ? "face.mp4" : "face.webm");
  fd.append("videoSeconds", String(ev.seconds));
  fd.append("challengeId", ev.challengeId);
  const res = await fetch(path, { method: "POST", body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

function pickMime() {
  const c = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return c.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

/**
 * 實名驗證的兩個步驟：拍攝身分證件、依指示錄製臉部影像（活體挑戰）。
 * 兩者都完成時呼叫 onChange(evidence)。
 */
export function KycCapture({ onChange }: { onChange: (ev: KycEvidence | null) => void }) {
  const [idImage, setIdImage] = useState<File | null>(null);
  const [idUrl, setIdUrl] = useState<string | null>(null);
  const [video, setVideo] = useState<{ blob: Blob; url: string; seconds: number; challengeId: string } | null>(null);
  const [recording, setRecording] = useState<{ steps: string[]; i: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // 錄影畫面出現後接上相機串流
  useEffect(() => {
    const el = liveRef.current;
    if (recording && el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      el.play().catch(() => undefined);
    }
  }, [recording]);

  useEffect(() => {
    onChange(idImage && video ? { idImage, faceVideo: video.blob, seconds: video.seconds, challengeId: video.challengeId } : null);
  }, [idImage, video, onChange]);

  useEffect(() => () => {
    if (idUrl) URL.revokeObjectURL(idUrl);
  }, [idUrl]);

  const pickId = (f: File | null) => {
    setIdImage(f);
    setIdUrl(f ? URL.createObjectURL(f) : null);
  };

  const record = async () => {
    setError(null);
    setVideo(null);
    let stream: MediaStream | null = null;
    try {
      const ch = await api<{ id: string; code: string; steps: string[] }>("/api/kyc/challenge", {});
      const constraints = { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } };
      stream = await navigator.mediaDevices
        .getUserMedia({ ...constraints, audio: true })
        .catch(() => navigator.mediaDevices.getUserMedia(constraints));
      streamRef.current = stream;
      setRecording({ steps: ch.steps, i: 0 });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
      const t0 = performance.now();
      rec.start(250);
      for (let i = 0; i < ch.steps.length; i++) {
        setRecording({ steps: ch.steps, i });
        await new Promise((r) => setTimeout(r, STEP_MS));
      }
      rec.stop();
      await stopped;
      const seconds = (performance.now() - t0) / 1000;
      const blob = new Blob(chunks, { type: (rec.mimeType || mime || "video/webm").split(";")[0] });
      setVideo({ blob, url: URL.createObjectURL(blob), seconds, challengeId: ch.id });
    } catch (e) {
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "需要允許使用相機才能錄製臉部影像" : errMsg(e));
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
          <StepDot done={!!idImage} n={1} /> 拍攝身分證正面
        </div>
        <label
          className={cx(
            "flex cursor-pointer items-center gap-3 rounded-xl border border-dashed p-3 text-sm",
            idImage ? "border-ok bg-ok-bg" : "border-line bg-surface-2",
          )}
        >
          {idUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={idUrl} alt="證件預覽" className="h-14 w-20 rounded-md object-cover" />
          ) : (
            <div className="grid h-14 w-20 place-items-center rounded-md border border-line text-ink-3">
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="9" cy="11" r="2" />
                <path d="M14 10h4M14 13h3M6 16h6" />
              </svg>
            </div>
          )}
          <div className="flex-1">
            <div className="font-medium">{idImage ? "已拍攝，點此重拍" : "點此拍照或選擇照片"}</div>
            <div className="text-xs text-ink-3">四角完整入鏡、避免反光</div>
          </div>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            data-testid="id-image"
            onChange={(e) => pickId(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
          <StepDot done={!!video} n={2} /> 依指示錄製臉部影像
        </div>
        {recording ? (
          <div className="relative overflow-hidden rounded-2xl bg-black">
            <video ref={liveRef} muted playsInline className="aspect-[4/3] w-full -scale-x-100 object-cover" />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="h-[70%] aspect-[3/4] rounded-[50%] border-4 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 text-white">
              <div className="text-center text-lg font-semibold" aria-live="assertive">{recording.steps[recording.i]}</div>
              <div className="mt-2 flex gap-1">
                {recording.steps.map((_, i) => (
                  <div key={i} className={cx("h-1 flex-1 rounded-full", i <= recording.i ? "bg-brand-3" : "bg-white/30")} />
                ))}
              </div>
            </div>
            <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white">
              <span className="size-2 animate-pulse rounded-full bg-danger" /> 錄影中
            </div>
          </div>
        ) : video ? (
          <div className="space-y-2">
            <video src={video.url} controls playsInline className="aspect-[4/3] w-full rounded-2xl bg-black object-cover" />
            <div className="flex items-center justify-between text-xs text-ink-3">
              <span>已錄製 {video.seconds.toFixed(1)} 秒</span>
              <button className="text-brand" onClick={record}>重新錄製</button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-surface-2 p-3">
            <ol className="mb-3 list-decimal space-y-0.5 pl-5 text-xs text-ink-2">
              <li>在光線充足處，臉對準畫面中的橢圓框</li>
              <li>畫面會依序提示：正視 → 向左轉 → 向右轉 → 眨眼 → 念出隨機數字</li>
              <li>全程約 9 秒，錄完可以預覽再送出</li>
            </ol>
            <Button className="w-full" variant="secondary" onClick={record}>開始錄製臉部影像</Button>
          </div>
        )}
        {error && <div className="mt-2"><Notice tone="danger">{error}</Notice></div>}
      </div>
    </div>
  );
}

function StepDot({ n, done }: { n: number; done: boolean }) {
  return (
    <span className={cx("grid size-5 place-items-center rounded-full text-[11px] font-semibold", done ? "bg-ok text-white" : "bg-surface-2 text-ink-3 border border-line")}>
      {done ? "✓" : n}
    </span>
  );
}
