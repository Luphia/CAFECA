"use client";

import { useSyncExternalStore } from "react";
import type { Address } from "viem";
import { forgetSignIn, listSignIns, subscribeSignIns, type SignInRecord } from "@/lib/signin-history";
import { Panel } from "./ui";

const EMPTY: SignInRecord[] = [];
let cache: { key: string; raw: string; list: SignInRecord[] } | null = null;

function useSignIns(account: Address): SignInRecord[] {
  return useSyncExternalStore(
    subscribeSignIns,
    () => {
      const list = listSignIns(account);
      const raw = JSON.stringify(list);
      if (!cache || cache.key !== account || cache.raw !== raw) cache = { key: account, raw, list };
      return cache.list;
    },
    () => EMPTY,
  );
}

const CLAIM_LABEL: Record<string, string> = { kyc_level: "實名等級", handle: "代稱" };

/** 曾以 CAFECA 身分登入的網站（只記在這台裝置；每次登入都要重新簽署，沒有長期授權可以撤銷） */
export function SignInHistory({ account }: { account: Address }) {
  const list = useSignIns(account);
  return (
    <Panel title="以 CAFECA 登入的網站">
      {list.length === 0 ? (
        <p className="text-sm text-ink-3">還沒有用 CAFECA 身分登入過其他網站。</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="signin-history">
          {list.map((r) => (
            <li key={r.domain} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm">{new URL(r.domain).host}</div>
                <div className="text-xs text-ink-3">
                  {r.name ? `${r.name} · ` : ""}
                  {r.count} 次 · 最近 {new Date(r.lastAt).toLocaleString("zh-TW")}
                  {r.claims ? ` · 提供${r.claims.split(",").map((c) => CLAIM_LABEL[c] ?? c).join("、")}` : ""}
                </div>
              </div>
              <button className="shrink-0 text-xs text-ink-3 hover:text-danger" onClick={() => forgetSignIn(account, r.domain)}>
                移除紀錄
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-ink-3">
        網站只拿到一次性的登入簽章，無法代替你轉帳或授權。紀錄只存在這台裝置，移除後再次登入會重新顯示「第一次連線」提醒；要停止使用某個網站，請在該網站登出或刪除帳號。
      </p>
    </Panel>
  );
}
