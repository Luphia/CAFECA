/**
 * 依賴方資料調閱的參考客戶端（給交易所等依賴方的工程師參考；不依賴本專案其他程式）
 *
 *   npm run rp -- keygen [rp-key.json]
 *       產生 P-256 加密金鑰：私鑰寫入檔案（自行保管，勿交給 CAFECA），公鑰 JWK 印出來交給 CAFECA 登記
 *   CAFECA_RP_KEY=cafeca_rp… npm run rp -- request <wallet> <request.json>
 *       送出調閱申請（request.json 格式見 README「資料調閱 API」）
 *   CAFECA_RP_KEY=cafeca_rp… npm run rp -- fetch <wallet> <id> [rp-key.json] [out-dir]
 *       查詢狀態；已放行就下載資料包、以私鑰解密、以 disclosure.jwks 驗章，印出內容，證件影像另存到 out-dir
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { compactDecrypt, compactVerify, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

const [cmd, ...args] = process.argv.slice(2);
const key = process.env.CAFECA_RP_KEY ?? "";

async function call(wallet: string, init?: RequestInit & { query?: string }) {
  const res = await fetch(`${wallet.replace(/\/+$/, "")}/api/rp/disclosures${init?.query ?? ""}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${j.error ?? ""}`);
  return j;
}

export async function openPackage(jwe: string, privateJwk: JWK, jwks: { keys: JWK[] }) {
  const { plaintext } = await compactDecrypt(jwe, await importJWK(privateJwk, "ECDH-ES"));
  const { payload, protectedHeader } = await compactVerify(new TextDecoder().decode(plaintext), createLocalJWKSet(jwks as never));
  if (protectedHeader.alg !== "ES256") throw new Error("簽章演算法不符");
  return JSON.parse(new TextDecoder().decode(payload));
}

if (cmd === "keygen") {
  const file = args[0] ?? "rp-key.json";
  const { privateKey, publicKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  writeFileSync(file, JSON.stringify(await exportJWK(privateKey)), { mode: 0o600 });
  console.log(`私鑰已寫入 ${file}（請妥善保管）。把下面的公鑰交給 CAFECA 登記：`);
  console.log(JSON.stringify(await exportJWK(publicKey)));
} else if (cmd === "request") {
  const [wallet, file] = args;
  console.log(JSON.stringify(await call(wallet, { method: "POST", body: readFileSync(file, "utf8") }), null, 2));
} else if (cmd === "fetch") {
  const [wallet, id, keyFile = "rp-key.json", out] = args;
  const r = await call(wallet, { query: `?id=${encodeURIComponent(id)}` });
  if (!r.package) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  const conf = await (await fetch(`${wallet.replace(/\/+$/, "")}/.well-known/cafeca-configuration`)).json();
  const data = await openPackage(r.package, JSON.parse(readFileSync(keyFile, "utf8")), conf.disclosure.jwks);
  const imgs = (data.data?.doc_images ?? []) as { kind: string; data: string }[];
  if (out && imgs.length) {
    mkdirSync(out, { recursive: true });
    for (const i of imgs) writeFileSync(path.join(out, `${data.id}-${i.kind}.jpg`), Buffer.from(i.data, "base64"));
  }
  for (const i of imgs) i.data = `（${i.data.length} bytes base64${out ? `，已存到 ${out}` : ""}）`;
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log("用法：npm run rp -- keygen | request <wallet> <request.json> | fetch <wallet> <id> [rp-key.json] [out-dir]");
}
