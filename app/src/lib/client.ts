"use client";

import { createPublicClient, http, parseAbiItem, sha256 as viemSha256, type Address, type Hex } from "viem";
import { p256 } from "@noble/curves/p256";
import { boltchain, DEPLOYMENT, Req } from "./config";
import { identityAccountFactoryAbi, keyringValidatorAbi } from "./contracts/abis";
import { encodeKeyringSignature, encodeSummaries, type TxSummary, type UserOp, type WebAuthnSig } from "./userop";
import { keyIdOf, signWithPasskey, type PasskeyInfo } from "./webauthn";

export const publicClient = createPublicClient({ chain: boltchain, transport: http("/api/rpc") });

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

// ───────────────────────── 本機錢包資料 ─────────────────────────

export type LocalWallet = {
  address: Address;
  passkeys: PasskeyInfo[];
  deviceId?: Hex;
  kycLeaves?: { field: string; value: string; salt: Hex; hash: Hex }[];
  createdAt: number;
};

const KEY = "cafeca.wallet.v1";

export function loadWallet(): LocalWallet | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LocalWallet) : null;
  } catch {
    return null;
  }
}

export function saveWallet(w: LocalWallet) {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* 無痕模式等 */
  }
  rememberIdentity(w.address);
  window.dispatchEvent(new Event("cafeca-wallet"));
}

/** 此瀏覽器曾使用過的身分（登出後保留，用來決定首頁預設顯示「登入」或「建立」） */
const KNOWN = "cafeca.known.v1";

export function rememberIdentity(address: Address) {
  try {
    const list = JSON.parse(localStorage.getItem(KNOWN) ?? "[]") as string[];
    if (!list.includes(address)) localStorage.setItem(KNOWN, JSON.stringify([address, ...list].slice(0, 5)));
  } catch {
    /* ignore */
  }
}

export function knownIdentities(): Address[] {
  try {
    return JSON.parse(localStorage.getItem(KNOWN) ?? "[]") as Address[];
  } catch {
    return [];
  }
}

export function clearWallet() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("cafeca-wallet"));
}

// ───────────────────────── UserOp 送出 ─────────────────────────

export type Signer = (userOpHash: Hex, userOp: UserOp) => Promise<Hex>;

export type OpResult = { txHash: Hex; success: boolean; reason?: string };

export async function submitOp(p: {
  sender: Address;
  validator: Address;
  callData: Hex;
  initCode?: Hex;
  signer: Signer;
}): Promise<OpResult> {
  const { userOp, userOpHash } = await api<{ userOp: UserOp; userOpHash: Hex }>("/api/bundler/prepare", {
    sender: p.sender,
    validator: p.validator,
    callData: p.callData,
    initCode: p.initCode,
  });
  userOp.signature = await p.signer(userOpHash, userOp);
  const res = await api<OpResult>("/api/bundler/send", { userOp });
  if (!res.success) throw new Error(`交易已上鏈但執行失敗：${res.reason ?? "未知原因"}`);
  return res;
}

export function passkeySigner(keys: PasskeyInfo[]): Signer {
  return async (hash) => {
    const { keyId, sig } = await signWithPasskey(hash, keys);
    return encodeKeyringSignature(keyId, sig);
  };
}

export type Preview = { req: number; frozenOk: boolean; summaries: TxSummary[]; ctxd: Hex };

export async function preview(account: Address, callData: Hex): Promise<Preview> {
  const [req, frozenOk, summaries, ctxd] = await publicClient.readContract({
    address: DEPLOYMENT.keyring,
    abi: keyringValidatorAbi,
    functionName: "previewAssessment",
    args: [account, callData],
  });
  return { req, frozenOk, summaries: summaries as TxSummary[], ctxd };
}

/** 卡片自己由顯示內容計算 ctxd（不信任 App 或 RPC 給的值） */
export function ctxdOf(summaries: readonly TxSummary[]): Hex {
  return viemSha256(encodeSummaries(summaries));
}

export type CardConfirm = (req: { summaries: TxSummary[]; challenge: Hex; title?: string }) => Promise<{
  keyId: Hex;
  sig: WebAuthnSig;
}>;

/**
 * 依權限矩陣自動選擇簽署方式：DAILY → 手機 passkey；MASTER → 卡片（螢幕確認）
 */
