/**
 * 切換正式 KYC 簽章者（規格 §16.6 P3-A5）
 *
 *   npm run cutover -- prepare            產生下一把簽章金鑰與 pairwise 金鑰（KEY_BACKEND=local 時寫入 .env.local 的 NEXT_*）
 *   npm run cutover -- plan               列出會重新簽發與需要重新驗證的帳戶（不送交易）
 *   npm run cutover -- execute            執行切換（每一步都可重跑，已完成的會略過）
 *        --skip-gate                      略過上線閘門（只允許連到本機 RPC 的演練）
 *
 * execute 的順序：
 *   1. 上線閘門（CAFECA_MODE=production 的條件）
 *   2. v2 setSigner(新, PRODUCTION)、v1 setKycSigner(新, true)
 *   3. 由真實流程核准（decidedBy = auto／reviewer）的自然人、經人工或工商憑證驗證的法人：以新簽章者重新簽發（nonce 遞增）
 *   4. 原型期放行的帳戶：標記需要重新驗證，v1 降為 L0
 *   5. v2 setSigner(舊, NONE)、v1 setKycSigner(舊, false) → 原型期證明在鏈上一律降為 L0
 *   6. .env.local：KYC_SIGNER_KEY、KYC_PAIRWISE_KEY 換成新值（舊檔備份為 .env.cutover-<時間>.local），之後重新啟動服務
 *
 * 治理權已移交多簽時，第 2、5 步會印出要由多簽送出的交易，送出後再重跑 execute。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const ENV_FILE = ".env.local";
const [cmd, ...flags] = process.argv.slice(2);

function loadEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const l of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
  for (const f of ["boltchain-testnet.local.json", "boltchain-testnet.json"]) {
    const p = path.join("deployments", f);
    if (existsSync(p) && !process.env.NEXT_PUBLIC_CAFECA_DEPLOYMENT) process.env.NEXT_PUBLIC_CAFECA_DEPLOYMENT = JSON.stringify(JSON.parse(readFileSync(p, "utf8")));
  }
}

function setEnvLines(changes: Record<string, string | null>) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const k = /^([A-Z0-9_]+)=/.exec(l)?.[1];
    if (k && k in changes) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (changes[k] !== null) out.push(`${k}=${changes[k]}`);
    } else out.push(l);
  }
  for (const [k, v] of Object.entries(changes)) if (!seen.has(k) && v !== null) out.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

loadEnv();
const { generatePrivateKey } = await import("viem/accounts");
const { randomBytes } = await import("crypto");

if (cmd === "prepare") {
  const nextBackend = process.env.KEY_BACKEND_NEXT ?? process.env.KEY_BACKEND ?? "local";
  const add: Record<string, string> = {};
  if (nextBackend === "pkcs11") {
    // 在 HSM 內產生下一把簽章金鑰與 pairwise 金鑰（不可匯出）；資料包簽章金鑰沒有就一併建立
    const { pkcs11Generate } = await import("../src/server/keys-pkcs11");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const want: [string, "secp256k1" | "hmac" | "p256", string][] = [
      ["PKCS11_NEXT_KYC_SIGNER_LABEL", "secp256k1", `cafeca-kyc-${stamp}`],
      ["PKCS11_NEXT_PAIRWISE_LABEL", "hmac", `cafeca-pairwise-${stamp}`],
      ["PKCS11_DISCLOSURE_LABEL", "p256", `cafeca-disclosure-${stamp}`],
    ];
    for (const [envName, kind, label] of want) {
      const l = process.env[envName] ?? label;
      const r = await pkcs11Generate(kind, l);
      console.log(`${r === "created" ? "✓ 已在 HSM 建立" : "· HSM 已有"} ${kind} 金鑰「${l}」`);
      if (!process.env[envName]) add[envName] = l;
    }
    if (process.env.KEY_BACKEND !== "pkcs11" && !process.env.KEY_BACKEND_NEXT) add.KEY_BACKEND_NEXT = "pkcs11";
  } else if (nextBackend === "local") {
    if (!process.env.NEXT_KYC_SIGNER_KEY) add.NEXT_KYC_SIGNER_KEY = generatePrivateKey();
    if (!process.env.NEXT_KYC_PAIRWISE_KEY) add.NEXT_KYC_PAIRWISE_KEY = randomBytes(32).toString("hex");
  } else {
    console.log(`KEY_BACKEND=${nextBackend}：請在該 KMS 建立下一把 secp256k1 簽章金鑰與 HMAC 金鑰，並設定 next 金鑰。`);
    process.exit(0);
  }
  if (Object.keys(add).length) setEnvLines(add);
  Object.assign(process.env, add);
  const { kycSigner } = await import("../src/server/keys");
  console.log("下一把 KYC 簽章者：", await kycSigner("next").address());
  console.log(Object.keys(add).length ? `已寫入 .env.local：${Object.keys(add).join("、")}` : "下一把金鑰已設定，未變更");
  process.exit(0);
}

if (cmd !== "plan" && cmd !== "execute") {
  console.log("用法：npm run cutover -- prepare | plan | execute [--skip-gate]");
  process.exit(1);
}

const { DEPLOYMENT, IdentityStatus } = await import("../src/lib/config");
const { attestationRegistryAbi, identityRegistryAbi } = await import("../src/lib/contracts/abis");
const { operatorTx, operatorWallet, publicClient } = await import("../src/server/chain");
const { kycSigner } = await import("../src/server/keys");
const { attestIdentity, identityState } = await import("../src/server/identity");
const { read, update } = await import("../src/server/store");
const { writeAudit } = await import("../src/server/audit");
const { launchGateProblems } = await import("../src/server/mode");
const { encodeFunctionData, getAddress, hexToString, zeroHash } = await import("viem");
type Address = `0x${string}`;

const reg = DEPLOYMENT.identityRegistry as Address | undefined;
if (!reg) throw new Error("IdentityRegistry v2 尚未部署");
const v1 = DEPLOYMENT.attestation as Address;
const cur = kycSigner("current");
const next = kycSigner("next");
const [oldAddr, newAddr] = [await cur.address(), await next.address()];
if (oldAddr.toLowerCase() === newAddr.toLowerCase()) throw new Error("新舊簽章者相同；請先執行 prepare");
const operator = operatorWallet().account!.address;
const who = `cutover:${operator}`;
console.log(`舊簽章者 ${oldAddr}\n新簽章者 ${newAddr}\n營運錢包 ${operator}`);

// ───────────────────────── 帳戶分類 ─────────────────────────
const s = await read();
type Item = { account: Address; kind: "person" | "entity"; why: string };
const reattest: Item[] = [];
const reverify: Item[] = [];
const decidedOf = (acct: string) => {
  const rec = Object.entries(s.kyc).find(([k]) => k.toLowerCase() === acct.toLowerCase())?.[1];
  return (rec?.cases ?? []).filter((c) => c.status === "approved").sort((a, b) => (b.processedAt ?? b.createdAt) - (a.processedAt ?? a.createdAt))[0]?.decidedBy;
};
const candidates: { account: Address; kind: "person" | "entity" }[] = [
  ...Object.keys(s.kyc).map((a) => ({ account: getAddress(a), kind: "person" as const })),
  ...Object.keys(s.entities ?? {}).map((a) => ({ account: getAddress(a), kind: "entity" as const })),
];
for (const c of candidates) {
  const st = await identityState(c.account);
  if (!st || st.status !== IdentityStatus.ACTIVE || st.level < 2) continue;
  if (st.signer.toLowerCase() === newAddr.toLowerCase()) continue; // 已重新簽發
  if (st.signer.toLowerCase() !== oldAddr.toLowerCase()) {
    reverify.push({ ...c, why: `簽章者 ${st.signer} 不是目前的簽章者` });
    continue;
  }
  if (c.kind === "person") {
    const d = decidedOf(c.account);
    if (d === "auto" || d === "reviewer") reattest.push({ ...c, why: `案件由 ${d === "auto" ? "自動驗證" : "人工複核"} 核准` });
    else reverify.push({ ...c, why: d === "prototype" ? "原型期放行（未經 OCR／活體／人臉比對）" : "找不到核准案件" });
  } else {
    const e = s.entities![c.account.toLowerCase()];
    const a = e?.application;
    const ok = a?.path === "moeaca" || (a?.path === "agent" && a.review?.decision === "approved") || (a?.path === "representative" && ["auto", "reviewer"].includes(decidedOf(a.applicant) ?? ""));
    if (ok) reattest.push({ ...c, why: `法人（${a!.path}）` });
    else reverify.push({ ...c, why: "代表人的實名是原型期放行" });
  }
}
console.log(`\n重新簽發（${reattest.length}）`);
for (const i of reattest) console.log(`  ${i.account} ${i.kind} · ${i.why}`);
console.log(`需要重新驗證（${reverify.length}）`);
for (const i of reverify) console.log(`  ${i.account} ${i.kind} · ${i.why}`);
if (cmd === "plan") process.exit(0);

// ───────────────────────── 執行 ─────────────────────────
const rpcLocal = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(process.env.RPC_URL ?? "");
if (flags.includes("--skip-gate")) {
  if (!rpcLocal) throw new Error("--skip-gate 只允許本機 RPC 演練");
  console.log("\n⚠ 略過上線閘門（本機演練）");
} else {
  const p = launchGateProblems();
  if (p.length) throw new Error("上線閘門未通過：\n  - " + p.join("\n  - "));
}
await writeAudit({ who, action: "signer.cutover.start", old: oldAddr, next: newAddr, reattest: reattest.length, reverify: reverify.length });

async function governed(address: Address, abi: readonly unknown[], functionName: string, args: unknown[], label: string) {
  const gov = (await publicClient.readContract({ address, abi: abi as never, functionName: "governance" })) as Address;
  if (gov.toLowerCase() !== operator.toLowerCase()) {
    const data = encodeFunctionData({ abi: abi as never, functionName, args } as never);
    console.log(`\n${label}：治理權在 ${gov}（多簽）。請建立提案、由成員簽署並執行後，再重跑 execute：\n  npm run multisig -- propose --to ${address} --data ${data} --note "${label}"`);
    process.exit(2);
  }
  const rc = await operatorTx({ address, abi, functionName, args } as never);
  console.log(`✓ ${label} ${rc.transactionHash}`);
  await writeAudit({ who, action: "signer.cutover.tx", step: label, tx: rc.transactionHash });
}

// 2) 登記新簽章者
if (Number(await publicClient.readContract({ address: reg, abi: identityRegistryAbi, functionName: "signerClass", args: [newAddr] })) !== 2)
  await governed(reg, identityRegistryAbi, "setSigner", [newAddr, 2], "v2 登記新簽章者（PRODUCTION）");
if (!(await publicClient.readContract({ address: v1, abi: attestationRegistryAbi, functionName: "isKycSigner", args: [newAddr] })))
  await governed(v1, attestationRegistryAbi, "setKycSigner", [newAddr, true], "v1 登記新簽章者");

// 3) 重新簽發
for (const i of reattest) {
  const r = await publicClient.readContract({ address: reg, abi: identityRegistryAbi, functionName: "statusOf", args: [i.account] });
  const jurisdiction = hexToString(r[6]).replace(/\0/g, "") || "TW";
  const out = await attestIdentity(i.account, { subjectType: r[0] as 0 | 1, level: r[1], expiry: Number(r[4]), claimsRoot: r[10], jurisdiction }, { signer: next });
  console.log(`✓ 重新簽發 ${i.account} nonce ${out.nonce}`);
  await writeAudit({ who, action: "signer.cutover.reattest", account: i.account, kind: i.kind, nonce: String(out.nonce), tx: out.v2Tx });
}

// 4) 需要重新驗證
const now = Date.now();
await update((st) => {
  for (const i of reverify) {
    if (i.kind !== "person") continue;
    const k = Object.keys(st.kyc).find((x) => x.toLowerCase() === i.account.toLowerCase());
    if (k) st.kyc[k].reverify ??= { at: now, reason: "prototype-signer-retired" };
  }
});
for (const i of reverify) {
  if (i.kind === "person") {
    const a = await publicClient.readContract({ address: v1, abi: attestationRegistryAbi, functionName: "attestations", args: [i.account] });
    if (a[0] > 0) {
      const digest = await publicClient.readContract({ address: v1, abi: attestationRegistryAbi, functionName: "attestationDigest", args: [i.account, 0, zeroHash, 0] });
      const sig = await next.signDigest(digest);
      await operatorTx({ address: v1, abi: attestationRegistryAbi, functionName: "attest", args: [i.account, 0, zeroHash, 0, sig] } as never);
    }
  }
  await writeAudit({ who, action: "signer.cutover.reverify", account: i.account, kind: i.kind, why: i.why });
}
console.log(`✓ 標記 ${reverify.length} 個帳戶需要重新驗證`);

// 5) 移除舊簽章者
if (Number(await publicClient.readContract({ address: reg, abi: identityRegistryAbi, functionName: "signerClass", args: [oldAddr] })) !== 0)
  await governed(reg, identityRegistryAbi, "setSigner", [oldAddr, 0], "v2 移除舊簽章者");
if (await publicClient.readContract({ address: v1, abi: attestationRegistryAbi, functionName: "isKycSigner", args: [oldAddr] }))
  await governed(v1, attestationRegistryAbi, "setKycSigner", [oldAddr, false], "v1 移除舊簽章者");

// 6) 換金鑰
const nextBackend = process.env.KEY_BACKEND_NEXT ?? process.env.KEY_BACKEND ?? "local";
const fileVal = (k: string) => readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
const backup = `.env.cutover-${new Date().toISOString().replace(/[:.]/g, "-")}.local`;
copyFileSync(ENV_FILE, backup);
if (nextBackend === "local") {
  const fileNextSigner = fileVal("NEXT_KYC_SIGNER_KEY");
  const fileNextPairwise = fileVal("NEXT_KYC_PAIRWISE_KEY");
  if (!fileNextSigner || !fileNextPairwise) throw new Error(".env.local 缺少 NEXT_KYC_SIGNER_KEY／NEXT_KYC_PAIRWISE_KEY");
  setEnvLines({ KYC_SIGNER_KEY: fileNextSigner, KYC_PAIRWISE_KEY: fileNextPairwise, NEXT_KYC_SIGNER_KEY: null, NEXT_KYC_PAIRWISE_KEY: null, RETIRED_KYC_SIGNER: oldAddr });
} else if (nextBackend === "pkcs11") {
  const signer = fileVal("PKCS11_NEXT_KYC_SIGNER_LABEL"), pairwise = fileVal("PKCS11_NEXT_PAIRWISE_LABEL");
  if (!signer || !pairwise) throw new Error(".env.local 缺少 PKCS11_NEXT_KYC_SIGNER_LABEL／PKCS11_NEXT_PAIRWISE_LABEL");
  // 金鑰全部改由 HSM 提供；.env.local 的明文金鑰移除（備份檔保留，確認後請安全刪除）
  setEnvLines({
    KEY_BACKEND: "pkcs11",
    KEY_BACKEND_NEXT: null,
    PKCS11_KYC_SIGNER_LABEL: signer,
    PKCS11_PAIRWISE_LABEL: pairwise,
    PKCS11_NEXT_KYC_SIGNER_LABEL: null,
    PKCS11_NEXT_PAIRWISE_LABEL: null,
    KYC_SIGNER_KEY: null,
    KYC_PAIRWISE_KEY: null,
    NEXT_KYC_SIGNER_KEY: null,
    NEXT_KYC_PAIRWISE_KEY: null,
    DISCLOSURE_SIGNING_KEY: fileVal("PKCS11_DISCLOSURE_LABEL") ? null : (fileVal("DISCLOSURE_SIGNING_KEY") ?? null),
    RETIRED_KYC_SIGNER: oldAddr,
  });
} else console.log(`KEY_BACKEND=${nextBackend}：請把 KMS 的 current 金鑰指向新的簽章金鑰與 HMAC 金鑰。`);
console.log(`✓ .env.local 已換成新的簽章金鑰與 pairwise 金鑰（${nextBackend}；舊檔備份在 ${backup}，確認切換成功後請安全刪除）`);
await writeAudit({ who, action: "signer.cutover.done", old: oldAddr, next: newAddr, pairwiseRotated: true });

const check = await identityState(reattest[0]?.account ?? (oldAddr as Address));
console.log(`\n完成。請重新啟動服務（pm2 restart cafeca）。${reattest[0] ? `抽查 ${reattest[0].account}：signerClass=${check?.signerClass}` : ""}`);
process.exit(0);
