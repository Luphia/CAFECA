# CAFECA 數位身分錢包（Next.js 16 原型）

以 Google／Apple 登入開戶、FIDO2 Passkey 與 CAFECA 卡操作的智能合約錢包，整合端對端加密聊天、聊天內支付、AI 子錢包與 Visa 支出通道。部署在 Boltchain 測試網（chainId 8018）。

## 啟動

```bash
npm install

# 1. 第一次執行：自動產生部署者私鑰與所有服務金鑰（寫入 .env.local），並印出部署者地址
npm run deploy

# 2. 轉入至少 8 BOLT 到印出的部署者地址，再執行一次即開始部署
npm run deploy

# 3.（選用）設定 Google Client ID，授權來源加入 http://localhost:3000
#    NEXT_PUBLIC_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com

npm run dev   # http://localhost:3000
```

只修改了工廠合約時（例如開戶流程調整），不必整套重新部署：

```bash
npm run deploy -- --factory   # 只部署新的 IdentityAccountFactory 並更新 deployments/boltchain-testnet.json
```

沒有 Google Client ID 時，可以用畫面上的「測試網開發者登入」（`NEXT_PUBLIC_DEV_LOGIN=1`，部署腳本預設開啟），它會模擬 Google 簽發 id_token，其餘流程完全相同。

## 功能對照

| 頁面 | 功能 | 規格章節 |
| --- | --- | --- |
| `/` | 開戶：建立 Passkey → OIDC nonce 綁定公鑰 → 一筆 UserOp 完成部署＋登記聊天裝置；既有帳戶登入（由簽章還原公鑰比對鏈上金鑰） | §3、§4.4 |
| `/wallet` | TWDC 餘額、轉帳（即時預覽需要手機或卡片）、收款 QR、測試幣、額度、紀錄 | §4.3 |
| `/card` | L2 KYC（鏈上只存 Merkle root）、申請與綁定卡片、Visa 通道、POS 刷卡模擬、清算／釋放 | §3.4、§4.5、§6.4、§9 |
| `/agents` | AI 代理與支出通道、x402 商家購買、超額 intent 以卡片核准、撥款、撤銷 | §6 |
| `/chat` | 裝置金鑰上鏈、E2EE 訊息、付款請求與聊天內付款、AI 核准通知 | §7 |
| `/security` | 金鑰列表、新增／移除、額度、時間鎖排程、恢復狀態與取消、登出 | §4、§5 |
| `/recover` | R1 卡片立即／R2 重新 KYC 48h／R3 僅登入 7 天 | §5 |

## 架構

```
瀏覽器
 ├─ Passkey（WebAuthn，DAILY）
 ├─ 卡片模擬器（WebCrypto 不可匯出 P-256，MASTER，CTXD 螢幕確認）
 ├─ 聊天裝置金鑰（ECDH P-256 → AES-GCM）
 └─ /api/rpc（唯讀 RPC 代理）

Next.js Route Handlers（伺服器）
 ├─ /api/bundler     組 UserOp、paymaster 簽章、handleOps 送出
 ├─ /api/oidc        驗證 id_token、salt、JWKS 上鏈、簽署 OIDC 證明
 ├─ /api/auth        ERC-1271 登入挑戰 → session cookie
 ├─ /api/issuer      發卡方簽署卡片證明
 ├─ /api/kyc         模擬 KYC 單位
 ├─ /api/visa        模擬發卡處理商（authorize／capture）
 ├─ /api/agent       AI 代理（規則式，金鑰代表 TEE）
 ├─ /api/merchant    x402 商家
 └─ /api/chat        密文轉存

Boltchain 測試網：EntryPoint v0.8 ＋ CAFECA 合約（../contracts）
```

## 測試網替代方案（上線前必須換掉）

| 項目 | 測試網做法 | 正式版 |
| --- | --- | --- |
| OIDC 證明 | `AttestedOidcVerifier`：伺服器驗證 JWT 後簽章 | Groth16 ZK 電路 |
| JWKS 更新 | 營運錢包代替共識層寫入 `JwksRegistry` | 驗證者在共識層寫入 |
| CAFECA 卡 | 瀏覽器卡片模擬器 | 實體卡（安全晶片驅動電子紙） |
| salt | 伺服器 HMAC（salt 服務） | 使用者裝置產生並加密備份 |
| KYC／Visa | 模擬 | 持照 KYC 單位、發卡處理商 |
| AI 代理金鑰 | 伺服器 `data/store.json` | TDX enclave |
| 聊天 | ECDH＋AES-GCM | MLS（RFC 9420） |
| 資料儲存 | `data/store.json` | 資料庫 |
| Bundler | 內建（不套用 ERC-7562 限制） | 獨立 bundler 或原生 AA |

## 開發

```bash
npm run typecheck
npx eslint src
npm run build
```

合約 ABI 在 `src/lib/contracts/abis.ts`，部署用 bytecode 在 `scripts/artifacts/`，都由 `../contracts` 編譯產生。
