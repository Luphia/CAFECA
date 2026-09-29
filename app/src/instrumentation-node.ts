import { launchGateProblems } from "./server/mode";

/** 正式模式上線閘門（只在 Node.js runtime 執行，見 instrumentation.ts） */
export function checkLaunchGate() {
  if (process.env.CAFECA_MODE !== "production") return;
  const problems = launchGateProblems();
  if (problems.length) {
    console.error("[CAFECA] 正式模式上線閘門未通過，拒絕啟動：\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log("[CAFECA] 正式模式：上線閘門通過");
}