export async function smartSigner(
  account: Address,
  callData: Hex,
  keys: PasskeyInfo[],
  confirmOnCard: CardConfirm,
): Promise<{ signer: Signer; needs: "passkey" | "card" }> {
  const pv = await preview(account, callData);
  if (pv.req === Req.REJECT) {
    throw new Error("目前不允許這個操作：可能超過額度（額度只能由 CAFECA 調整），或需要實體卡本身確認");
  }
  if (pv.req === Req.MASTER) {
    return {
      needs: "card",
      signer: async (hash) => {
        const { keyId, sig } = await confirmOnCard({ summaries: pv.summaries, challenge: hash });
        return encodeKeyringSignature(keyId, sig);
      },
    };
  }
  return { needs: "passkey", signer: passkeySigner(keys) };
}

/** 指定由卡片簽署（例如新裝置上還沒有任何已註冊的 passkey，只能用卡片把自己加入） */
export async function cardSigner(account: Address, callData: Hex, confirmOnCard: CardConfirm): Promise<Signer> {
  const pv = await preview(account, callData);
  if (pv.req === Req.REJECT) throw new Error("這個操作目前不被允許");
  return async (hash) => {
    const { keyId, sig } = await confirmOnCard({ summaries: pv.summaries, challenge: hash });
    return encodeKeyringSignature(keyId, sig);
  };
}

// ───────────────────────── 以此裝置既有的 Passkey 登入 ─────────────────────────

/**
 * 使用可探索的 passkey 簽一次：
 * 1. userHandle 若是 20 bytes，即為身分帳戶地址（之後新增的裝置金鑰）
 * 2. 否則為身分根金鑰：由簽章還原兩個可能公鑰，地址 = factory.getAddress(公鑰)
 * 最後以鏈上 getKey 確認這把金鑰確實屬於該帳戶。
 */
export async function loginWithDevicePasskey(): Promise<{ address: Address; passkey: PasskeyInfo } | null> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.get({
    publicKey: { challenge, rpId: window.location.hostname, userVerification: "required" },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const res = cred.response as AuthenticatorAssertionResponse;
  const { parseDerSignature, sha256, b64urlEncode } = await import("./webauthn");
  const authData = new Uint8Array(res.authenticatorData);
  const msg = new Uint8Array([...authData, ...(await sha256(new Uint8Array(res.clientDataJSON)))]);
  const hash = await sha256(msg);
  const { r, s } = parseDerSignature(new Uint8Array(res.signature));
  const handle = res.userHandle ? new Uint8Array(res.userHandle) : null;
  const handleAddress = handle && handle.length === 20 ? (("0x" + Array.from(handle, (b) => b.toString(16).padStart(2, "0")).join("")) as Address) : null;

  for (const bit of [0, 1]) {
    let qx: Hex, qy: Hex;
    try {
      const pt = new p256.Signature(r, s).addRecoveryBit(bit).recoverPublicKey(hash);
      qx = ("0x" + pt.x.toString(16).padStart(64, "0")) as Hex;
      qy = ("0x" + pt.y.toString(16).padStart(64, "0")) as Hex;
    } catch {
      continue;
    }
    const keyId = keyIdOf(qx, qy);
    const candidates: Address[] = handleAddress
      ? [handleAddress]
      : [
          await publicClient.readContract({ address: DEPLOYMENT.factory, abi: identityAccountFactoryAbi, functionName: "getAddress", args: [qx, qy] }),
          // 以 QR 配對加入的裝置：建立金鑰時還不知道身分地址，改由鏈上 KeyAdded 事件（keyId 為索引）反查
          ...(await accountsOfKey(keyId)),
        ];
    for (const address of candidates) {
      const k = await publicClient
        .readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "getKey", args: [address, keyId] })
        .catch(() => null);
      if (k && k.keyClass === 1) {
        return {
          address,
          passkey: {
            credentialId: b64urlEncode(new Uint8Array(cred.rawId)),
            qx,
            qy,
            keyId,
            rpIdHash: k.rpIdHash,
            backupEligible: (authData[32] & 0x08) !== 0,
            label: "此裝置",
          },
        };
      }
    }
  }
  return null;
}

/** 由鏈上 KeyAdded 事件找出曾加入這把金鑰的帳戶（呼叫端仍須以 getKey 確認目前有效） */
export async function accountsOfKey(keyId: Hex): Promise<Address[]> {
  const ev = parseAbiItem("event KeyAdded(address indexed account, bytes32 indexed keyId, uint8 keyClass)");
  const logs = await publicClient
    .getLogs({ address: DEPLOYMENT.keyring, event: ev, args: { keyId }, fromBlock: BigInt(DEPLOYMENT.startBlock) })
    .catch(() => []);
  return [...new Set(logs.map((l) => l.args.account!))];
}
