# CAFECA 數位身分錢包：合約（v0.3 金鑰模型）

這是在 Boltchain 上實作 ERC-4337 與 ERC-7579 的身分錢包合約骨架，對應設計規格 v0.1。

## 快速開始

```bash
# 需要 Foundry 1.x
forge install foundry-rs/forge-std \
  OpenZeppelin/openzeppelin-contracts@v5.4.0 \
  eth-infinitism/account-abstraction@v0.8.0
forge build
forge test        # 54 個測試
```

## 結構

```
src/
├─ account/CafecaAccount.sol          最小化 ERC-7579 帳戶（主帳戶與通道子帳戶共用）
├─ factory/IdentityAccountFactory.sol 身分以第一把 FIDO2 金鑰為根：account = CREATE2(keccak(公鑰))
├─ modules/
│  ├─ KeyringValidator.sol            裝置金鑰（DAILY，所有裝置同級共管）與實體卡（MASTER，不可被其他金鑰移除）、權限矩陣、CTXD
│  ├─ RecoveryValidator.sol           平台備援金鑰（KYC 後由 HSM 託管、不可移除）：只能在時間鎖後以新裝置取代所有裝置金鑰
│  └─ ChannelValidator.sol            AI 代理與 Visa 卡支出通道：政策、intent、authorize/capture
├─ channels/ChannelManager.sol        建立通道子帳戶
├─ registry/
│  ├─ AttestationRegistry.sol         L1／L2 等級證明、KYC 單位、發卡方
│  └─ DeviceDirectory.sol             聊天裝置金鑰目錄
├─ paymaster/CafecaPaymaster.sol      平台全額贊助：每身分每日硬上限
├─ lib/WebAuthnLib.sol                WebAuthn ES256 驗證＋ctxd 擴充解析
├─ lib/TxSummary.sol                  卡片顯示摘要（OpKind、TxSummary）
└─ mocks/TestStable.sol               測試網 TWDC（每日領取）
```

## 金鑰模型（v0.3）

| 金鑰 | 取得方式 | 能做什麼 | 誰能移除 |
| --- | --- | --- | --- |
| 裝置金鑰（DAILY） | 建立身分時的第一把；之後任何裝置金鑰可立即加入其他裝置 | 額度內轉帳、新增／移除其他裝置、取消恢復 | 任何裝置金鑰（不能移除最後一把） |
| 平台備援金鑰（guardian） | 證件＋臉部影像 KYC 通過後，平台根金鑰授權、由帳戶安裝一次 | 只能發起恢復：48h（有卡 7 天）後以新裝置取代所有裝置金鑰 | 裝置與卡片都不能；只有平台根金鑰能輪替／撤銷 |
| 實體卡（MASTER） | L2 KYC＋付費，發卡方簽署證明後綁定 | 大額與放寬權限的操作（螢幕確認）、立即新增裝置 | 只有卡片本身；或掛失補發時由發卡方證明汰換 |

備援金鑰被盜的緩解：權限最小化、時間鎖＋轉出凍結、取消後冷卻 7 天、爭議升級（裝置取消後，平台人工複核可發起 7 天的升級恢復，只有卡片能取消）、每帳戶獨立金鑰＋離線根金鑰輪替。

## 測試涵蓋

| 檔案 | 驗證的規格 |
| --- | --- |
| `Keyring.t.sol` | FIDO2 金鑰即身分（initCode 部署、他人金鑰簽章被拒、搶先部署仍歸根金鑰所有）、裝置同級共管、額度、綁卡需 KYC、卡片不可被裝置或其他卡移除、掛失補發、大額需卡片、竄改螢幕內容被拒、同步金鑰不能當卡片、模組安裝 72h |
| `Recovery.t.sol` | 備援金鑰需平台根金鑰授權、不可被更換或移除、不能轉帳或登入、48h／7 天恢復（卡片保留）、被盜時本人取消與冷卻、根金鑰輪替、爭議升級只有卡片能取消 |
| `Channel.t.sol` | AI 政策內付款、門檻／每日上限、白名單、超額 intent 需卡片核准、撤銷回收、Visa authorize/capture/release、鎖定資金不可被撤銷取走 |
| `Paymaster.t.sol` | 帳戶零 gas 代幣仍可交易、每日配額、竄改 UserOp 後簽章失效 |

## 已知限制（上線前必須處理）

1. **ERC-7562 驗證規則**：`KeyringValidator` 與 `ChannelValidator` 在驗證階段讀取 `block.timestamp`（每日額度與時間鎖），`RecoveryValidator` 讀取平台根金鑰名單與帳戶卡片數。這需要 CAFECA 自營的 bundler 放寬規則；另一條路是把額度移到執行期 hook，或等待 Boltchain 原生 AA（RIP-7560）。
2. **帳戶實作**：`CafecaAccount` 只是參考實作，正式版請換成經稽核的 Nexus 或 Kernel。
3. **身分建立防濫用**：建立身分不需任何登入，需以 paymaster 額度、裝置認證與頻率限制防止大量建立身分套取 gas 贊助。
4. **ERC-1271**：DAILY 金鑰可以簽任意雜湊，存在被誘騙簽下 Permit／Permit2 的風險。需改用 ERC-7739 並限制可簽的 domain。
5. **未實作**：通道自動補款（`autoTopUp`）、通道多代幣。
6. **本地 EVM**：測試使用 `evm_version = prague`，P-256 由 OZ 的軟體實作驗證（gas 較高）。Boltchain 為 Osaka，會走 EIP-7951 precompile。

## 卡片 CTXD 協定（摘要）

1. App 以 `KeyringValidator.previewAssessment(account, callData)` 取得 `TxSummary[]` 與 `ctxd`。
2. 將 `abi.encode(TxSummary[])` 傳給卡片，卡片在螢幕上顯示。
3. 使用者按指紋後，卡片在 authenticatorData 擴充寫入 `A1 64 "ctxd" 58 20 ‖ sha256(...)`，並設定 ED 旗標。
4. 鏈上從 callData 重建摘要並比對，不一致就拒絕。
