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
};

export default nextConfig;
