/**
 * 伺服器啟動時的上線閘門：CAFECA_MODE=production 且有不允許的設定時，直接結束程序（見 src/server/mode.ts）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("./instrumentation-node")).checkLaunchGate();
}
