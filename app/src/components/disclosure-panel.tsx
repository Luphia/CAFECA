"use client";

import { useCallback, useEffect, useState } from "react";
import { hashMessage } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { api, type LocalWallet } from "@/lib/client";
import { encode1271 } from "@/lib/userop";
import { signWithPasskey } from "@/lib/webauthn";
import { Badge, Button, Panel, errMsg, useToast } from "./ui";

type Item = {
  id: string;
  rp: { name: string; ubn: string | null; domains: string[] } | null;
  status: "consent" | "review" | "approved1" | "released" | "rejected";
  fields: { key: string; label: string }[];
  legalBasis: { type: string; label: string; ref: string };
  reason: string;
  createdAt: number;
  releasedAt: number | null;
  consent: "pending" | "granted" | "denied" | null;
  consentMessage: { approve: string; deny: string } | null;
};

const STATUS: Record<Item["status"], { t: string; tone: "warn" | "ok" | "danger" | "neutral" }> = {
  consent: { t: "等你回覆", tone: "warn" },
  review: { t: "CAFECA 審核中", tone: "neutral" },
  approved1: { t: "CAFECA 審核中", tone: "neutral" },
  released: { t: "已提供", tone: "ok" },
  rejected: { t: "未提供", tone: "danger" },
};

/** 資料調閱紀錄：依賴方或司法機關向 CAFECA 調閱我的實名資料；「當事人同意」類要我用 Passkey 回覆 */
export function DisclosurePanel({ w }: { w: LocalWallet }) {
  const toast = useToast();
  const [list, setList] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await api<{ disclosures: Item[] }>("/api/me/disclosures", undefined, "GET")).disclosures);
    } catch {
      setList([]);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const decide = async (d: Item, decision: "approve" | "deny") => {
    if (!d.consentMessage) return;
    setBusy(d.id + decision);
    try {
      const { keyId, sig } = await signWithPasskey(hashMessage(d.consentMessage[decision]), w.passkeys);
      await api("/api/me/disclosures", { id: d.id, decision, signature: encode1271(DEPLOYMENT.keyring, keyId, sig) });
      toast(decision === "approve" ? "已同意，CAFECA 審核後會提供" : "已拒絕提供", "ok");
      await load();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="資料調閱紀錄">
      {!list ? null : list.length === 0 ? (
        <p className="text-sm text-ink-3">沒有人向 CAFECA 調閱過你的實名資料。</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="disclosure-list">
          {list.map((d) => (
            <li key={d.id} className="space-y-1.5 py-3 text-sm" data-testid={`disclosure-${d.id}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{d.rp?.name ?? "（已刪除的依賴方）"}</span>
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].t}</Badge>
              </div>
              <div className="text-xs text-ink-3">
                {d.legalBasis.label}
                {d.legalBasis.ref ? `（${d.legalBasis.ref}）` : ""} · {new Date(d.createdAt).toLocaleString("zh-TW")}
                {d.releasedAt ? ` · 提供於 ${new Date(d.releasedAt).toLocaleString("zh-TW")}` : ""}
              </div>
              <div>欄位：{d.fields.map((f) => f.label).join("、")}</div>
              <div className="text-ink-2">原因：{d.reason}</div>
              {d.status === "consent" && d.consentMessage && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Button size="sm" variant="secondary" busy={busy === d.id + "deny"} onClick={() => decide(d, "deny")} testId={`disclosure-deny-${d.id}`}>拒絕</Button>
                  <Button size="sm" busy={busy === d.id + "approve"} onClick={() => decide(d, "approve")} testId={`disclosure-approve-${d.id}`}>同意提供</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-ink-3">CAFECA 只在有法律依據或你同意時提供，並由兩位法遵人員覆核。法院、檢察或警察機關要求暫緩通知時，期限到了才會顯示在這裡。</p>
    </Panel>
  );
}
