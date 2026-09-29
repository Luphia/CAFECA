"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { erc20Abi, getAddress, isAddress, keccak256, parseUnits, toHex, type Address } from "viem";
import { DEPLOYMENT, TWDC_DECIMALS } from "@/lib/config";
import { api, publicClient } from "@/lib/client";
import { runOp } from "@/lib/actions";
import { ROLE, ROLE_LABEL, createEntityCall, entityLimits, predictEntity, runEntityOp, setMemberCall } from "@/lib/entity";
import { execCall } from "@/lib/userop";
import { encodeFunctionData } from "viem";
import { AddressInput } from "@/components/address-input";
import { AppShell } from "@/components/app-shell";
import { useCardConfirm } from "@/components/card-provider";
import { useWallet } from "@/components/wallet-provider";
import { Badge, Button, Field, Notice, Panel, Spinner, TxLink, cx, errMsg, fmtTwdc, inputCls, short, useToast } from "@/components/ui";

type Application = { id: string; ubn: string; status: "pending" | "review" | "approved" | "rejected"; path: string; at: number; companyName: string | null; reasons: string[]; result: { txHash?: string; error?: string } | null };
type Entity = {
  entity: Address;
  role: number;
  displayName: string | null;
  verified: { ubn: string; name: string; approvedAt: number } | null;
  monitor: { status: string; detail?: string } | null;
  application: Application | null;
};
type Member = { member: Address; role: number; handle: string | null };

export default function CompanyPage() {
  return (
    <AppShell title="公司帳戶">
      <CompanyBody />
    </AppShell>
  );
}

