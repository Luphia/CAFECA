"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { headPose, type Landmark } from "@/lib/kyc-vision";
import { Button, cx, Notice } from "./ui";

export type LivenessAction = "up" | "down" | "left" | "right" | "blink" | "speak";
export type ActionLog = { action: LivenessAction; startedAt: number; completedAt: number; peak: number };
export type LivenessResult = { video: Blob; seconds: number; challengeId: string; log: ActionLog[] };
type Challenge = { id: string; actions: LivenessAction[]; code: string; exp: number };

const LABEL: Record<LivenessAction, string> = {
  up: "慢慢抬頭",
  down: "慢慢低頭",
  left: "頭慢慢轉向左邊",
  right: "頭慢慢轉向右邊",
  blink: "眨一下眼睛",
  speak: "念出數字",
};

// 門檻（裝置端與後台重檢使用同一組）
const YAW_TARGET = 0.17; // 鼻尖偏離臉頰中線的比例
const PITCH_TARGET = 0.07; // 相對正視基準
const NEUTRAL = 0.06;
const BLINK_ON = 0.55;
const BLINK_OFF = 0.3;
const SPEAK_MS = 1400;
const ACTION_TIMEOUT = 15_000;

/** 測試網／E2E：以按鈕模擬完成動作（不載入臉部模型）。正式環境不得開啟。 */
const SIMULATE = process.env.NEXT_PUBLIC_KYC_SIMULATE === "1";

/**
 * 活體影像：後台發出 6 個隨機動作（上下左右轉頭、眨眼、念數字），
 * 偵測到依指示動作時，橢圓框線依達成比例平滑填滿綠色；全程錄影並記錄動作序列。
 */
