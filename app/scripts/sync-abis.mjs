// 從 ../contracts/out 重新產生 ABI 與部署 bytecode（修改合約並 forge build 後執行）
import { readFileSync, writeFileSync } from "fs";
const OUT = new URL("../../contracts/out/", import.meta.url);
const names = {
  EntryPoint: "EntryPoint.sol/EntryPoint", CafecaAccount: "CafecaAccount.sol/CafecaAccount",
  IdentityAccountFactory: "IdentityAccountFactory.sol/IdentityAccountFactory", KeyringValidator: "KeyringValidator.sol/KeyringValidator",
  RecoveryValidator: "RecoveryValidator.sol/RecoveryValidator", ChannelValidator: "ChannelValidator.sol/ChannelValidator",
  ChannelManager: "ChannelManager.sol/ChannelManager",
  AttestationRegistry: "AttestationRegistry.sol/AttestationRegistry", DeviceDirectory: "DeviceDirectory.sol/DeviceDirectory",
  CafecaPaymaster: "CafecaPaymaster.sol/CafecaPaymaster",
  TestStable: "TestStable.sol/TestStable",
};
const ts = ["// 由 contracts/out 自動產生，請勿手動編輯", ""];
for (const [k, v] of Object.entries(names)) {
  const d = JSON.parse(readFileSync(new URL(`${v}.json`, OUT), "utf8"));
  writeFileSync(new URL(`./artifacts/${k}.json`, import.meta.url), JSON.stringify({ abi: d.abi, bytecode: d.bytecode.object }));
  ts.push(`export const ${k[0].toLowerCase() + k.slice(1)}Abi = ${JSON.stringify(d.abi)} as const;\n`);
}
writeFileSync(new URL("../src/lib/contracts/abis.ts", import.meta.url), ts.join("\n"));
console.log("ABI 已更新");
