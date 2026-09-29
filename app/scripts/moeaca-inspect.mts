/**
 * 工商憑證檢查工具（P1.5 PoC）：以實體卡片匯出的簽章憑證（或 MOEACA 網站下載的 .cer）確認欄位與驗證流程
 *
 *   npm run moeaca:inspect -- <憑證.cer|.pem>
 *   npm run moeaca:inspect -- --sig <HiPKI 回傳的 PKCS#7 base64 檔> --tbs <簽署內容文字檔>
 *
 * 會驗證：憑證鏈（MOEACA → GRCA，內建）、效期、金鑰用途、憑證政策、CRL；並印出統一編號、公司名稱、正卡／附卡。
 */
import { readFileSync } from "fs";
import { inspectMoeacaCert, verifyMoeacaSignature } from "../src/server/moeaca";

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  if (flag("--sig")) {
    const r = await verifyMoeacaSignature({ signature: readFileSync(flag("--sig")!, "utf8").trim(), expected: new Uint8Array(readFileSync(flag("--tbs")!)) });
    console.log("✓ 簽章與憑證有效", r);
  } else if (args[0]) {
    const raw = readFileSync(args[0]);
    const text = raw.toString("utf8");
    const der = text.includes("-----BEGIN") ? Buffer.from(text.replace(/-----[^-]+-----|\s/g, ""), "base64") : raw;
    console.log("✓ 憑證有效", await inspectMoeacaCert(new Uint8Array(der)));
  } else {
    console.log("用法：npm run moeaca:inspect -- <憑證.cer>  或  --sig <sig.b64> --tbs <tbs.txt>");
  }
} catch (e) {
  console.error("✕", (e as Error).message);
  process.exit(1);
}
