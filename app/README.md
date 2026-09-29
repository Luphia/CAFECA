# CAFECA 數位身分錢包（Next.js 16 原型）

以 FIDO2 金鑰為身分根（不需第三方登入）、Passkey 與 CAFECA 卡操作的智能合約錢包，整合端對端加密聊天、聊天內支付、AI 子錢包與 Visa 支出通道。部署在 Boltchain 測試網（chainId 8018）。

## 啟動

```bash
npm install          # 會一併下載 MediaPipe 臉部模型到 public/mediapipe（npm run fetch-models 可重跑）

# 1. 第一次執行：自動產生部署者私鑰與所有服務金鑰（寫入 .env.local），並印出部署者地址
npm run deploy

# 2. 轉入至少 8 BOLT 到印出的部署者地址，再執行一次即開始部署
npm run deploy

npm run dev   # http://localhost:10002
npm run demo:signin   # 選用：第三方登入範例網站 http://localhost:10003
```

**IdentityRegistry v2（規格 §16.2）**：已經部署過的環境執行 `npm run deploy -- --identity`，只增量部署 v2、把 v1 仍有效的證明遷移過去，並重新部署改讀 v2 的 paymaster（會取回舊 paymaster 的押金，需要約 6.5 BOLT）。工廠與 KeyringValidator 不動，既有身分地址不變。完成後重新啟動 `npm run dev`／`npm start`。

- 身分恢復執行後，由 `POST /api/identity/sync` 重新簽發或暫停 v2 證明。恢復頁面會自動觸發；正式環境請再加排程（例如每 5 分鐘 `curl -X POST https://<網域>/api/identity/sync`）。
- 部署在反向代理後方時設定 `PUBLIC_ORIGIN=https://<網域>`；公開 RPC 預設為 `<PUBLIC_ORIGIN>/api/rpc`，可用 `PUBLIC_RPC_URL` 覆寫。
- `KYC_SIGNER_CLASS=PRODUCTION` 只在正式 KYC 後台上線、換上 HSM 金鑰後使用；原型期維持預設（PROTOTYPE）。

已經部署過、之後合約有變更（例如 v0.3 金鑰模型）時，`npm run deploy` 會補上缺少的服務金鑰（`GUARDIAN_ROOT_KEY`、`GUARDIAN_SEED`）並整套重新部署；舊身分不會搬到新合約，需重新建立。只改了工廠合約時可用 `npm run deploy -- --factory`。

Passkey 需要安全環境：本機請用 `http://localhost:10002`，其他網域須為 https。

## 伺服器部署（cafeca.io）

在伺服器的 `app` 目錄執行一個指令即可（可重複執行，已完成的步驟會略過）：

```bash
PUBLIC_ORIGIN=https://cafeca.io npm run deploy:server
```

依序完成：

1. 安裝 `ffmpeg`（apt／dnf／yum／apk／brew，需要 sudo）
2. `git pull --ff-only`
3. `npm install`（含 MediaPipe 與 KYC 模型，約 140 MB，需能連 huggingface.co）
4. `.env.local`：寫入 `PUBLIC_ORIGIN`；沒有 `KYC_REVIEW_TOKEN` 就產生一組；提醒開發用旗標
5. 尚未部署 IdentityRegistry v2 時執行 `npm run deploy -- --identity`（部署者需約 6.5 BOLT）
6. `npm run build`（合約地址在建置時寫入）
7. 重新啟動：有 pm2 用 `pm2 restart cafeca`（沒有就 `pm2 start npm --name cafeca -- start`），或 `SYSTEMD_UNIT=<服務名>` 改用 systemctl
8. crontab 每 5 分鐘呼叫 `POST /api/identity/sync`
9. 檢查 `/.well-known/cafeca-configuration` 的 `issuer`、`chain.rpc`、`contracts.identityRegistry`

選項：`SKIP_PULL=1`、`SKIP_IDENTITY=1`、`SKIP_CRON=1`、`PM2_NAME=<名稱>`、`SYSTEMD_UNIT=<服務>`、`PORT=<npm start 的埠，預設 10002>`。

