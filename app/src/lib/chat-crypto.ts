"use client";

import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "./config";
import { deviceDirectoryAbi } from "./contracts/abis";
import { publicClient } from "./client";

/**
 * 聊天端對端加密（簡化版，MLS 之前的過渡方案）
 * - 每個瀏覽器一把 ECDH P-256 裝置金鑰（不可匯出，存 IndexedDB）
 * - 公鑰登記在鏈上 DeviceDirectory，deviceId = keccak256(公鑰)
 * - 每則訊息對「收件人每台裝置＋自己每台裝置」各加密一份（ECDH → AES-256-GCM）
 */

const DB = "cafeca-chat";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

type DeviceKey = { pair: CryptoKeyPair; pub: Hex; deviceId: Hex };

export async function getDeviceKey(): Promise<DeviceKey | undefined> {
  return idb<DeviceKey | undefined>("readonly", (s) => s.get("device"));
}

export async function ensureDeviceKey(): Promise<DeviceKey> {
  const existing = await getDeviceKey();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const pub = bytesToHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const rec = { pair, pub, deviceId: keccak256(pub) };
  await idb("readwrite", (s) => s.put(rec, "device"));
  return rec;
}

export type Device = { deviceId: Hex; pub: Hex; active: boolean };

export async function devicesOf(account: Address): Promise<Device[]> {
  const ids = await publicClient.readContract({
    address: DEPLOYMENT.deviceDirectory,
    abi: deviceDirectoryAbi,
    functionName: "deviceIdsOf",
    args: [account],
  });
  const out: Device[] = [];
  for (const id of ids) {
    const d = await publicClient.readContract({
      address: DEPLOYMENT.deviceDirectory,
      abi: deviceDirectoryAbi,
      functionName: "deviceOf",
      args: [account, id],
    });
    if (d.active && d.credential.length === 132) out.push({ deviceId: id, pub: d.credential, active: d.active });
  }
  return out;
}

async function aesKey(myPriv: CryptoKey, theirPub: Hex): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey("raw", hexToBytes(theirPub) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return crypto.subtle.deriveKey({ name: "ECDH", public: pub }, myPriv, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptFor(devices: Device[], payload: unknown): Promise<Record<string, { iv: string; ct: string }>> {
  const me = await ensureDeviceKey();
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const out: Record<string, { iv: string; ct: string }> = {};
  for (const d of devices) {
    const key = await aesKey(me.pair.privateKey, d.pub);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
    out[d.deviceId] = { iv: bytesToHex(iv), ct: bytesToHex(ct) };
  }
  return out;
}

const senderCache = new Map<string, Hex>();

export async function decryptEnvelope(
  from: Address,
  fromDevice: Hex,
  envelopes: Record<string, { iv: string; ct: string }>,
): Promise<unknown | null> {
  const me = await getDeviceKey();
  if (!me) return null;
  const env = envelopes[me.deviceId];
  if (!env) return null;
  const cacheKey = `${from}:${fromDevice}`;
  let senderPub = senderCache.get(cacheKey);
  if (!senderPub) {
    const d = await publicClient.readContract({
      address: DEPLOYMENT.deviceDirectory,
      abi: deviceDirectoryAbi,
      functionName: "deviceOf",
      args: [from, fromDevice],
    });
    senderPub = d.credential as Hex;
    senderCache.set(cacheKey, senderPub);
  }
  try {
    const key = await aesKey(me.pair.privateKey, senderPub);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: hexToBytes(env.iv as Hex) as BufferSource },
      key,
      hexToBytes(env.ct as Hex) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}
