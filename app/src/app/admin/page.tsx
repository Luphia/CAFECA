"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AdminLogin, adminCall, type StaffView } from "@/components/admin-login";
import { Badge, Button, Panel, Spinner } from "@/components/ui";

const PAGES: { href: string; title: string; desc: string; roles: string[] }[] = [
  { href: "/admin/kyc", title: "KYC 人工複核", desc: "證件、臉部影像、各項檢查，核准或退件", roles: ["kyc"] },
  { href: "/admin/entity", title: "法人驗證複核", desc: "商工登記、代表人比對、授權書", roles: ["kyc"] },
  { href: "/admin/disclosures", title: "資料調閱覆核", desc: "雙人覆核：第一位核准、第二位放行", roles: ["disclosure"] },
  { href: "/admin/limits", title: "交易額度", desc: "查詢與調整帳戶額度", roles: ["limits"] },
  { href: "/admin/rp", title: "依賴方登記", desc: "資料調閱 API 的使用者與 API 金鑰", roles: ["admin"] },
  { href: "/admin/staff", title: "人員管理", desc: "邀請人員、角色、Passkey、停用", roles: ["admin"] },
  { href: "/admin/policy", title: "時限與保存期限", desc: "調閱回應時限、同意有效期、保存期限與清除", roles: ["admin", "audit"] },
  { href: "/admin/audit", title: "稽核紀錄", desc: "hash-chained 紀錄與整條鏈驗證", roles: ["audit", "admin"] },
];

/** 管理後台首頁：依角色列出可以使用的功能 */
export default function AdminHome() {
  const [me, setMe] = useState<StaffView | null | undefined>(undefined);
  const load = useCallback(async () => {
    setMe((await adminCall<{ staff: StaffView | null }>("/api/admin/session")).staff);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (me === undefined) return <div className="p-10"><Spinner className="text-brand" /></div>;
  if (me === null) return <AdminLogin title="CAFECA 管理後台" onDone={load} />;
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">CAFECA 管理後台</h1>
        <div className="flex items-center gap-2 text-sm">
          <span data-testid="staff-me">{me.who}</span>
          <Button size="sm" variant="secondary" testId="staff-logout" onClick={async () => { await adminCall("/api/admin/session", { action: "logout" }); await load(); }}>登出</Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">{me.roles.map((r) => <Badge key={r}>{r}</Badge>)}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PAGES.filter((p) => p.roles.some((r) => me.roles.includes(r))).map((p) => (
          <Link key={p.href} href={p.href}>
            <Panel className="h-full transition hover:border-brand">
              <div className="font-medium">{p.title}</div>
              <div className="text-sm text-ink-3">{p.desc}</div>
            </Panel>
          </Link>
        ))}
      </div>
    </div>
  );
}
