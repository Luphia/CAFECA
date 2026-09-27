# CAFECA 數位身分錢包

以 Boltchain 為基礎的數位身分證與錢包：在裝置上建立的 FIDO2 金鑰就是身分根（不需要任何第三方帳號），ERC-4337＋ERC-7579 模組化帳戶，以 Passkey 與 CAFECA 卡（指紋＋螢幕）操作，整合端對端加密聊天、支付、AI 子錢包與 Payment Protocol 支出通道，並讓任何網站免註冊使用「Sign in with CAFECA」。

| 目錄 | 內容 |
| --- | --- |
| [`contracts/`](contracts) | Solidity 合約（Foundry）：帳戶、工廠、Keyring／Recovery／Channel 模組、Paymaster、登記合約 |
| [`app/`](app) | Next.js 16 原型：錢包、卡片、AI 代理、聊天、安全與恢復，部署於 Boltchain 測試網 |

快速開始請見各目錄的 README。

---

## Sign in with CAFECA：第三方網站登入串接

任何網站都可以讓使用者以 CAFECA 身分登入，**不需要向 CAFECA 註冊、申請 client ID 或 API key**，也不需要 CAFECA 伺服器參與驗證。

### 原理

1. 你的後端產生一次性 `nonce`，前端把「登入請求」交給 CAFECA 錢包（彈出視窗、整頁導向或 QR code）。
2. 錢包顯示你的**網域**，使用者確認後以 Passkey 簽署一則 EIP-712 `SignIn` 訊息。訊息內含你的網域、nonce、有效時間與使用者同意提供的資料。
3. 錢包只把結果送回同一個網域：popup 用 `postMessage` 並指定 targetOrigin，另外兩種方式則要求 `redirectUri`／`responseUri` 必須與網域同源。
4. 你的後端用公開 RPC 呼叫使用者身分合約的 `isValidSignature`（ERC-1271）。回傳 `0x1626ba7e` 就代表這個人確實控制該 CAFECA 身分。

使用者的**身分合約地址（`account`）就是他在你網站上的唯一 ID**，換裝置、換 Passkey、以實體卡或備援金鑰恢復之後都不會變。

仿冒網站拿到的簽章綁定的是仿冒網站自己的網域，拿到你的網站用會驗證失敗。

### 1. 前端（彈出視窗）

```html
<script src="https://<CAFECA 錢包網域>/sdk/cafeca-connect.js"></script>
<button id="login">以 CAFECA 登入</button>
<script>
  const cafeca = CafecaConnect.create({ wallet: "https://<CAFECA 錢包網域>" });

  document.getElementById("login").onclick = async () => {
    // signIn 必須在點擊事件中呼叫，否則彈出視窗會被瀏覽器擋下；nonce 可以傳入非同步函式
    const response = await cafeca.signIn({
      nonce: () => fetch("/api/cafeca/nonce", { method: "POST" }).then((r) => r.json()).then((j) => j.nonce),
      statement: "登入 Example Shop",          // 選填，顯示給使用者看，最多 200 字
      claims: ["kyc_level", "handle"],          // 選填，使用者可以逐項取消
    });
    // 把 response 原封不動交給後端驗證（前端拿到的結果不可信任）
    await fetch("/api/cafeca/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(response) });
  };
</script>
```

`signIn` 失敗時會拋出 `CafecaError`，`code` 為以下其中之一：

- `access_denied`：使用者拒絕
- `closed`：使用者關閉視窗
- `popup_blocked`：瀏覽器擋下彈出視窗
- `timeout`：逾時
- `invalid_nonce`：nonce 格式錯誤

### 2. 後端驗證（Node.js）

複製 [`app/sdk/cafeca-verify.ts`](app/sdk/cafeca-verify.ts) 和 [`app/src/lib/signin.ts`](app/src/lib/signin.ts)，只需要 `viem` 這個依賴。

