"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { adminCall, newStaffPasskey } from "@/components/admin-login";
import { Button, Notice, Panel, Spinner, errMsg } from "@/components/ui";

/** 受邀人員加入：在自己的裝置建立管理後台 Passkey */
export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <Join />
    </Suspense>
  );
}

function Join() {
  const code = useSearchParams().get("code") ?? "";
  const router = useRouter();
  const [inv, setInv] = useState<{ name: string; roles: string[]; addKey: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    adminCall<{ name: string; roles: string[]; addKey: boolean }>(`/api/admin/staff/join?code=${encodeURIComponent(code)}`).then(setInv, (e) => setErr(errMsg(e)));
  }, [code]);
  return (
    <div className="mx-auto max-w-sm space-y-4 px-5 py-16">
      <h1 className="text-2xl font-bold">加入 CAFECA 管理後台</h1>
      <Panel>
        {err ? (
          <Notice tone="danger">{err}</Notice>
        ) : !inv ? (
          <Spinner className="text-brand" />
        ) : (
          <div className="space-y-3" data-testid="join-invite">
            <p className="text-sm">
              {inv.name}，你受邀{inv.addKey ? "為既有帳號新增一把 Passkey" : `加入管理後台（角色：${inv.roles.join("、")}）`}。請在這台裝置建立 Passkey，之後以它登入。
            </p>
            <Button
              className="w-full"
              busy={busy}
              testId="join-submit"
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await adminCall("/api/admin/staff/join", { code, passkey: await newStaffPasskey(inv.name) });
                  router.push("/admin");
                } catch (e) {
                  setErr(errMsg(e));
                  setBusy(false);
                }
              }}
            >
              建立 Passkey 並加入
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
