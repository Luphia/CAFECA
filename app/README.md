# CAFECA 數位身分錢包（Next.js 16 原型）

以 FIDO2 金鑰為身分根（不需第三方登入）、Passkey 與 CAFECA 卡操作的智能合約錢包，整合端對端加密聊天、聊天內支付、AI 子錢包與 Visa 支出通道。部署在 Boltchain 測試網（chainId 8018）。

## 啟動

```bash
npm install

# 1. 第一次執行：自動產生部署者私鑰與所有服務金鑰（寫入 .env.local），並印出部署者地址
npm run deploy

# 2. 轉入至少 8 BOLT 到印出的部署者地址，再執行一次即開始部署
npm run deploy

npm run dev   # http://localhost:10002
```

### 部署檔案（避免 git 衝突）

| 檔案 | 進 git | 用途 |
| --- | --- | --- |
| `deployments/boltchain-testnet.json` | 是 | 團隊共用的測試網部署；clone 下來即可直接連線 |
| `deployments/boltchain-testnet.local.json` | 否 | `npm run deploy` 預設寫這裡，只影響你自己的環境 |

App 啟動時優先讀 `.local.json`，沒有才用共用檔（修改後需重新啟動 `npm run dev`）。
要把你的部署設為團隊共用版本時才執行 `npm run deploy -- --publish`，並 commit `boltchain-testnet.json`。
刪掉 `.local.json` 即可改回共用部署。只改了工廠合約時可用 `npm run deploy -- --factory`。

RPC 與區塊鏈瀏覽器預設為 `https://boltchain.cafeca.io`；伺服器端可用 `.env.local` 的 `RPC_URL` 覆寫。

Passkey 需要安全環境：本機請用 `http://localhost:10002`，其他網域須為 https。

## 功能對照

| 頁面 | 功能 | 規格章節 |
| --- | --- | --- |
| `/` | Landing page：數位身分證是什麼、為什麼需要、怎麼使用、三種金鑰與備援金鑰被盜的緩解、FAQ | — |
| `/start` | 建立身分：在裝置建立 FIDO2 金鑰 → 地址＝CREATE2(公鑰) → 一筆 UserOp 完成部署＋登記聊天裝置；裝置已有金鑰則直接登入 | §3、§4.4 |
| `/link` | 新裝置加入既有身分：建立金鑰 → 配對碼／QR → 在已登入的裝置確認，所有裝置金鑰同級 | §4.2 |
| `/kyc` | 實名驗證：身分證件照片＋引導式臉部影像（轉頭、眨眼、念隨機數字）→ L2 證明 → 安裝平台備援金鑰 | §3.4、§5.3 |
| `/wallet` | TWDC 餘額、轉帳（即時預覽需要手機或卡片）、收款 QR、測試幣、額度、紀錄 | §4.3 |
| `/card` | 完成 KYC 後付費購買實體卡（TWDC 付款給發卡方）→ 綁定、掛失補發、Visa 通道、POS 刷卡模擬 | §4.5、§6.4、§9 |
| `/agents` | AI 代理與支出通道、x402 商家購買、超額 intent 以卡片核准、撥款、撤銷 | §6 |
| `/chat` | 裝置金鑰上鏈、E2EE 訊息、付款請求與聊天內付款、AI 核准通知 | §7 |
| `/security` | 裝置金鑰（同級、可互相移除）、實體卡與平台備援金鑰（不可移除）、連結其他裝置、額度、恢復狀態與取消、登出 | §4、§5 |
| `/recover` | 找到身分 → 新裝置建立金鑰 → 實體卡立即新增，或以證件＋臉部影像讓平台備援金鑰發起恢復（48h／有卡 7 天） | §5 |

## 架構

```
瀏覽器
 ├─ Passkey（WebAuthn，裝置金鑰：每台裝置同級）
 ├─ 卡片模擬器（WebCrypto 不可匯出 P-256，實體卡金鑰，CTXD 螢幕確認）
 ├─ 聊天裝置金鑰（ECDH P-256 → AES-GCM）
 └─ /api/rpc（唯讀 RPC 代理）

Next.js Route Handlers（伺服器）
 ├─ /api/bundler     組 UserOp、paymaster 簽章、handleOps 送出
 ├─ /api/auth        ERC-1271 登入挑戰 → session cookie
 ├─ /api/issuer      發卡方簽署卡片證明
 ├─ /api/kyc         模擬 KYC 單位（證件＋臉部影像、活體挑戰）
 ├─ /api/recovery    平台備援金鑰（模擬 HSM）：重新驗證本人後簽署恢復
 ├─ /api/card        實體卡訂單（核對鏈上付款）
 ├─ /api/visa        模擬發卡處理商（authorize／capture）
 ├─ /api/agent       AI 代理（規則式，金鑰代表 TEE）
 ├─ /api/merchant    x402 商家
 └─ /api/chat        密文轉存

Boltchain 測試網：EntryPoint v0.8 ＋ CAFECA 合約（../contracts）
```

## 測試網替代方案（上線前必須換掉）

| 項目 | 測試網做法 | 正式版 |
| --- | --- | --- |
| 身分建立防濫用 | 每 IP 每日 10 個身分（`MAX_IDENTITIES_PER_IP_PER_DAY`） | 裝置認證（App Attest／Play Integrity）＋Redis |
| CAFECA 卡 | 瀏覽器卡片模擬器 | 實體卡（安全晶片驅動電子紙） |
| KYC 證據 | 只檢查證件照與臉部影像的型別、長度、一次性活體挑戰；只保存雜湊 | 持照 KYC 單位：證件真偽、活體偵測、證件照↔臉部比對 |
| 平台備援金鑰 | 由 `GUARDIAN_SEED`＋帳戶地址衍生 | 每帳戶於 HSM 內產生、不可匯出，簽署需雙人覆核 |
| 平台根金鑰 | `.env.local` 的 `GUARDIAN_ROOT_KEY` | 離線冷儲存（多簽） |
| 重新 KYC 恢復 | 比對開戶時身分證字號的 HMAC＋新的臉部影像 | 同上，並與開戶影像比對 |
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
