import "server-only";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { hashMessage, type Address, type Hex } from "viem";
import { writeAudit } from "./audit";
import { publicClient } from "./chain";
import { HttpError } from "./session";
import { read, update } from "./store";

/**
 * 服務條款與隱私權告知的同意紀錄（規格 §16.6 P3-B2）
 *
 * 條款內容放在 content/terms/<版本>/{terms,privacy}.md；TERMS_VERSION 指定目前版本（預設為草案版本）。
 * 使用者以 Passkey 簽署「版本＋內容雜湊＋帳戶」的訊息（ERC-1271 驗證），簽章與時間存證並寫入稽核紀錄。
 * 版本變更後，所有人都要重新同意才能繼續使用；實名驗證送件也要求已同意目前版本。
 */

export const termsVersion = () => process.env.TERMS_VERSION ?? "draft-2026-09";
const dir = (v: string) => path.join(/*turbopackIgnore: true*/ process.cwd(), "content", "terms", v);

export async function termsDocs(v = termsVersion()) {
  if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new Error("TERMS_VERSION 格式錯誤");
  const [terms, privacy] = await Promise.all([fs.readFile(path.join(dir(v), "terms.md"), "utf8"), fs.readFile(path.join(dir(v), "privacy.md"), "utf8")]);
  const hash = createHash("sha256").update(terms).update("\n\u0000\n").update(privacy).digest("hex");
  return { version: v, hash, terms, privacy, draft: v.startsWith("draft") };
}

export function termsMessage(account: Address, version: string, hash: string) {
  return ["CAFECA 服務條款與隱私權告知", `版本：${version}`, `內容雜湊：${hash}`, `帳戶：${account}`, "我已閱讀並同意"].join("\n");
}

const ERC1271 = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] }] as const;

export async function termsStatus(me: Address) {
  const d = await termsDocs();
  const list = (await read()).termsConsents?.[me.toLowerCase()] ?? [];
  const cur = list.find((c) => c.version === d.version && c.hash === d.hash);
  return { version: d.version, hash: d.hash, draft: d.draft, accepted: !!cur, acceptedAt: cur?.at ?? null, message: termsMessage(me, d.version, d.hash), history: list.map((c) => ({ version: c.version, at: c.at })) };
}

export async function acceptTerms(me: Address, version: string, signature: Hex) {
  const d = await termsDocs();
  if (version !== d.version) throw new HttpError(409, "條款已更新，請重新閱讀");
  const magic = await publicClient.readContract({ address: me, abi: ERC1271, functionName: "isValidSignature", args: [hashMessage(termsMessage(me, d.version, d.hash)), signature] }).catch(() => "0x");
  if (magic !== "0x1626ba7e") throw new HttpError(400, "Passkey 簽章驗證失敗");
  await update((s) => {
    s.termsConsents ??= {};
    const k = me.toLowerCase();
    s.termsConsents[k] = [...(s.termsConsents[k] ?? []).filter((c) => !(c.version === d.version && c.hash === d.hash)), { version: d.version, hash: d.hash, at: Date.now(), signature }];
  });
  await writeAudit({ who: `user:${me}`, action: "terms.accept", version: d.version, contentHash: d.hash });
}

export async function requireTerms(me: Address) {
  if (!(await termsStatus(me)).accepted) throw new HttpError(428, "請先閱讀並同意最新的服務條款與隱私權告知");
}

export async function termsStats() {
  const d = await termsDocs();
  const s = await read();
  const all = Object.values(s.termsConsents ?? {});
  return { version: d.version, hash: d.hash, draft: d.draft, accepted: all.filter((l) => l.some((c) => c.version === d.version && c.hash === d.hash)).length, everAccepted: all.length };
}
