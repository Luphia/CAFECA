/**
 * 治理權移交多簽（規格 §16.6 P3-A2）
 *
 *   npm run multisig -- deploy --owners 0xA,0xB,0xC --threshold 2
 *       部署 CafecaMultisig（成員是各自保管的 EOA，例如硬體錢包），寫入部署檔的 multisig
 *   npm run multisig -- handover [--limits]
 *       部署者把 IdentityRegistry 治理權（兩段式）與 AuditAnchor 管理權交給多簽，並產生「多簽接受治理權」的提案檔
 *       --limits 另把 KeyringValidator／MemberValidator 的額度管理權交給多簽（之後 /admin/limits 無法直接調整，見 README）
 *   npm run multisig -- propose --to <合約> --data <calldata> [--value <wei>] [--note 說明] [--out 檔案]
 *   MULTISIG_SIGNER_KEY=0x… npm run multisig -- sign <提案檔>      成員在自己的裝置簽署（personal_sign）
 *   npm run multisig -- execute <提案檔>                            簽章數達門檻後由營運錢包代送
 *   npm run multisig -- status
 *
 * 提案檔是一般 JSON，可以用任何管道傳給各成員；檔案裡只有公開資料與簽章，沒有私鑰。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, isAddress, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ENV_FILE = ".env.local";
const env: Record<string, string> = {};
if (existsSync(ENV_FILE))
  for (const l of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
Object.assign(env, Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>);

const DEP_FILE = ["deployments/boltchain-testnet.local.json", "deployments/boltchain-testnet.json"].find((f) => existsSync(f))!;
const dep = JSON.parse(readFileSync(DEP_FILE, "utf8"));
const art = (n: string) => JSON.parse(readFileSync(path.join("scripts", "artifacts", `${n}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
const MS = art("CafecaMultisig").abi;
const chain = defineChain({ id: dep.chainId, name: "boltchain", nativeCurrency: { name: "BOLT", symbol: "BOLT", decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(env.RPC_URL) });
const operator = () => createWalletClient({ chain, account: privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex), transport: http(env.RPC_URL) });

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k: string) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

type Proposal = { chainId: number; multisig: Address; to: Address; value: string; data: Hex; nonce: string; txHash: Hex; note: string; createdAt: string; sigs: { signer: Address; sig: Hex }[] };

async function send(address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const w = operator();
  const hash = await w.writeContract({ address, abi, functionName, args } as never);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`交易失敗 ${hash}`);
  console.log(`✓ ${functionName} ${hash}`);
  return rc;
}

async function propose(to: Address, data: Hex, value = 0n, note = "", out?: string, nonceOffset = 0n): Promise<string> {
  if (!dep.multisig) throw new Error("尚未部署多簽（npm run multisig -- deploy）");
  const nonce = ((await pub.readContract({ address: dep.multisig, abi: MS, functionName: "nonce" })) as bigint) + nonceOffset;
  const txHash = (await pub.readContract({ address: dep.multisig, abi: MS, functionName: "txHash", args: [to, value, data, nonce] })) as Hex;
  const p: Proposal = { chainId: dep.chainId, multisig: dep.multisig, to, value: value.toString(), data, nonce: nonce.toString(), txHash, note, createdAt: new Date().toISOString(), sigs: [] };
  const file = out ?? path.join("data", "multisig", `proposal-${nonce}-${Date.now()}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
  console.log(`提案 #${nonce}：${note || to}\n  檔案 ${file}\n  待簽 ${txHash}`);
  return file;
}

if (cmd === "deploy") {
  const owners = (flag("owners") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const threshold = BigInt(flag("threshold") ?? "0");
  if (owners.length < 2 || !owners.every((o) => isAddress(o))) throw new Error("--owners 需要至少兩個位址（逗號分隔）");
  if (threshold < 2n || threshold > BigInt(owners.length)) throw new Error("--threshold 必須介於 2 與成員數之間");
  if (dep.multisig && !rest.includes("--force")) throw new Error(`已經部署過多簽（${dep.multisig}）；要重新部署請加 --force`);
  const a = art("CafecaMultisig");
  const w = operator();
  const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args: [owners.map((o) => getAddress(o)), threshold] } as never);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (!rc.contractAddress) throw new Error("部署失敗");
  dep.multisig = getAddress(rc.contractAddress);
  writeFileSync(DEP_FILE, JSON.stringify(dep, null, 2) + "\n");
  console.log(`✓ CafecaMultisig ${dep.multisig}（${threshold}-of-${owners.length}），已寫入 ${DEP_FILE}`);
} else if (cmd === "handover") {
  if (!dep.multisig) throw new Error("尚未部署多簽");
  const me = operator().account.address;
  const RA = art("IdentityRegistry").abi;
  const gov = (await pub.readContract({ address: dep.identityRegistry, abi: RA, functionName: "governance" })) as Address;
  let offset = 0n;
  if (gov.toLowerCase() === dep.multisig.toLowerCase()) console.log("IdentityRegistry 治理權已在多簽");
  else {
    if (gov.toLowerCase() !== me.toLowerCase()) throw new Error(`IdentityRegistry 治理權在 ${gov}，不是部署者`);
    const pending = (await pub.readContract({ address: dep.identityRegistry, abi: RA, functionName: "pendingGovernance" })) as Address;
    if (pending.toLowerCase() !== dep.multisig.toLowerCase()) await send(dep.identityRegistry, RA, "transferGovernance", [dep.multisig]);
    await propose(dep.identityRegistry, encodeFunctionData({ abi: RA, functionName: "acceptGovernance" }), 0n, "多簽接受 IdentityRegistry 治理權", flag("out"), offset++);
  }
  if (dep.auditAnchor) {
    const AA = art("AuditAnchor").abi;
    const owner = (await pub.readContract({ address: dep.auditAnchor, abi: AA, functionName: "owner" })) as Address;
    if (owner.toLowerCase() === me.toLowerCase()) await send(dep.auditAnchor, AA, "transferOwner", [dep.multisig]);
    else console.log(`AuditAnchor 管理權在 ${owner}`);
    console.log("  （營運錢包仍是 anchorer，每日上鏈照常；新增或移除 anchorer 需要多簽）");
  }
  if (rest.includes("--limits")) {
    for (const [name, addr] of [["KeyringValidator", dep.keyring], ["MemberValidator", dep.memberValidator]] as const) {
      if (!addr) continue;
      const A = art(name).abi;
      const cur = (await pub.readContract({ address: addr, abi: A, functionName: "limitAdmin" }).catch(() => null)) as Address | null;
      if (!cur) {
        console.log(`${name} 沒有 limitAdmin（v1），略過`);
        continue;
      }
      if (cur.toLowerCase() !== me.toLowerCase()) {
        console.log(`${name} 額度管理權在 ${cur}`);
        continue;
      }
      await send(addr, A, "transferLimitAdmin", [dep.multisig]);
      await propose(addr, encodeFunctionData({ abi: A, functionName: "acceptLimitAdmin" }), 0n, `多簽接受 ${name} 額度管理權`, undefined, offset++);
    }
  }
  console.log("\n請把提案檔交給成員簽署（sign），達門檻後 execute。提案必須依 nonce 順序執行。");
} else if (cmd === "propose") {
  const to = flag("to"), data = flag("data") as Hex | undefined;
  if (!to || !isAddress(to) || !data?.startsWith("0x")) throw new Error("需要 --to <位址> --data <0x…>");
  await propose(getAddress(to), data, BigInt(flag("value") ?? "0"), flag("note") ?? "", flag("out"));
} else if (cmd === "sign") {
  const file = rest[0];
  const p = JSON.parse(readFileSync(file, "utf8")) as Proposal;
  const key = env.MULTISIG_SIGNER_KEY as Hex | undefined;
  if (!key) throw new Error("請以 MULTISIG_SIGNER_KEY 提供你的成員私鑰（只在你的裝置上使用）");
  const acct = privateKeyToAccount(key);
  const again = (await pub.readContract({ address: p.multisig, abi: MS, functionName: "txHash", args: [p.to, BigInt(p.value), p.data, BigInt(p.nonce)] })) as Hex;
  if (again !== p.txHash) throw new Error("提案內容與待簽雜湊不符，拒絕簽署");
  if (!(await pub.readContract({ address: p.multisig, abi: MS, functionName: "isOwner", args: [acct.address] }))) throw new Error(`${acct.address} 不是多簽成員`);
  console.log(`簽署提案 #${p.nonce}：${p.note}\n  to ${p.to}\n  data ${p.data.slice(0, 74)}${p.data.length > 74 ? "…" : ""}`);
  const sig = await acct.signMessage({ message: { raw: p.txHash } });
  p.sigs = [...p.sigs.filter((s) => s.signer.toLowerCase() !== acct.address.toLowerCase()), { signer: acct.address, sig }];
  writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
  const t = await pub.readContract({ address: p.multisig, abi: MS, functionName: "threshold" });
  console.log(`✓ ${acct.address} 已簽署（${p.sigs.length}／${t}）`);
} else if (cmd === "execute") {
  const file = rest[0];
  const p = JSON.parse(readFileSync(file, "utf8")) as Proposal;
  const nonce = (await pub.readContract({ address: p.multisig, abi: MS, functionName: "nonce" })) as bigint;
  if (nonce.toString() !== p.nonce) throw new Error(`多簽目前 nonce 是 ${nonce}，這份提案是 #${p.nonce}（請依順序執行，或重新提案）`);
  const sigs = [...p.sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1)).map((s) => s.sig);
  const rc = await send(p.multisig, MS, "execute", [p.to, BigInt(p.value), p.data, sigs]);
  writeFileSync(file, JSON.stringify({ ...p, executedTx: rc.transactionHash }, null, 2) + "\n");
} else if (cmd === "status") {
  if (!dep.multisig) {
    console.log("尚未部署多簽");
    process.exit(0);
  }
  const [owners, threshold, nonce] = await Promise.all(["owners", "threshold", "nonce"].map((f) => pub.readContract({ address: dep.multisig, abi: MS, functionName: f })));
  console.log(`多簽 ${dep.multisig}：${threshold}-of-${(owners as Address[]).length}，nonce ${nonce}\n  成員 ${(owners as Address[]).join(", ")}`);
  const gov = await pub.readContract({ address: dep.identityRegistry, abi: art("IdentityRegistry").abi, functionName: "governance" });
  console.log(`  IdentityRegistry 治理權 ${gov}${String(gov).toLowerCase() === dep.multisig.toLowerCase() ? "（多簽）" : ""}`);
  if (dep.auditAnchor) console.log(`  AuditAnchor 管理權 ${await pub.readContract({ address: dep.auditAnchor, abi: art("AuditAnchor").abi, functionName: "owner" })}`);
} else {
  console.log("用法：npm run multisig -- deploy | handover [--limits] | propose | sign <檔案> | execute <檔案> | status");
}
