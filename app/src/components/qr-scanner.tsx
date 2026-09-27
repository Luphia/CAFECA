"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Notice } from "./ui";

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/**
 * 相機掃描 QR code：優先用瀏覽器內建的 BarcodeDetector（Chrome／Android），
 * 其他瀏覽器（Safari 等）改用 jsQR 逐格解碼。
 */
export function QrScanner({ onResult, onClose, hint = "將新裝置畫面上的 QR code 放進框內" }: { onResult: (text: string) => void; onClose: () => void; hint?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (cancelled) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => undefined);

        const Native = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
        const detector = Native ? new Native({ formats: ["qr_code"] }) : null;
        const jsQR = detector ? null : (await import("jsqr")).default;

        const tick = async () => {
          if (cancelled || done.current) return;
          if (v.readyState >= 2 && v.videoWidth > 0) {
            let text: string | null = null;
            if (detector) {
              const r = await detector.detect(v).catch(() => []);
              text = r[0]?.rawValue ?? null;
            } else if (jsQR && ctx) {
              const w = Math.min(640, v.videoWidth);
              const h = Math.round((v.videoHeight / v.videoWidth) * w);
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(v, 0, 0, w, h);
              const img = ctx.getImageData(0, 0, w, h);
              text = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
            if (text) {
              done.current = true;
              onResult(text);
              return;
            }
          }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch (e) {
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? "需要允許使用相機才能掃描" : "無法開啟相機，請改用貼上連結");
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-2xl bg-black">
        <video ref={videoRef} muted playsInline className="aspect-square w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="size-[62%] rounded-2xl border-4 border-white/85 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
        </div>
        <div className="absolute inset-x-0 bottom-3 text-center text-sm text-white">{hint}</div>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button variant="secondary" className="w-full" onClick={onClose}>關閉相機</Button>
    </div>
  );
}
