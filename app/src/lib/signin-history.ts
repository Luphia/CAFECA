import type { Address } from "viem";

/**
 * 第三方登入紀錄（只存在這台裝置）：用來標示「第一次連線」以及在安全性頁列出曾登入過的網站。
 * 不是授權清單——每次登入都要重新簽署，刪除紀錄只是讓下次再次顯示「第一次連線」提醒。
 */
export type SignInRecord = { domain: string; name?: string; claims: string; firstAt: number; lastAt: number; count: number };

const KEY = (a: Address) => `cafeca.signins.v1.${a.toLowerCase()}`;
const EVT = "cafeca-signins";

export function listSignIns(account: Address): SignInRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(account)) ?? "[]") as SignInRecord[];
    return Array.isArray(v) ? v.sort((a, b) => b.lastAt - a.lastAt) : [];
  } catch {
    return [];
  }
}

function save(account: Address, list: SignInRecord[]) {
  try {
    localStorage.setItem(KEY(account), JSON.stringify(list.slice(0, 100)));
    window.dispatchEvent(new Event(EVT));
  } catch {
    /* 私密模式等情況：略過 */
  }
}

export function findSignIn(account: Address, domain: string): SignInRecord | undefined {
  return listSignIns(account).find((r) => r.domain === domain);
}

export function recordSignIn(account: Address, domain: string, claims: string, name?: string) {
  const list = listSignIns(account);
  const now = Date.now();
  const r = list.find((x) => x.domain === domain);
  if (r) Object.assign(r, { lastAt: now, count: r.count + 1, claims, name: name ?? r.name });
  else list.push({ domain, name, claims, firstAt: now, lastAt: now, count: 1 });
  save(account, list);
}

export function forgetSignIn(account: Address, domain: string) {
  save(account, listSignIns(account).filter((r) => r.domain !== domain));
}

export function subscribeSignIns(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
}
