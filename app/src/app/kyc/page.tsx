"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { DEPLOYMENT, IdentityStatus } from "@/lib/config";
import { recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api } from "@/lib/client";
import { runOp } from "@/lib/actions";
import { execCall } from "@/lib/userop";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { KycCapture, postKyc, type KycEvidence } from "@/components/kyc-capture";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, Notice, Panel, Spinner, TxLink, cx, errMsg, short, useToast } from "@/components/ui";

type Guardian = { address: Address; authoritySig: Hex };
type KycView = {
  caseId: string;
  status: "pending" | "processing" | "approved" | "review" | "rejected";
  createdAt: number;
  reasons: string[];
  result: { txHash?: string; error?: string } | null;
  submitted?: { actions: string[] };
  processedAt?: number | null;
  reviewedAt?: number | null;
};

const ACTION_LABEL: Record<string, string> = { up: "抬頭", down: "低頭", left: "左轉", right: "右轉", blink: "眨眼", speak: "念數字" };
const fmtTime = (t?: number | null) => (t ? new Date(t).toLocaleString("zh-TW", { hour12: false }) : "");

/** 已送出的案件：送出內容與審核進度（審核中不能重新送出） */
function Submitted({ v }: { v: KycView }) {
  const inAuto = v.status === "pending" || v.status === "processing";
  const approved = v.status === "approved";
  const badge = inAuto ? <Badge tone="brand">自動驗證中</Badge> : v.status === "review" ? <Badge tone="warn">人工複核中</Badge> : approved ? <Badge tone="ok">已通過</Badge> : <Badge tone="danger">未通過</Badge>;
  const steps: { label: string; state: "done" | "now" | "todo" | "fail"; time?: string }[] = [
    { label: "已送出", state: "done", time: fmtTime(v.createdAt) },
    { label: "自動驗證（證件辨識、活體、人臉比對）", state: inAuto ? "now" : "done", time: fmtTime(v.processedAt) },
    ...(v.status === "review" || v.reviewedAt ? [{ label: "人工複核", state: (v.status === "review" ? "now" : "done") as "now" | "done", time: fmtTime(v.reviewedAt) }] : []),
    {
      label: approved ? (v.result?.txHash ? "已寫入 L2 實名證明" : v.result?.error ? "鏈上寫入失敗" : "寫入 L2 實名證明中") : v.status === "rejected" ? "未通過" : "結果",
      state: approved ? (v.result?.txHash ? "done" : v.result?.error ? "fail" : "now") : v.status === "rejected" ? "fail" : "todo",
    },
  ];
  const file = (kind: string) => `/api/kyc/file?case=${v.caseId}&kind=${kind}`;
  return (
    <Panel title="已送出的實名驗證" action={badge}>
      <div data-testid="kyc-submitted" data-status={v.status}>
        <ol className="mb-4 space-y-2">
          {steps.map((st, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span
                className={cx(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                  st.state === "done" ? "bg-ok text-white" : st.state === "fail" ? "bg-danger text-white" : st.state === "now" ? "bg-brand/15 text-brand" : "bg-line text-ink-3",
                )}
              >
                {st.state === "done" ? "✓" : st.state === "fail" ? "✕" : st.state === "now" ? <Spinner className="size-3" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={st.state === "todo" ? "text-ink-3" : ""}>{st.label}</span>
                {st.time && <span className="block text-[11px] text-ink-3">{st.time}</span>}
              </span>
            </li>
          ))}
        </ol>
        {v.status === "review" && <p className="mb-3 text-xs text-ink-2">系統無法自動確認全部項目，已轉由審核人員確認，通常在 1 個工作天內完成，不需要重新送出。</p>}
        {inAuto && <p className="mb-3 text-xs text-ink-2">約需 10–60 秒，可以離開這個頁面，完成後回來就會看到結果。</p>}

        <div className="mb-1.5 text-xs font-medium text-ink-3">送出的證件（已加浮水印，只有你與審核人員看得到）</div>
        <div className="grid grid-cols-2 gap-2">
          {(["front", "back"] as const).map((k) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={k} src={file(k)} alt={k === "front" ? "證件正面" : "證件背面"} className="aspect-[1.58] w-full rounded-lg border border-line object-cover" data-testid={`kyc-sub-${k}`} />
          ))}
        </div>
        {!!v.submitted?.actions.length && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            <span className="text-ink-3">活體動作：</span>
            {v.submitted.actions.map((a, i) => (
              <span key={i} className="rounded-full border border-line px-2 py-0.5">{ACTION_LABEL[a] ?? a}</span>
            ))}
          </div>
        )}
        <div className="mt-2 text-[11px] text-ink-3">案件編號 <span className="font-mono">{v.caseId}</span></div>
      </div>
    </Panel>
  );
}

