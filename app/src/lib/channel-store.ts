import type { Address } from "viem";
import { DEPLOYMENT } from "./config";
import { deriveChannelKey, exportPub, generateChannelKey, randomId, type GuardContext } from "./channel";
import { CHAIN_ID } from "./config";

/**
 * 錢包端的簽章通道紀錄（只存在這台裝置）。
 * 錢包通道私鑰只用來解密網站的請求，不能簽署任何東西；簽署一律要使用者以 Passkey／實體卡確認。
 * （原型以 JWK 存在 localStorage；正式版改為 IndexedDB 內不可匯出的 CryptoKey。）
 */
export type ChannelRecord = {
  id: string;
  account: Address;
  domain: string;
  name?: string;
  sitePub: string;
  walletPub: string;
  walletPriv: JsonWebKey;
  createdAt: number;
  expiresAt: number; // Unix 秒
  seen: string[];
  count: number;
};

const KEY = (a: Address) => `cafeca.channels.v1.${a.toLowerCase()}`;
const EVT = "cafeca-channels";

export function listChannels(account: Address, includeExpired = false): ChannelRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(account)) ?? "[]") as ChannelRecord[];
    const now = Date.now() / 1000;
    return (Array.isArray(v) ? v : []).filter((c) => includeExpired || c.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function save(account: Address, list: ChannelRecord[]) {
  const now = Date.now() / 1000;
  localStorage.setItem(KEY(account), JSON.stringify(list.filter((c) => c.expiresAt > now).slice(0, 50)));
  window.dispatchEvent(new Event(EVT));
}

export function getChannel(account: Address, id: string): ChannelRecord | undefined {
  return listChannels(account).find((c) => c.id === id);
}

/** 登入時建立：產生錢包端 ECDH 金鑰與通道 id（通道要等登入簽章送出後才生效） */
export async function newChannel(account: Address, domain: string, sitePub: string, ttl: number, issuedAt: number, name?: string) {
  const kp = await generateChannelKey(true);
  const rec: ChannelRecord = {
    id: randomId(16),
    account,
    domain,
    name,
    sitePub,
    walletPub: await exportPub(kp.publicKey),
    walletPriv: await crypto.subtle.exportKey("jwk", kp.privateKey),
    createdAt: Date.now(),
    expiresAt: issuedAt + ttl,
    seen: [],
    count: 0,
  };
  return rec;
}

export function storeChannel(rec: ChannelRecord) {
  save(rec.account, [rec, ...listChannels(rec.account).filter((c) => c.id !== rec.id)]);
}

export function markSeen(account: Address, id: string, reqId: string) {
  const list = listChannels(account);
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.seen = [reqId, ...c.seen.filter((s) => s !== reqId)].slice(0, 100);
  c.count += 1;
  save(account, list);
}

export async function closeChannel(account: Address, id: string) {
  save(account, listChannels(account, true).filter((c) => c.id !== id));
  await fetch("/api/channel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "close", ch: id }) }).catch(() => undefined);
}

export async function channelKey(rec: ChannelRecord): Promise<CryptoKey> {
  const priv = await crypto.subtle.importKey("jwk", rec.walletPriv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return deriveChannelKey(priv, rec.sitePub, rec.id);
}

export function subscribeChannels(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** 錢包防護用：使用者帳戶與所有 CAFECA 系統合約（TWDC 不在其中，授權 TWDC 會顯示警示而不是封鎖） */
export function guardContext(account: Address): GuardContext {
  const d = DEPLOYMENT;
  return {
    account,
    chainId: CHAIN_ID,
    protectedContracts: [d.entryPoint, d.accountImpl, d.factory, d.keyring, d.recovery, d.channelValidator, d.channelManager, d.attestation, d.deviceDirectory, d.paymaster].filter(Boolean),
  };
}
