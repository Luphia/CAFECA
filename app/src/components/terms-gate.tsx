"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { hashMessage } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { api, type LocalWallet } from "@/lib/client";
import { encode1271 } from "@/lib/userop";
import { signWithPasskey } from "@/lib/webauthn";
import { Button, Notice, Panel, Spinner, errMsg } from "./ui";

type Status = { version: string; hash: string; draft: boolean; accepted: boolean; message: string };

/** 條款版本同意：未同意目前版本前，只能看條款與登出 */
export function TermsGate({ w, children }: { w: LocalWallet; children: ReactNode }) {
  const [st, setSt] = useState<Status | null>(null);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSt(await api<Status>("/api/terms"));
    } catch {
      setSt({ version: "", hash: "", draft: false, accepted: true, message: "" }); // 讀不到時不擋（伺服器端送件仍會檢查）
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (!st) return <div className="grid place-items-center py-16"><Spinner className="text-brand" /></div>;
  if (st.accepted) return <>{children}</>;

  const accept = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { keyId, sig } = await signWithPasskey(hashMessage(st.message), w.passkeys);
      await api("/api/terms", { version: st.version, signature: encode1271(DEPLOYMENT.keyring, keyId, sig) });
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="服務條款與隱私權告知">
      <div className="space-y-3 text-sm" data-testid="terms-gate">
        <p>繼續使用前，請閱讀並同意目前版本（{st.version}）的條款。</p>
        {st.draft && <Notice tone="warn">目前是草案版本，定稿後會請你重新同意。</Notice>}
        <div className="flex gap-3">
          <a className="text-brand underline" href="/terms" target="_blank" rel="noreferrer">服務條款</a>
          <a className="text-brand underline" href="/privacy" target="_blank" rel="noreferrer">隱私權告知</a>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} data-testid="terms-read" />
          我已閱讀服務條款與隱私權告知
        </label>
        {err && <Notice tone="danger">{err}</Notice>}
        <Button className="w-full" disabled={!read} busy={busy} onClick={accept} testId="terms-accept">以 Passkey 同意</Button>
        <p className="text-xs text-ink-3">你的同意會以 Passkey 簽章存證（版本與內容雜湊），可以隨時在「安全」頁查看。</p>
      </div>
    </Panel>
  );
}

/** 「安全」頁：我同意過的條款版本 */
export function TermsSummary() {
  const [st, setSt] = useState<(Status & { acceptedAt: number | null; history: { version: string; at: number }[] }) | null>(null);
  useEffect(() => {
    api<Status & { acceptedAt: number | null; history: { version: string; at: number }[] }>("/api/terms").then(setSt, () => undefined);
  }, []);
  if (!st) return null;
  return (
    <Panel title="服務條款與隱私權告知">
      <div className="space-y-1 text-sm" data-testid="terms-summary">
        <div>
          目前版本 {st.version}：{st.accepted && st.acceptedAt ? `已於 ${new Date(st.acceptedAt).toLocaleString("zh-TW")} 以 Passkey 同意` : "尚未同意"}
        </div>
        {st.history.length > 1 && <div className="text-xs text-ink-3">同意紀錄：{st.history.map((h) => `${h.version}（${new Date(h.at).toLocaleDateString("zh-TW")}）`).join("、")}</div>}
        <div className="flex gap-3 text-xs">
          <a className="text-brand underline" href="/terms" target="_blank" rel="noreferrer">服務條款</a>
          <a className="text-brand underline" href="/privacy" target="_blank" rel="noreferrer">隱私權告知</a>
        </div>
      </div>
    </Panel>
  );
}