```ts
import { createCafecaVerifier, newNonce } from "./cafeca-verify";

const cafeca = createCafecaVerifier({ wallet: "https://<CAFECA 錢包網域>" });
const DOMAIN = "https://shop.example"; // 你的網站 origin，要與瀏覽器網址列完全相同

app.post("/api/cafeca/nonce", (req, res) => {
  const nonce = newNonce();
  req.session.cafecaNonce = { nonce, exp: Date.now() + 5 * 60_000 }; // 綁定目前的瀏覽器 session
  res.json({ nonce });
});

app.post("/api/cafeca/login", async (req, res) => {
  const saved = req.session.cafecaNonce;
  delete req.session.cafecaNonce; // 不論成功與否都作廢：一個 nonce 只能用一次
  if (!saved || saved.exp < Date.now()) return res.status(400).json({ error: "nonce 已過期" });
  try {
    const user = await cafeca.verify(req.body, { domain: DOMAIN, nonce: saved.nonce });
    // user.account：身分合約地址（唯一 ID）
    // user.claims.kyc_level：鏈上實名等級（0 未實名、2 已通過證件＋臉部驗證）
    // user.claims.handle：CAFECA 代稱（由錢包查詢確認；handleVerified=false 時只能拿來顯示）
    // user.recoveryPending：身分正在恢復中，建議暫停敏感操作
    req.session.userId = user.account;
    res.json(user);
  } catch (e) {
    res.status(401).json({ error: (e as Error).message });
  }
});
```

`createCafecaVerifier` 第一次呼叫時會讀取 `https://<錢包網域>/.well-known/cafeca-configuration`，取得 chainId、RPC 與合約位址。

- 如果不想依賴這個設定檔，可以用 `config` 參數把設定寫死在程式裡。
- `rpcUrl` 可以改用你自己的節點。
- 設定 `resolveHandle: false`，就不會向錢包查詢代稱。

### 3. 其他回傳方式

| 方式 | 適用情境 | 呼叫 |
| --- | --- | --- |
| `popup` | 桌機、一般瀏覽器（預設） | `cafeca.signIn({...})` |
| `redirect` | 行動裝置、擋彈出視窗的環境（in-app browser） | `cafeca.redirect({ nonce, redirectUri })`。回到 `redirectUri` 頁面後呼叫 `CafecaConnect.handleRedirect()`，回傳 `{ response }`、`{ error }` 或 `null` |
| `post` | 跨裝置：電腦顯示 QR code，用手機上的 CAFECA 掃描 | `cafeca.authLink({ nonce, mode: "post", responseUri: "/api/cafeca/callback" })`，把連結做成 QR code |

- **`redirect`**：結果放在網址的 `#cafeca=`（fragment 不會送到任何伺服器），`handleRedirect()` 讀取後會清除網址列。
- **`post`**：手機上的錢包以 `POST text/plain`（`no-cors`、不帶 cookie）把回應送到 `responseUri`。你的後端驗證後，把結果掛在該 nonce 上；電腦頁面再以 nonce 輪詢自己的後端，確認 nonce 屬於這個瀏覽器的 session 後才完成登入。

### 4. 協定細節（非 Node 環境自行實作）

**登入請求**：以 base64url(JSON) 放在 `https://<錢包網域>/dl/auth?v=1&req=<…>`。原生 App 可改用 `cafeca://auth?v=1&req=<…>`。

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `v` | ✓ | `1` |
| `domain` | ✓ | 你的網站 origin（`https://…`，本機開發可用 `http://localhost`） |
| `uri` | ✓ | 發起登入的頁面，必須與 `domain` 同源 |
| `nonce` | ✓ | 8–128 字元的 `[A-Za-z0-9_-]` |
| `issuedAt` / `expiresAt` | ✓ | Unix 秒；有效時間最長 600 秒 |
| `mode` | ✓ | `popup` / `redirect` / `post` |
| `redirectUri` | redirect | 與 `domain` 同源 |
| `responseUri` | post | 與 `domain` 同源 |
| `statement` |  | 最多 200 字 |
| `claims` |  | `kyc_level`、`handle` |
| `state` |  | 原樣帶回 |

錢包遇到任何不合規的欄位都會拒絕簽署。

**登入回應**：

```json
{
  "v": 1, "type": "cafeca:auth",
  "account": "0x…身分合約",
  "chainId": 8018,
  "message": { "domain": "…", "uri": "…", "nonce": "…", "issuedAt": 0, "expiresAt": 0, "statement": "…", "claims": "handle,kyc_level" },
  "signature": "0x…",
  "claims": { "handle": "…" },
  "state": "…"
}
```

`message.claims` 是使用者實際同意提供的項目，排序後以逗號分隔。