function CompanyBody() {
  const { wallet, chain } = useWallet();
  const w = wallet!;
  const confirmOnCard = useCardConfirm();
  const toast = useToast();
  const [data, setData] = useState<{ supported: boolean; entities: Entity[] } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Address | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ supported: boolean; entities: Entity[] }>("/api/entity").catch(() => ({ supported: false, entities: [] }));
    setData(r);
    setOpen((o) => o ?? r.entities[0]?.entity ?? null);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const salt = keccak256(toHex(`${name.trim()}:${Date.now()}`));
      const entity = await predictEntity(w.address, salt);
      const res = await runOp(w, createEntityCall(salt), confirmOnCard);
      await api("/api/entity", { entity, displayName: name.trim() });
      toast(<span>公司帳戶已建立 <TxLink hash={res.txHash} /></span>, "ok");
      setName("");
      setOpen(entity);
      await load();
    } catch (e) {
      toast(errMsg(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Spinner className="text-brand" />;
  if (!data.supported) return <Notice>公司帳戶功能尚未在這個網路上啟用（需要部署法人帳戶合約）。</Notice>;

  return (
    <>
      <Panel title="公司帳戶">
        <p className="text-sm text-ink-2">
          公司帳戶是一個獨立的 CAFECA 身分，沒有自己的金鑰，由你與同事以各自的 Passkey 代為簽署，稽核時看得到是誰簽的。通過商工登記驗證後才能動用資金；額度由 CAFECA 設定。
        </p>
      </Panel>

      {data.entities.map((e) => (
        <EntityCard key={e.entity} e={e} open={open === e.entity} onToggle={() => setOpen(open === e.entity ? null : e.entity)} onChanged={load} />
      ))}

      <Panel title="建立公司帳戶">
        {chain.level < 2 ? (
          <Notice tone="warn">
            建立公司帳戶需要先完成個人實名驗證（L2）。<Link href="/kyc" className="text-brand">前往驗證</Link>
          </Notice>
        ) : (
          <>
            <div className="flex gap-2">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="顯示名稱，例如 咖啡豆小舖" data-testid="entity-name" />
              <Button onClick={create} busy={busy} disabled={!name.trim()} testId="entity-create">建立</Button>
            </div>
            <p className="mt-2 text-xs text-ink-3">你會成為第一位管理者。建立後以統一編號申請驗證：你是登記的代表人就會自動通過，否則需上傳代表人授權書，由 CAFECA 人工複核。</p>
          </>
        )}
      </Panel>
    </>
  );
}

function statusBadge(e: Entity) {
  if (e.verified && e.monitor?.status === "suspended") return <Badge tone="warn">暫停，需重新驗證</Badge>;
  if (e.monitor?.status === "revoked") return <Badge tone="danger">已撤銷</Badge>;
  if (e.verified) return <Badge tone="ok">已驗證</Badge>;
  if (e.application?.status === "review") return <Badge tone="warn">人工複核中</Badge>;
  if (e.application?.status === "rejected") return <Badge tone="danger">未通過</Badge>;
  return <Badge>未驗證</Badge>;
}

function EntityCard({ e, open, onToggle, onChanged }: { e: Entity; open: boolean; onToggle: () => void; onChanged: () => Promise<void> }) {
  const { wallet } = useWallet();
  const w = wallet!;
  const toast = useToast();
  const admin = e.role === ROLE.ADMIN;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [lim, setLim] = useState<{ perTx: bigint; daily: bigint; spent: bigint } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ubn, setUbn] = useState("");
  const [letter, setLetter] = useState<File | null>(null);
  const [newMember, setNewMember] = useState("");
  const [newRole, setNewRole] = useState<number>(ROLE.OPERATOR);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  const refresh = useCallback(async () => {
    const [m, b, l] = await Promise.all([
      api<{ members: Member[] }>(`/api/entity/members?entity=${e.entity}`).catch(() => null),
      publicClient.readContract({ address: DEPLOYMENT.twdc, abi: erc20Abi, functionName: "balanceOf", args: [e.entity] }).catch(() => null),
      entityLimits(e.entity).catch(() => null),
    ]);
    setMembers(m?.members ?? []);
    setBal(b);
    setLim(l);
  }, [e.entity]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) refresh();
  }, [open, refresh]);

  const wrap = (id: string, fn: () => Promise<void>) => async () => {
    setBusy(id);
    try {
      await fn();
      await refresh();
      await onChanged();
    } catch (err) {
      toast(errMsg(err), "danger");
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (q: string): Promise<Address> => {
    const v = q.trim();
    if (isAddress(v)) return getAddress(v);
    return (await api<{ address: Address }>(`/api/profile?q=${encodeURIComponent(v)}`)).address;
  };

  const apply = wrap("apply", async () => {
    const fd = new FormData();
    fd.append("entity", e.entity);
    fd.append("ubn", ubn.trim());
    if (letter) fd.append("letter", letter);
    const r = await fetch("/api/entity/apply", { method: "POST", body: fd });
    const j = (await r.json()) as { error?: string; application?: Application };
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    const st = j.application?.status;
    toast(st === "approved" ? "驗證通過，已簽發法人證明" : st === "review" ? "已送出，待人工複核" : `未通過：${j.application?.reasons[0] ?? ""}`, st === "rejected" ? "danger" : "ok");
  });

  const addMember = wrap("member", async () => {
    const m = await resolve(newMember);
    const res = await runEntityOp(w, e.entity, setMemberCall(m, newRole));
    toast(<span>已設定成員 <TxLink hash={res.txHash} /></span>, "ok");
    setNewMember("");
  });

  const changeRole = (m: Address, role: number) =>
    wrap("m" + m, async () => {
      const res = await runEntityOp(w, e.entity, setMemberCall(m, role));
      toast(<span>{role === ROLE.NONE ? "已移除成員" : "已變更角色"} <TxLink hash={res.txHash} /></span>, "ok");
    })();

  const pay = wrap("pay", async () => {
    const dest = await resolve(to);
    const value = parseUnits(amount || "0", TWDC_DECIMALS);
    if (value <= 0n) throw new Error("請輸入金額");
    const call = execCall(DEPLOYMENT.twdc, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, value] }));
    const res = await runEntityOp(w, e.entity, call);
    toast(<span>公司帳戶已轉出 {amount} TWDC <TxLink hash={res.txHash} /></span>, "ok");
    setTo("");
    setAmount("");
  });

  const canApply = admin && (!e.verified || e.monitor?.status === "suspended") && !["review", "pending"].includes(e.application?.status ?? "");

  return (
    <Panel
      title={e.displayName ?? short(e.entity, 6)}
      action={
        <button onClick={onToggle} className="flex items-center gap-2" data-testid={`entity-${e.entity}`}>
          {statusBadge(e)}
          <span className="text-xs text-ink-3">{open ? "收合" : "展開"}</span>
        </button>
      }
    >
      <div className="font-mono text-xs text-ink-3" data-testid="entity-address">{e.entity}</div>
      <div className="mt-1 text-xs text-ink-3">你的角色：{ROLE_LABEL[e.role]}</div>
      {e.verified && (
        <div className="mt-2 rounded-xl border border-line px-3 py-2 text-sm" data-testid="entity-verified">
          {e.verified.name}
          <span className="ml-2 font-mono text-xs text-ink-3">統編 {e.verified.ubn}</span>
        </div>
      )}
      {e.monitor?.status === "suspended" && <Notice tone="warn">{e.monitor.detail ?? "商工登記資料已變更"}。請管理者重新申請驗證。</Notice>}
      {e.monitor?.status === "revoked" && <Notice tone="danger">{e.monitor.detail ?? "公司已解散或撤銷"}，法人證明已撤銷。</Notice>}

      {open && (
        <div className="mt-4 space-y-5">
          {e.application?.status === "review" && <Notice tone="warn">驗證申請（統編 {e.application.ubn}）人工複核中，通常 1 個工作天內完成。</Notice>}
          {e.application?.status === "rejected" && !e.verified && <Notice tone="danger">上次申請未通過：{e.application.reasons.join("；")}</Notice>}

          {canApply && (
            <section className="space-y-2" data-testid="entity-apply">
              <div className="text-sm font-medium">以商工登記驗證</div>
              <input className={inputCls} value={ubn} onChange={(ev) => setUbn(ev.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="統一編號（8 碼）" inputMode="numeric" data-testid="entity-ubn" />
              <label className="block text-xs text-ink-3">
                不是登記的代表人？請附代表人簽署的授權書（PDF 或圖片）：
                <input type="file" accept="application/pdf,image/png,image/jpeg" className="mt-1 block text-xs" onChange={(ev) => setLetter(ev.target.files?.[0] ?? null)} data-testid="entity-letter" />
              </label>
              <Button className="w-full" onClick={apply} busy={busy === "apply"} disabled={ubn.length !== 8} testId="entity-apply-btn">送出驗證</Button>
              <p className="text-[11px] text-ink-3">以經濟部商工登記公示資料查詢：公司狀況須為「核准設立」。你的證件姓名與登記代表人相同時自動通過；CAFECA 每天重新查詢，代表人或公司狀況改變時會暫停或撤銷。</p>
            </section>
          )}

          <section>
            <div className="mb-2 text-sm font-medium">資金</div>
            <div className="grid grid-cols-3 gap-2 text-sm">
              {[
                ["餘額", bal],
                ["單筆上限", lim?.perTx ?? null],
                ["今日已用", lim ? lim.spent : null],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-xl border border-line px-3 py-2">
                  <div className="text-[11px] text-ink-3">{k as string}</div>
                  <div className="font-semibold" data-testid={k === "餘額" ? "entity-balance" : undefined}>{v === null ? "…" : `${fmtTwdc(v as bigint)}`}</div>
                </div>
              ))}
            </div>
            {e.verified && e.monitor?.status !== "suspended" && e.monitor?.status !== "revoked" ? (
              <div className="mt-3 space-y-2">
                <AddressInput value={to} onChange={setTo} placeholder="收款人 @代稱 或 0x…" />
                <div className="flex gap-2">
                  <input className={inputCls} value={amount} onChange={(ev) => setAmount(ev.target.value)} placeholder="金額（TWDC）" inputMode="decimal" data-testid="entity-amount" />
                  <Button onClick={pay} busy={busy === "pay"} disabled={!to || !amount} testId="entity-pay">轉出</Button>
                </div>
                <p className="text-[11px] text-ink-3">由你以個人 Passkey 代公司簽署；經辦與管理者都可以轉帳，額度由 CAFECA 設定。收款地址：<span className="font-mono">{short(e.entity, 6)}</span></p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-3">通過驗證後才能轉出；現在就可以收款到 <span className="font-mono">{short(e.entity, 6)}</span>。</p>
            )}
          </section>

          <section>
            <div className="mb-2 text-sm font-medium">成員</div>
            {!members ? (
              <Spinner className="text-brand" />
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid="entity-members">
                {members.map((m) => (
                  <li key={m.member} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      {m.handle ? `@${m.handle}` : short(m.member, 6)}
                      {m.member.toLowerCase() === w.address.toLowerCase() && <span className="ml-1 text-xs text-ink-3">（你）</span>}
                      <span className={cx("ml-2 text-xs", m.role === ROLE.ADMIN ? "text-brand" : "text-ink-3")}>{ROLE_LABEL[m.role]}</span>
                    </span>
                    {admin && (
                      <span className="flex shrink-0 gap-1">
                        <Button size="sm" variant="secondary" busy={busy === "m" + m.member} onClick={() => changeRole(m.member, m.role === ROLE.ADMIN ? ROLE.OPERATOR : ROLE.ADMIN)}>
                          設為{m.role === ROLE.ADMIN ? "經辦" : "管理者"}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => changeRole(m.member, ROLE.NONE)}>移除</Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {admin && (
              <div className="mt-3 space-y-2">
                <Field label="新增成員（需完成 L2 實名）">
                  <AddressInput value={newMember} onChange={setNewMember} placeholder="@代稱 或 0x…" />
                </Field>
                <div className="flex gap-2">
                  <select className={inputCls} value={newRole} onChange={(ev) => setNewRole(Number(ev.target.value))} data-testid="entity-role">
                    <option value={ROLE.OPERATOR}>經辦：轉帳與授權</option>
                    <option value={ROLE.ADMIN}>管理者：另可管理成員與呼叫其他合約</option>
                  </select>
                  <Button onClick={addMember} busy={busy === "member"} disabled={!newMember.trim()} testId="entity-add-member">新增</Button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