export function FaceLiveness({ onDone }: { onDone: (r: LivenessResult | null) => void }) {
  const [phase, setPhase] = useState<"idle" | "loading" | "align" | "act" | "done">("idle");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [step, setStep] = useState(0);
  const [needNeutral, setNeedNeutral] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; seconds: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const simRef = useRef<() => void>(() => undefined);
  // 每按一次「開始錄製」遞增，effect 只依這個值執行（避免 phase 變化時中斷相機）
  const [run, setRun] = useState(0);
  const start = () => {
    setError(null);
    setPhase("loading");
    setRun((r) => r + 1);
  };

  useEffect(() => {
    if (!run) return;
    let stop = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let audioCtx: AudioContext | null = null;

    (async () => {
      try {
        const ch = await api<Challenge>("/api/kyc/challenge", {});
        if (stop) return;
        setChallenge(ch);
        stream = await navigator.mediaDevices
          .getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } }, audio: true })
          .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } }));
        if (stop) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);

        // 音量（念數字時判斷有在說話）
        let analyser: AnalyserNode | null = null;
        if (stream.getAudioTracks().length) {
          audioCtx = new AudioContext();
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          audioCtx.createMediaStreamSource(stream).connect(analyser);
        }
        const buf = new Float32Array(512);
        const rms = () => {
          if (!analyser) return 0;
          analyser.getFloatTimeDomainData(buf);
          let s = 0;
          for (const x of buf) s += x * x;
          return Math.sqrt(s / buf.length);
        };

        type Landmarker = { detectForVideo: (v: HTMLVideoElement, t: number) => { faceLandmarks: Landmark[][]; faceBlendshapes: { categories: { categoryName: string; score: number }[] }[] } };
        let landmarker: Landmarker | null = null;
        if (!SIMULATE) {
          const vision = await import("@mediapipe/tasks-vision");
          const files = await vision.FilesetResolver.forVisionTasks("/mediapipe/wasm");
          const opts = (delegate: "GPU" | "CPU") => ({
            baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
            runningMode: "VIDEO" as const,
            numFaces: 1,
            outputFaceBlendshapes: true,
          });
          landmarker = (await vision.FaceLandmarker.createFromOptions(files, opts("GPU")).catch(() =>
            vision.FaceLandmarker.createFromOptions(files, opts("CPU")),
          )) as unknown as Landmarker;
        }
        if (stop) return;

        const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

        // 狀態機
        let stage: "align" | "act" = "align";
        let i = 0;
        let neutralNeeded = false;
        let alignSince = 0;
        let base = { yaw: 0, pitch: 0.55 };
        const baseSamples: { yaw: number; pitch: number }[] = [];
        let shown = 0;
        let target = 0;
        let peak = 0;
        let fullSince = 0;
        let actStart = 0;
        let blinkClosed = false;
        let speakMs = 0;
        let lastT = 0;
        let t0 = 0;
        const log: ActionLog[] = [];
        setPhase("align");

        const complete = (now: number) => {
          const action = ch.actions[i];
          log.push({ action, startedAt: Math.round(actStart - t0), completedAt: Math.round(now - t0), peak: Number(peak.toFixed(3)) });
          i++;
          target = 0;
          shown = 0;
          peak = 0;
          fullSince = 0;
          speakMs = 0;
          blinkClosed = false;
          setProgress(0);
          if (i >= ch.actions.length) {
            stop = true;
            cancelAnimationFrame(raf);
            recorder!.onstop = () => {
              const blob = new Blob(chunks, { type: (recorder!.mimeType || mime || "video/webm").split(";")[0] });
              const seconds = (performance.now() - t0) / 1000;
              stream?.getTracks().forEach((tr) => tr.stop());
              audioCtx?.close().catch(() => undefined);
              setResult({ url: URL.createObjectURL(blob), seconds });
              setPhase("done");
              onDone({ video: blob, seconds, challengeId: ch.id, log });
            };
            recorder!.stop();
            return;
          }
          setStep(i);
          const next = ch.actions[i];
          neutralNeeded = ["up", "down", "left", "right"].includes(ch.actions[i - 1]);
          setNeedNeutral(neutralNeeded);
          actStart = now;
          void next;
        };

        simRef.current = () => {
          if (stage === "align") {
            alignSince = performance.now() - 1000;
          } else {
            target = 1;
            neutralNeeded = false;
            setNeedNeutral(false);
          }
        };

        const loop = (now: number) => {
          if (stop) return;
          raf = requestAnimationFrame(loop);
          const dt = lastT ? now - lastT : 16;
          lastT = now;

          let pose: ReturnType<typeof headPose> | null = null;
          let blink = 0;
          let jaw = 0;
          if (landmarker && v.readyState >= 2) {
            const r = landmarker.detectForVideo(v, now);
            const lm = r.faceLandmarks[0];
            if (lm) {
              pose = headPose(lm);
              const cats = r.faceBlendshapes[0]?.categories ?? [];
              const bs = (n: string) => cats.find((c) => c.categoryName === n)?.score ?? 0;
              blink = Math.min(bs("eyeBlinkLeft"), bs("eyeBlinkRight"));
              jaw = bs("jawOpen");
            }
          }

          if (stage === "align") {
            // 臉在框內、大致正視 1 秒 → 記錄基準姿態，開始錄影與第一個動作
            const centered = SIMULATE || (pose && Math.abs(pose.cx - 0.5) < 0.15 && Math.abs(pose.cy - 0.5) < 0.18 && pose.size > 0.3 && Math.abs(pose.yaw) < 0.08);
            if (centered) {
              alignSince ||= now;
              if (pose) baseSamples.push({ yaw: pose.yaw, pitch: pose.pitch });
            } else {
              alignSince = 0;
              baseSamples.length = 0;
            }
            setProgress(alignSince ? Math.min(1, (now - alignSince) / 1000) : 0);
            if (alignSince && now - alignSince >= 1000) {
              if (baseSamples.length) {
                base = {
                  yaw: baseSamples.reduce((a, b) => a + b.yaw, 0) / baseSamples.length,
                  pitch: baseSamples.reduce((a, b) => a + b.pitch, 0) / baseSamples.length,
                };
              }
              stage = "act";
              t0 = now;
              actStart = now;
              recorder!.start(250);
              setProgress(0);
              setStep(0);
              setPhase("act");
            }
            return;
          }

          const action = ch.actions[i];
          if (now - actStart > ACTION_TIMEOUT + (neutralNeeded ? 5000 : 0)) {
            stop = true;
            if (recorder?.state === "recording") recorder.stop();
            stream?.getTracks().forEach((tr) => tr.stop());
            setError(`「${LABEL[action]}」逾時，請重新錄製`);
            setPhase("idle");
            onDone(null);
            return;
          }

          if (!SIMULATE && pose) {
            const dy = pose.yaw - base.yaw;
            const dp = pose.pitch - base.pitch;
            if (neutralNeeded) {
              if (Math.abs(dy) < NEUTRAL && Math.abs(dp) < NEUTRAL) {
                neutralNeeded = false;
                setNeedNeutral(false);
                actStart = now;
              }
            } else if (action === "left") target = Math.max(0, dy) / YAW_TARGET;
            else if (action === "right") target = Math.max(0, -dy) / YAW_TARGET;
            else if (action === "up") target = Math.max(0, -dp) / PITCH_TARGET;
            else if (action === "down") target = Math.max(0, dp) / PITCH_TARGET;
            else if (action === "blink") {
              if (blink > BLINK_ON) blinkClosed = true;
              if (blinkClosed && blink < BLINK_OFF) target = 1;
              else target = Math.max(target, Math.min(0.9, blink / BLINK_ON));
            } else if (action === "speak") {
              const talking = rms() > 0.02 && jaw > 0.08;
              if (talking) speakMs += dt;
              target = speakMs / SPEAK_MS;
            }
          } else if (!SIMULATE && !neutralNeeded && action === "speak") {
            target = speakMs / SPEAK_MS;
          }

          target = Math.min(1, target);
          peak = Math.max(peak, target);
          // 平滑填色
          shown += (target - shown) * Math.min(1, dt / 120);
          setProgress(shown);
          if (target >= 1 && shown > 0.97) {
            fullSince ||= now;
            if (now - fullSince > 250) complete(now);
          } else fullSince = 0;
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? "需要允許使用相機與麥克風才能錄製" : `無法啟動臉部偵測：${e instanceof Error ? e.message : e}`);
        setPhase("idle");
      }
    })();

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      if (recorder?.state === "recording") recorder.stop();
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => undefined);
    };
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = phase === "loading" || phase === "align" || phase === "act";
  const action = challenge?.actions[step];
  const instruction =
    phase === "loading" ? "正在啟動相機與臉部偵測…"
    : phase === "align" ? "請把臉對準橢圓框、正視鏡頭"
    : needNeutral ? "回到正面"
    : action === "speak" ? `念出數字 ${challenge!.code.split("").join(" ")}`
    : action ? LABEL[action] : "";

  if (phase === "done" && result) {
    return (
      <div className="space-y-2">
        <video src={result.url} controls playsInline className="aspect-square w-full rounded-2xl bg-black object-cover" />
        <div className="flex items-center justify-between text-xs text-ink-3">
          <span>已完成 6 個動作 · {result.seconds.toFixed(1)} 秒</span>
          <button
            className="text-brand"
            onClick={() => {
              URL.revokeObjectURL(result.url);
              setResult(null);
              onDone(null);
              start();
            }}
          >
            重新錄製
          </button>
        </div>
      </div>
    );
  }

  const C = 100;
  return (
    <div className="space-y-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
        {running ? (
          <>
            <video ref={videoRef} muted playsInline className="absolute inset-0 size-full -scale-x-100 object-cover" />
            <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
              <defs>
                <mask id="oval-mask">
                  <rect width="100" height="100" fill="white" />
                  <ellipse cx="50" cy="48" rx="30" ry="38" fill="black" />
                </mask>
              </defs>
              <rect width="100" height="100" fill="rgba(0,0,0,0.5)" mask="url(#oval-mask)" />
              <ellipse cx="50" cy="48" rx="30" ry="38" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />
              <ellipse
                cx="50" cy="48" rx="30" ry="38" fill="none" stroke="#4fd8a2" strokeWidth="2.4" strokeLinecap="round"
                pathLength={C} strokeDasharray={`${progress * C} ${C}`} transform="rotate(-90 50 48)"
              />
            </svg>
            <div className="absolute inset-x-0 top-3 flex justify-center gap-1">
              {(challenge?.actions ?? []).map((a, k) => (
                <span key={k} className={cx("h-1.5 w-6 rounded-full", phase === "act" && k < step ? "bg-[#4fd8a2]" : phase === "act" && k === step ? "bg-white" : "bg-white/30")} />
              ))}
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 text-center text-white">
              <div className="text-lg font-semibold" aria-live="assertive" data-testid="liveness-instruction">{instruction}</div>
              {phase === "act" && <div className="text-xs text-white/70">動作 {step + 1} / {challenge?.actions.length ?? 6}</div>}
            </div>
            {phase === "act" && (
              <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white">
                <span className="size-2 animate-pulse rounded-full bg-danger" /> 錄影中
              </div>
            )}
          </>
        ) : (
          <div className="grid size-full place-items-center p-6 text-center text-white/80">
            <div>
              <svg viewBox="0 0 100 120" className="mx-auto mb-3 h-24" aria-hidden>
                <ellipse cx="50" cy="60" rx="34" ry="46" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeDasharray="4 4" />
              </svg>
              <div className="text-sm">系統會隨機要求 6 個動作</div>
              <div className="text-xs text-white/50">抬頭、低頭、左轉、右轉、眨眼、念出數字</div>
            </div>
          </div>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!running && (
        <Button className="w-full" variant="secondary" onClick={start}>
          開始錄製臉部影像
        </Button>
      )}
      {SIMULATE && running && (
        <Button className="w-full" variant="ghost" onClick={() => simRef.current()}>模擬完成此動作（測試網）</Button>
      )}
    </div>
  );
}
