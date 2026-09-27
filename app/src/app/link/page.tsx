"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { getAddress, type Address } from "viem";
import { DEPLOYMENT, KeyClass } from "@/lib/config";
import { keyringValidatorAbi } from "@/lib/contracts/abis";
import { api, publicClient, saveWallet } from "@/lib/client";
import { buildDeeplink, pairingCode } from "@/lib/deeplink";
import { registerPasskey, type PasskeyInfo } from "@/lib/webauthn";
import { PasskeyIcon } from "@/components/icons";
import { Badge, Button, Field, inputCls, Notice, Panel, Spinner, errMsg, useToast } from "@/components/ui";

const PK = "cafeca.link.pending.v2";
type Pending = { passkey: PasskeyInfo; session: string; exp: number };

/**
 * 新裝置連結既有身分：
 * 1. 在這台裝置註冊 passkey（此時還不知道要加入哪個身分）
 * 2. 顯示配對 QR code（pair 深連結，含新裝置公鑰）與 6 位確認碼
 * 3. 用已登入的裝置掃描 → 比對確認碼 → 以該裝置金鑰加入這把公鑰（所有裝置同級）
 * 4. 這個頁面從配對 session 取得身分地址，確認鏈上已加入後直接登入
 */
export default function LinkDevicePage() {
  const router = useRouter();
  const toast = useToast();
  const [label, setLabel] = useState("我的新裝置");
  const [pending, setPending] = useState<Pending | null>(null);
  const [expired, setExpired] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PK);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setPending(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const link = pending
    ? buildDeeplink({
        action: "pair",
        session: pending.session,
        qx: pending.passkey.qx,
        qy: pending.passkey.qy,
        name: pending.passkey.label,
        exp: pending.exp,
      })
    : null;

  useEffect(() => {
    if (!link) return;
    QRCode.toDataURL(link, { margin: 1, width: 260, errorCorrectionLevel: "M" }).then(setQr).catch(() => undefined);
  }, [link]);

  const openSession = useCallback(async (passkey: PasskeyInfo) => {
    const s = await api<{ id: string; exp: number }>("/api/link", { qx: passkey.qx, qy: passkey.qy, rpIdHash: passkey.rpIdHash, name: passkey.label });
    const p = { passkey, session: s.id, exp: s.exp };
    localStorage.setItem(PK, JSON.stringify(p));
    setExpired(false);
    setPending(p);
  }, []);

  // 等待既有裝置確認
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const r = await api<{ status: string; address?: Address }>(`/api/link?id=${pending.session}`).catch(() => null);
      if (stop) return;
      if (r?.status === "linked" && r.address) {
        const address = getAddress(r.address);
        const k = await publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [address, pending.passkey.keyId] });
        if (k.keyClass === KeyClass.DAILY) {
          localStorage.removeItem(PK);
          saveWallet({ address, passkeys: [pending.passkey], createdAt: Date.now() });
          toast("這台裝置已加入你的數位身分，請用 Passkey 解鎖", "ok");
          router.replace("/wallet");
          return;
        }
      }
      if (r?.status === "expired" || !r) {
        setExpired(true);
        return;
      }
      t = setTimeout(tick, 2500);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [pending, router, toast]);

  const createKey = async () => {
    setBusy("key");
    try {
      // 還不知道要加入哪個身分：userHandle 用隨機值；之後登入時由鏈上 KeyAdded 事件反查身分
      const userId = crypto.getRandomValues(new Uint8Array(32));
      const pk = await registerPasskey(`CAFECA · ${label || "新裝置"}`, label || "新裝置", userId);
      await openSession(pk);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const renew = async () => {
    if (!pending) return;
    setBusy("renew");
    try {
      await openSession(pending.passkey);
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const abandon = () => {
    localStorage.removeItem(PK);
    setPending(null);
    setQr(null);
  };

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 px-5 pb-10 pt-8">
      <div>
        <Link href="/start" className="text-sm text-brand">← 返回</Link>
        <h1 className="mt-3 text-2xl font-bold">連結既有身份</h1>
        <p className="mt-1 text-sm text-ink-2">
          先在這台裝置建立 passkey，再用已登入的裝置掃描 QR code，把這台裝置加入你的數位身分。加入後每台裝置的金鑰等級相同。
        </p>
      </div>

      {!pending ? (
        <Panel title="步驟 1：在這台裝置建立 Passkey">
          <Field label="裝置名稱（會顯示在另一台裝置上）">
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
          </Field>
          <Button className="mt-3 w-full" onClick={createKey} busy={busy === "key"}>
            <PasskeyIcon className="size-5" /> 建立 Passkey
          </Button>
          <p className="mt-3 text-center text-xs text-ink-3">
            身邊沒有已登入的裝置？<Link href="/recover" className="text-brand">改用實體卡或平台備援恢復</Link>
          </p>
        </Panel>
      ) : (
        <Panel title="步驟 2：用已登入的裝置掃描" action={expired ? <Badge tone="danger">已過期</Badge> : <Badge tone="warn">等待確認</Badge>}>
          {expired ? (
            <>
              <Notice tone="warn">配對 QR code 已過期（10 分鐘）。這台裝置的 passkey 仍可沿用，重新產生即可。</Notice>
              <Button className="mt-3 w-full" onClick={renew} busy={busy === "renew"}>重新產生 QR code</Button>
            </>
          ) : (
            <>
              <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm text-ink-2">
                <li>用已登入的手機相機掃描，或在已登入的裝置打開「安全」→「掃描 QR code」</li>
                <li>確認兩邊顯示的確認碼相同，按「加入」</li>
              </ol>
              {qr && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="配對 QR code" className="mx-auto rounded-xl bg-white p-2" width={260} height={260} />
              )}
              <div className="mt-3 text-center">
                <div className="text-xs text-ink-3">確認碼</div>
                <div className="font-mono text-3xl font-bold tracking-widest text-brand">{pairingCode(pending.passkey.qx, pending.passkey.qy)}</div>
              </div>
              <div className="mt-3 break-all rounded-xl bg-surface-2 p-2.5 font-mono text-[10px] text-ink-3" data-testid="pair-link">{link}</div>
              <Button variant="secondary" className="mt-2 w-full" onClick={copy}>{copied ? "已複製" : "複製配對連結"}</Button>
              <div className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-3">
                <Spinner className="text-brand" /> 對方確認後這個頁面會自動進入錢包
              </div>
            </>
          )}
          <button className="mt-4 w-full text-center text-xs text-ink-3 hover:text-danger" onClick={abandon}>放棄並重新開始</button>
        </Panel>
      )}
    </div>
  );
}
