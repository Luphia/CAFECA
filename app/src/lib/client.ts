"use client";

import { createPublicClient, http, sha256 as viemSha256, type Address, type Hex } from "viem";
import { p256 } from "@noble/curves/p256";
import { boltchain, DEPLOYMENT, Req } from "./config";
import { keyringValidatorAbi } from "./contracts/abis";
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
  idCommitment: Hex;
  provider: string;
  email: string | null;
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
  window.dispatchEvent(new Event("cafeca-wallet"));
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
    throw new Error("目前模式下不允許這個操作：可能超過額度，或需要先排程（新增金鑰、調升額度在標準模式需等待 24 小時）");
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

// ───────────────────────── Passkey 找回（由簽章還原公鑰） ─────────────────────────

/** 使用可探索的 passkey 簽一次，還原兩個可能公鑰，再比對鏈上金鑰 */
export async function recoverPasskeyForAccount(account: Address): Promise<PasskeyInfo | null> {
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
  for (const bit of [0, 1]) {
    try {
      const pt = new p256.Signature(r, s).addRecoveryBit(bit).recoverPublicKey(hash);
      const qx = ("0x" + pt.x.toString(16).padStart(64, "0")) as Hex;
      const qy = ("0x" + pt.y.toString(16).padStart(64, "0")) as Hex;
      const keyId = keyIdOf(qx, qy);
      const k = await publicClient.readContract({
        address: DEPLOYMENT.keyring,
        abi: keyringValidatorAbi,
        functionName: "getKey",
        args: [account, keyId],
      });
      if (k.keyClass === 1) {
        return {
          credentialId: b64urlEncode(new Uint8Array(cred.rawId)),
          qx,
          qy,
          keyId,
          rpIdHash: k.rpIdHash,
          backupEligible: (authData[32] & 0x08) !== 0,
          label: "此裝置",
        };
      }
    } catch {
      /* 試下一個 recovery bit */
    }
  }
  return null;
}
