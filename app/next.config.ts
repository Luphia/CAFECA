import { existsSync, readFileSync } from "fs";
import path from "path";
import type { NextConfig } from "next";

/**
 * 部署位址：本機部署（npm run deploy）寫入的 .local.json 優先，
 * 沒有就用 git 追蹤的共用部署。部署後需重新啟動 npm run dev 才會讀到新位址。
 */
function loadDeployment(): string {
  const dir = path.join(process.cwd(), "deployments");
  for (const f of ["boltchain-testnet.local.json", "boltchain-testnet.json"]) {
    const p = path.join(dir, f);
    if (existsSync(p)) return JSON.stringify(JSON.parse(readFileSync(p, "utf8")));
  }
  return JSON.stringify({ chainId: 8018, deployed: false });
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_CAFECA_DEPLOYMENT: loadDeployment(),
  },
  // Sign in with CAFECA（規格 §15）：公開的探索文件
  async rewrites() {
    return [{ source: "/.well-known/cafeca-configuration", destination: "/api/signin/config" }];
  },
  // 瀏覽器 SDK 允許任何網站以 <script> 或 import 載入
  async headers() {
    return [{ source: "/sdk/:path*", headers: [{ key: "access-control-allow-origin", value: "*" }, { key: "cache-control", value: "public, max-age=300" }] }];
  },
};

export default nextConfig;