export default function KycPage() {
  return (
    <AppShell title="實名驗證">
      <KycBody />
    </AppShell>
  );
}

function KycBody() {
  const { wallet, chain, refresh } = useWallet();
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const w = wallet!;
  const [ev, setEv] = useState<KycEvidence | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ kycTx: Hex; guardianTx?: Hex } | null>(null);
  const onEvidence = useCallback((e: KycEvidence | null) => setEv(e), []);

  /** 由此裝置的金鑰送出 setGuardian：備援金鑰一經安裝，裝置與卡片都無法移除 */
  const installGuardian = async (g: Guardian) => {
    const call = execCall(DEPLOYMENT.recovery, encodeFunctionData({ abi: recoveryValidatorAbi, functionName: "setGuardian", args: [g.address, g.authoritySig] }));
    const res = await runOp(w, call, confirmOnCard);
    return res.txHash;
  };

  const [pending, setPending] = useState<KycView | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 重新整理頁面時，顯示最近一次送出的案件狀態
  useEffect(() => {
    api<KycView>("/api/kyc")
      .then((v) => (["pending", "processing", "review", "rejected"].includes(v.status) || (v.status === "approved" && !v.result?.txHash)) && setPending(v))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  // 審核中：持續更新狀態（人工複核完成後自動切換）
  const pendingId = pending && pending.status !== "rejected" ? pending.caseId : null;
  useEffect(() => {
    if (!pendingId || busy === "submit") return;
    const t = setInterval(async () => {
      const v = await api<KycView>(`/api/kyc?case=${pendingId}`).catch(() => null);
      if (!v) return;
      setPending(v);
      if (v.status === "approved" && v.result?.txHash) {
        clearInterval(t);
        await refresh();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [pendingId, busy, refresh]);

  /** 後台驗證約需 10–60 秒：輪詢到有結果（通過時等鏈上寫入完成）為止 */
  const waitResult = async (caseId: string): Promise<KycView & { guardian: Guardian | null }> => {
    for (let i = 0; i < 150; i++) {
      const v = await api<KycView & { guardian: Guardian | null }>(`/api/kyc?case=${caseId}`);
      setPending(v);
      const done = v.status === "review" || v.status === "rejected" || (v.status === "approved" && (v.result?.txHash || v.result?.error));
      if (done) return v;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("驗證時間較長，完成後會通知你；可以稍後回到這個頁面查看");
  };

  const submit = async () => {
    if (!ev) return;
    setBusy("submit");
    try {
      const sent = await postKyc<KycView>("/api/kyc", ev);
      setPending(sent);
      const r = await waitResult(sent.caseId);
      if (r.status !== "approved" || !r.result?.txHash) {
        toast(
          r.status === "review" ? "已送出，需要人工複核，完成後會通知你" : r.status === "rejected" ? `驗證未通過：${r.reasons[0] ?? "請重新拍攝"}` : `鏈上寫入失敗：${r.result?.error ?? "請稍後再試"}`,
          r.status === "review" ? "neutral" : "danger",
        );
        return;
      }
      setPending(null);
      toast(<span>實名驗證通過（L2） <TxLink hash={r.result.txHash as Hex} /></span>, "ok");
      let guardianTx: Hex | undefined;
      if (r.guardian) {
        guardianTx = await installGuardian(r.guardian);
        toast(<span>平台備援金鑰已啟用 <TxLink hash={guardianTx} /></span>, "ok");
      }
      setDone({ kycTx: r.result.txHash as Hex, guardianTx });
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const retryGuardian = async () => {
    setBusy("guardian");
    try {
      const g = await api<Guardian>("/api/kyc/guardian", {});
      const tx = await installGuardian(g);
      toast(<span>平台備援金鑰已啟用 <TxLink hash={tx} /></span>, "ok");
      await refresh();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  if (chain.level >= 2 || done) {
    return (
      <>
        <Panel title="實名驗證" action={<Badge tone="ok">L2 已通過</Badge>}>
          <p className="text-sm text-ink-2">
            證件與臉部影像已由 KYC 單位比對。鏈上只記錄等級與欄位的 Merkle root，姓名、證號等原文只存在你的裝置。
          </p>
          {done && <div className="mt-2"><TxLink hash={done.kycTx} /></div>}
        </Panel>

        <Panel title="平台備援金鑰" action={chain.guardian ? <Badge tone="brand">已啟用</Badge> : <Badge tone="warn">未啟用</Badge>}>
          {chain.guardian ? (
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                CAFECA 在硬體安全模組（HSM）為你保管一把獨立的備援金鑰 <span className="font-mono text-xs">{short(chain.guardian, 6)}</span>。你的裝置與卡片都無法移除它；它唯一能做的事，是在你遺失所有裝置、重新通過證件＋臉部驗證後，協助你把新裝置加回身分。
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                <li>不能轉帳、不能調整額度、不能動你的 AI 子錢包或卡片</li>
                <li>發起恢復後需等待 48 小時（已綁卡 7 天），期間轉出凍結，你任何一台裝置都能取消</li>
                <li>萬一備援金鑰外洩，平台以離線根金鑰立即輪替</li>
              </ul>
            </div>
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-2">實名驗證已通過，但備援金鑰還沒安裝到你的身分合約。</p>
              <Button className="w-full" onClick={retryGuardian} busy={busy === "guardian"}>啟用平台備援金鑰</Button>
            </>
          )}
        </Panel>

        <Panel title="下一步">
          <p className="mb-3 text-sm text-ink-2">完成實名的身分可以購買 CAFECA 實體卡：卡片是另一把等級更高、不能被其他金鑰移除的實體金鑰，大額交易要在卡片螢幕上確認。</p>
          <Link href="/card" className="block"><Button className="w-full" variant="secondary">購買 CAFECA 實體卡</Button></Link>
        </Panel>
      </>
    );
  }


  return (
    <>
      {chain.identityStatus === IdentityStatus.SUSPENDED && (
        <Notice tone="warn">你的實名證明目前暫停中（例如身分恢復後需要重新確認本人）。重新完成下方驗證後就會恢復，網站看到的實名等級也會跟著恢復。</Notice>
      )}
      {chain.identityStatus === IdentityStatus.REVOKED && (
        <Notice tone="danger">你的實名證明已被撤銷。重新完成下方驗證後，會由 KYC 單位重新審核。</Notice>
      )}

      {pending && pending.status !== "rejected" && (
        <>
          {(pending.status === "pending" || pending.status === "processing") && (
            <span className="sr-only" data-testid="kyc-processing">後台正在驗證</span>
          )}
          <Submitted v={pending} />
        </>
      )}
      {pending && pending.status !== "rejected" ? null : !loaded ? null : (
        <>
      <Panel title="為什麼要實名驗證？">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>身分等級提升為 L2，可以向商家、網站證明「我是真人、已成年」而不透露個資</li>
          <li>平台為你託管一把<strong>備援金鑰</strong>：所有裝置都遺失時，重新驗證本人就能找回身分</li>
          <li>可以購買 CAFECA 實體卡</li>
        </ul>
      </Panel>
      {pending?.status === "rejected" && (
        <>
          <Notice tone="danger">上一次驗證未通過：{pending.reasons.join("；") || "請重新拍攝"}。請依說明重新拍攝後再送出。</Notice>
          <Submitted v={pending} />
        </>
      )}

      <Panel title="證件與臉部影像" action={<Badge tone="warn">測試網</Badge>}>
        <p className="mb-4 text-xs text-ink-3">不需要輸入任何資料：姓名、生日與身分證字號會由系統從證件自動辨識。只能用相機即時拍攝，不能選擇相簿裡的照片。</p>
        <KycCapture onChange={onEvidence} />
      </Panel>

      <Notice>
        證件影像在你的手機上就會加上「僅供 CAFECA 身分驗證使用」浮水印，未加浮水印的原圖不會離開這台裝置。影像只用於本人比對。
      </Notice>

      <Button className="w-full" onClick={submit} busy={busy === "submit"} disabled={!ev}>
        送出實名驗證
      </Button>
        </>
      )}
    </>
  );
}
