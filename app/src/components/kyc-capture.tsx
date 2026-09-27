"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DocCapture, type DocShot } from "./doc-capture";
import { FaceLiveness, type LivenessResult } from "./face-liveness";
import { cx } from "./ui";

/** 上傳內容只有浮水印版證件、臉部影像與動作序列（規格 §14） */
export type KycEvidence = { front: DocShot; back: DocShot; face: LivenessResult };

export async function postKyc<T>(path: string, ev: KycEvidence, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("front", ev.front.blob, "front.jpg");
  fd.append("back", ev.back.blob, "back.jpg");
  fd.append("docFeatures", JSON.stringify({ front: ev.front.features, back: ev.back.features }));
  fd.append("face", ev.face.video, ev.face.video.type.includes("mp4") ? "face.mp4" : "face.webm");
  fd.append("challengeId", ev.face.challengeId);
  fd.append("actions", JSON.stringify(ev.face.log));
  fd.append("videoSeconds", String(ev.face.seconds));
  const res = await fetch(path, { method: "POST", body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

/**
 * 實名驗證的三個步驟：身分證正面 → 反面（即時拍攝、自動偵測、浮水印）→ 6 動作活體影像。
 * 全部完成時呼叫 onChange(evidence)。
 */
export function KycCapture({ onChange }: { onChange: (ev: KycEvidence | null) => void }) {
  const session = useMemo(() => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join(""), []);
  const [front, setFront] = useState<DocShot | null>(null);
  const [back, setBack] = useState<DocShot | null>(null);
  const [face, setFace] = useState<LivenessResult | null>(null);
  const onFront = useCallback((s: DocShot | null) => setFront(s), []);
  const onBack = useCallback((s: DocShot | null) => setBack(s), []);
  const onFace = useCallback((r: LivenessResult | null) => setFace(r), []);

  useEffect(() => {
    onChange(front && back && face ? { front, back, face } : null);
  }, [front, back, face, onChange]);

  return (
    <div className="space-y-5">
      <Step n={1} done={!!front} title="拍攝身分證正面">
        <DocCapture side="front" session={session} shot={front} onShot={onFront} />
      </Step>
      <Step n={2} done={!!back} title="拍攝身分證反面" disabled={!front}>
        {front ? <DocCapture side="back" session={session} shot={back} onShot={onBack} /> : <Hint>先完成正面</Hint>}
      </Step>
      <Step n={3} done={!!face} title="依指示錄製臉部影像" disabled={!back}>
        {back ? <FaceLiveness onDone={onFace} /> : <Hint>先完成證件拍攝</Hint>}
      </Step>
    </div>
  );
}

function Step({ n, done, title, disabled, children }: { n: number; done: boolean; title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx(disabled && "opacity-60")}>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className={cx("grid size-5 place-items-center rounded-full text-[11px] font-semibold", done ? "bg-ok text-white" : "border border-line bg-surface-2 text-ink-3")}>
          {done ? "✓" : n}
        </span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-ink-3">{children}</div>;
}