第一次部署（還沒有 `.env.local`）請先照上面「啟動」執行 `npm run deploy` 產生金鑰並部署合約。

## 功能對照

| 頁面 | 功能 | 規格章節 |
| --- | --- | --- |
| `/` | Landing page：數位身分證是什麼、為什麼需要、怎麼使用、三種金鑰與備援金鑰被盜的緩解、FAQ | — |
| `/start` | 建立身分：在裝置建立 FIDO2 金鑰 → 地址＝CREATE2(公鑰) → 一筆 UserOp 完成部署＋登記聊天裝置；裝置已有金鑰則直接登入 | §3、§4.4 |
| `/link` | 新裝置加入既有身分：建立金鑰 → 配對碼／QR → 在已登入的裝置確認，所有裝置金鑰同級 | §4.2 |
| `/kyc` | 實名驗證：身分證件照片＋引導式臉部影像（轉頭、眨眼、念隨機數字）→ 送出後顯示送出內容與審核進度（審核中不能重送，退件才能重拍）→ L2 證明 → 安裝平台備援金鑰 | §3.4、§5.3 |
| `/wallet` | TWDC 餘額、轉帳（即時預覽需要手機或卡片）、收款 QR、測試幣、額度、紀錄 | §4.3 |
| `/card` | 完成 KYC 後付費購買實體卡（TWDC 付款給發卡方）→ 綁定、掛失補發、Visa 通道、POS 刷卡模擬 | §4.5、§6.4、§9 |
| `/agents` | AI 代理與支出通道、x402 商家購買、超額 intent 以卡片核准、撥款、撤銷 | §6 |
| `/chat` | 代稱（第一次設定免費、之後固定，變更需付 150 TWDC，舊代稱保留）、裝置金鑰上鏈、E2EE 訊息、付款請求與聊天內付款、AI 核准通知 | §7 |
| `/security` | 裝置金鑰（同級、可互相移除）、實體卡與平台備援金鑰（不可移除）、連結其他裝置、額度、恢復狀態與取消、登出 | §4、§5 |
| `/dl/auth` | Sign in with CAFECA：第三方網站免註冊登入（彈出視窗／整頁導向／跨裝置 QR），顯示網域與第一次連線提醒、可取消提供的資料；`/security` 列出登入過的網站。串接說明見[根目錄 README](../README.md#sign-in-with-cafeca第三方網站登入串接) | §15 |
| `/dl/sign` | 簽章通道：登入時同意開啟後，網站可請你簽署訊息、EIP-712 或付款；並列顯示網站說明與錢包解析的實際內容，逐筆確認；跨裝置經加密中繼，錢包開啟時跳出提示；`/security` 可關閉通道 | §15.8 |
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
 ├─ /api/signin      /.well-known/cafeca-configuration（第三方登入探索文件）
 ├─ /api/identity    恢復後的實名證明同步（IdentityRegistry v2 重新簽發或暫停）
 ├─ /api/channel     簽章通道中繼信箱（只存端對端加密的密文）
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
| KYC 擷取 | 證件即時拍攝（引導框偵測、自動拍攝、裝置端浮水印）＋6 動作活體（MediaPipe 臉部特徵點）；上傳只有浮水印版 | 同左，並加原生 App 裝置認證 |
| KYC 後台 | 自建驗證已接上（OCR、活體重檢、語音、人臉比對、證號重複）；自動通過預設關閉，全部轉人工複核 `/admin/kyc` | 以真實樣本校準門檻後開啟 `KYC_AUTO_APPROVE=1`；補翻拍／深偽分類器、ISO 30107-3 送測、領補換查詢 |
| 平台備援金鑰 | 由 `GUARDIAN_SEED`＋帳戶地址衍生 | 每帳戶於 HSM 內產生、不可匯出，簽署需雙人覆核 |
| 平台根金鑰 | `.env.local` 的 `GUARDIAN_ROOT_KEY` | 離線冷儲存（多簽） |
| 重新 KYC 恢復 | 新裝置重新即時拍證件＋6 動作活體；統一編號 HMAC 相同且人臉相似度 ≥ 0.45 才發起恢復，否則轉人工 | 同左，並加原生 App 裝置認證 |
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

## KYC 後台驗證（規格 §14.3、§14.6）

證件與臉部影像只在自己的伺服器上以 onnxruntime-node 推論，不送往任何第三方；只處理浮水印版影像。

| 模組 | 做法 | 模型（Apache-2.0，由 `npm run fetch-models` 下載到 `models/kyc`，約 140 MB） |
| --- | --- | --- |
| 證件 OCR | 文字偵測＋辨識 → 依標籤列取姓名、出生日期、性別、發證日期、住址；統一編號以檢查碼驗證 | PP-OCRv5 mobile（繁簡中文） |
| 欄位合理性 | 檢查碼、性別與統一編號第二碼、日期範圍 | — |
| 活體重檢 | 影片每秒 8 格：YuNet 找臉 → 478 點特徵 → 與裝置端相同公式的頭部轉向、眼睛與嘴巴開合；逐一核對 6 個動作在裝置回報的時間窗內真的出現 | YuNet、MediaPipe 臉部 478 點（與裝置端同一份權重的 ONNX 版） |
| 念數字 | 只取念數字那段音訊，Whisper 辨識後比對 4 位數字（中文、大寫數字、英文都可） | Whisper base（int8） |
| 人臉比對 | 影片最正面的一格 vs 證件照，SFace 餘弦相似度 | YuNet、SFace |
| 證號重複 | 統一編號 HMAC 是否已綁定其他 CAFECA 身分 | — |

**決策**

- 明確不是同一人（相似度 < 0.15）或影片中幾乎沒有臉 → 退件，使用者可重拍。
- 全部通過且相似度 ≥ `KYC_AUTO_FACE`（預設 0.45），並且 `KYC_AUTO_APPROVE=1` → 自動通過。
- 其他一律轉人工複核。**`KYC_AUTO_APPROVE` 預設關閉**：門檻用真實（經同意的）樣本校準前，所有案件都由人審，複核紀錄與分數就是校準資料。

**人工複核後台 `/admin/kyc`**：以 `.env.local` 的 `KYC_REVIEW_TOKEN`（`npm run deploy` 會自動產生）登入並填寫複核人姓名。可以看到浮水印版證件、臉部影片、每項檢查、擷取欄位與分數，然後核准或退件。每次登入、檢視檔案與決策都寫入 `data/kyc/review-log.jsonl`。核准開戶案件＝寫入 L2；核准恢復案件＝以平台備援金鑰發起恢復。

**KYC Credential（規格 §16.3）**：第三方登入要求 `legal_name`、`doc_type`、`nationality`、`pairwise_id` 時，同意畫面向 `/api/kyc/credential` 取得由 KYC 簽章者簽署、綁定網站與這次登入 nonce 的 credential（`src/server/kyc-credential.ts`）。資料來自最新一筆核准案件的擷取欄位。`pairwise_id` 使用 `.env.local` 的 `KYC_PAIRWISE_KEY`（`npm run deploy`／`deploy:server` 會自動產生）；**這把金鑰一旦有網站使用就不能更換**，否則所有網站看到的同一人識別碼都會改變。沒有設定時不提供 `pairwise_id`。

**伺服器需求**

- 系統要有 `ffmpeg`（或以 `FFMPEG_PATH` 指定），用來解碼臉部影片與音訊。
- 一件案件在 2 核 CPU 上約 15–30 秒，依序在背景處理；`KYC_THREADS` 可調整推論執行緒數。
- 缺少模型或 ffmpeg 時，案件會標示原因並轉人工，不會自動通過。

**開發與測試**

- `NEXT_PUBLIC_KYC_SIMULATE=1`：前端活體步驟改為按鈕模擬完成動作（沒有真人臉部的 E2E 環境）。
- `KYC_PROTOTYPE_AUTO_APPROVE=1`：後台略過模型、全部放行。**兩者都只限開發，正式環境不得開啟。**
- 證件、臉部影像與動作序列存放在 `data/kyc/<身分地址>/<案件>/`（只有浮水印版）；`case.json` 另存 128 維人臉特徵，供恢復時比對本人。