拒絕時的回應為 `{ "v": 1, "type": "cafeca:auth", "error": "access_denied", "nonce": "…", "state": "…" }`。

**簽署內容（EIP-712）**：

```
domain  = { name: "CAFECA Sign-In", version: "1", chainId, verifyingContract: account }
SignIn  = (string domain, string uri, string nonce, uint256 issuedAt, uint256 expiresAt, string statement, string claims)
```

**驗證步驟**：

1. 確認 `message.domain` 與你的 origin **完全相同**，`message.nonce` 是你發出且未使用過的，`chainId` 正確，現在時間早於 `expiresAt`。
2. 計算 `hash = hashTypedData(domain, SignIn, message)`。
3. 以 `eth_call` 呼叫 `account.isValidSignature(hash, signature)`，結果必須等於 `0x1626ba7e`。
4. 若 `claims` 含 `kyc_level`：呼叫 `attestation.levelOf(account)`，取得 `uint8` 等級。
5. 若含 `handle`：呼叫 `GET https://<錢包網域>/api/profile?q=<account>` 取得代稱。代稱存在 CAFECA 伺服器，不上鏈；回應裡自稱的 `claims.handle` 不可信任。
6. 可選：呼叫 `recovery.isPending(account)`，檢查身分是否正在恢復中。

合約位址見 `/.well-known/cafeca-configuration` 的 `contracts`。

### 5. 網站資訊（選填）

在 `https://<你的網域>/.well-known/cafeca-site.json` 放上以下內容，並加上 `Access-Control-Allow-Origin: *`：

```json
{ "name": "Example Shop", "icon": "/icon.png" }
```

- 錢包會把名稱標示為「網站自稱」，**畫面永遠以網域為主**。
- 圖示只接受你網域上的檔案。
- 沒有這個檔案也可以正常登入。

### 6. 安全注意事項

- **一定要在後端驗證**：SDK 不驗證簽章，前端拿到的回應可以被竄改。
- **nonce 必須綁定瀏覽器 session、只能使用一次，並在驗證前就作廢**，以防重送攻擊。
- **以 `account` 作為使用者 ID**，不要用代稱：代稱可以更換，也可能被其他人使用。
- **網域比對必須完全相同**（含 scheme 與 port），不要用 `endsWith` 或只比對主機名稱。
- **跨裝置 QR 有被轉送的風險**：攻擊者可能把你網站的登入 QR 放到自己的頁面上，誘騙使用者掃描（QRLjacking）。
  - 錢包會提醒使用者確認「是自己剛打開的頁面」。
  - 敏感網站建議 QR 有效時間設短（例如 2 分鐘），在電腦畫面同時顯示登入裝置與位置，或者只提供 popup／redirect。
- **AI 子錢包**是獨立地址，也能產生有效簽章。如果只接受本人登入，可以要求 `kyc_level ≥ 2`（AI 子錢包不會有實名等級）。
- **登入簽章不能拿去做其他事**：錢包只會簽署自己組出的 `SignIn` 結構，不會替網站簽任意訊息，所以不會被誘騙簽下 Permit 等授權。
- **TODO：合約層的 ERC-7739 防重放封裝尚未實作。** 目前「登入簽章無法挪用到其他用途」是靠錢包端限制來保證，上線前會補上合約層保護。
- **登入後的 session 由你的網站自行管理。** CAFECA 不發 access token，也無法替使用者撤銷你網站的 session；使用者在 CAFECA 的「安全 → 以 CAFECA 登入的網站」只看得到本機紀錄。

### 7. 範例網站

```bash
cd app
npm run dev            # CAFECA 錢包：http://localhost:10002
npm run demo:signin    # 範例第三方網站「咖啡豆小舖」：http://localhost:10003
```

範例（[`app/examples/signin-demo/server.ts`](app/examples/signin-demo/server.ts)）示範了彈出視窗、整頁導向與跨裝置 QR code 三種方式，並包含 nonce 管理與 `cafeca-site.json`。

可用的環境變數：

- `CAFECA_WALLET`：錢包網址
- `RPC_URL`：驗證用的 RPC
- `PORT`：範例網站的連接埠

錢包端的 `/.well-known/cafeca-configuration` 會以 `PUBLIC_RPC_URL`（預設 `https://boltchain.cafeca.io`）作為公開 RPC，並以 `PUBLIC_ORIGIN` 作為對外網址。
