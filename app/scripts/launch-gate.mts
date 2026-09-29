/**
 * 正式模式上線閘門（npm run gate）：讀 .env.local（再疊上目前的環境變數），列出正式模式不允許的設定。
 * CAFECA_MODE=production 時伺服器啟動也會做同樣的檢查（src/instrumentation.ts），不通過就拒絕啟動。
 */
import { existsSync, readFileSync } from "fs";
import { launchGateProblems } from "../src/server/mode";

const file = ".env.local";
const fromFile: Record<string, string> = {};
if (existsSync(file))
  for (const l of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) fromFile[m[1]] = m[2];
  }
const env = { ...fromFile, ...process.env };
const problems = launchGateProblems(env);
if (problems.length) {
  console.error("上線閘門未通過：\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("上線閘門通過");
