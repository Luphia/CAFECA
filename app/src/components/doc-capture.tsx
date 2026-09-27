"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeDocFrame, captureDoc, displayToVideoRect, ID1_RATIO, type DocFeatures, type Rect } from "@/lib/kyc-vision";
import { Button, cx, Notice } from "./ui";

export type DocShot = { blob: Blob; url: string; features: DocFeatures };

const STABLE_MS = 800;

/**
 * 身分證即時拍攝：只能用相機，不能選相簿。
 * 引導框內偵測到證件四邊、清晰、無反光時框線轉綠，穩定約 0.8 秒自動拍攝；拍攝後立即疊浮水印。
 */
export function DocCapture({
  side,
  session,
  shot,
  onShot,
}: {
  side: "front" | "back";
  session: string;
  shot: DocShot | null;
  onShot: (s: DocShot | null) => void;
}) {
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; reason: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const guideInBox = useCallback((): Rect | null => {
    const el = boxRef.current;
    if (!el) return null;
    const w = el.clientWidth * 0.86;
    const h = w / ID1_RATIO;
    return { x: (el.clientWidth - w) / 2, y: (el.clientHeight - h) / 2, w, h };
  }, []);

  useEffect(() => {
    if (!live) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stop = false;
    let okSince = 0;
    let last = 0;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (stop) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);

        const loop = async (t: number) => {
          if (stop) return;
          raf = requestAnimationFrame(loop);
          if (t - last < 120 || v.readyState < 2 || !v.videoWidth) return;
          last = t;
          const g = guideInBox();
          const box = boxRef.current;
          if (!g || !box) return;
          const guide = displayToVideoRect(g, { w: box.clientWidth, h: box.clientHeight }, { w: v.videoWidth, h: v.videoHeight });
          const q = analyzeDocFrame(v, guide, ctx);
          const now = performance.now();
          if (q.ok) okSince ||= now;
          else okSince = 0;
          const progress = okSince ? Math.min(1, (now - okSince) / STABLE_MS) : 0;
          setStatus({ ok: q.ok, reason: q.reason, progress });
          if (progress >= 1) {
            stop = true;
            cancelAnimationFrame(raf);
            const res = await captureDoc(v, guide, { session, side });
            stream?.getTracks().forEach((tr) => tr.stop());
            setLive(false);
            setStatus(null);
            onShot(res);
          }
        };
        raf = requestAnimationFrame(loop);
      } catch (e) {
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? "需要允許使用相機才能拍攝證件" : "無法開啟相機");
        setLive(false);
      }
    })();

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [live, session, side, onShot, guideInBox]);

  const label = side === "front" ? "身分證正面" : "身分證反面";

  if (shot && !live) {
    return (
      <div className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={shot.url} alt={`${label}（已加浮水印）`} className="w-full rounded-2xl border border-line" data-testid={`doc-${side}`} />
        <div className="flex items-center justify-between text-xs text-ink-3">
          <span>已加上浮水印，原圖不會離開這台裝置</span>
          <button
            className="text-brand"
            onClick={() => {
              URL.revokeObjectURL(shot.url);
              onShot(null);
              setLive(true);
            }}
          >
            重拍
          </button>
        </div>
      </div>
    );
  }

  const ok = !!status?.ok;
  return (
    <div className="space-y-2">
      <div ref={boxRef} className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
        {live ? (
          <>
            <video ref={videoRef} muted playsInline className="absolute inset-0 size-full object-cover" />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div
                className={cx(
                  "relative aspect-[85.6/54] w-[86%] rounded-[14px] border-[3px] shadow-[0_0_0_999px_rgba(0,0,0,0.45)] transition-colors duration-200",
                  ok ? "border-[#4fd8a2]" : "border-white/85",
                )}
                data-testid={`doc-guide-${side}`}
                data-ok={ok}
              >
                {ok && (
                  <div className="absolute inset-x-6 bottom-2 h-1 overflow-hidden rounded-full bg-white/25">
                    <div className="h-full bg-[#4fd8a2]" style={{ width: `${Math.round((status?.progress ?? 0) * 100)}%` }} />
                  </div>
                )}
              </div>
            </div>
            <div className="absolute inset-x-0 top-3 text-center text-sm font-medium text-white drop-shadow">{label}</div>
            <div className={cx("absolute inset-x-0 bottom-3 text-center text-sm", ok ? "text-[#7ff0c1]" : "text-white")}>
              {status?.reason ?? "正在開啟相機…"}
            </div>
          </>
        ) : (
          <div className="grid size-full place-items-center p-6 text-center text-white/80">
            <div>
              <div className="mx-auto mb-3 aspect-[85.6/54] w-40 rounded-xl border-2 border-dashed border-white/40" />
              <div className="text-sm">拍攝{label}</div>
              <div className="text-xs text-white/50">放在深色平面上、四角入鏡、避免反光</div>
            </div>
          </div>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!live && (
        <Button className="w-full" variant="secondary" onClick={() => { setError(null); setLive(true); }}>
          開啟相機拍攝{label}
        </Button>
      )}
    </div>
  );
}
