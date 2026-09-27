# CAFECA 數位身分錢包：合約骨架（M0）

這是在 Boltchain 上實作 ERC-4337 與 ERC-7579 的身分錢包合約骨架，對應設計規格 v0.1。

## 快速開始

```bash
# 需要 Foundry 1.x
forge install foundry-rs/forge-std \
  OpenZeppelin/openzeppelin-contracts@v5.4.0 \
  eth-infinitism/account-abstraction@v0.8.0
forge build
forge test        # 45 個測試
```

## 結構

```
src/
├─ account/CafecaAccount.sol          最小化 ERC-7579 帳戶（主帳戶與通道子帳戶共用）
├─ factory/IdentityAccountFactory.sol CREATE2(idCommitment)；驗 OIDC ZK 證明並綁定第一把 passkey
├─ modules/
│  ├─ KeyringValidator.sol            FIDO2 金鑰（MASTER＝卡片、DAILY＝手機）、權限矩陣、CTXD 所見即所簽
│  ├─ RecoveryValidator.sol           R1 卡片立即／R2 重新 KYC 48h／R3 僅 OIDC 7 天
│  └─ ChannelValidator.sol            AI 代理與 Visa 卡支出通道：政策、intent、authorize/capture
├─ channels/ChannelManager.sol        建立通道子帳戶
├─ registry/
│  ├─ JwksRegistry.sol                Google／Apple 公鑰（僅共識層系統地址可寫）
│  ├─ AttestationRegistry.sol         L1／L2 等級證明、KYC 單位、發卡方
│  └─ DeviceDirectory.sol             聊天裝置金鑰目錄
├─ paymaster/CafecaPaymaster.sol      平台全額贊助：每身分每日硬上限
├─ lib/WebAuthnLib.sol                WebAuthn ES256 驗證＋ctxd 擴充解析
├─ lib/TxSummary.sol                  卡片顯示摘要（OpKind、TxSummary）
└─ mocks/MockOidcVerifier.sol         測試用 OIDC 驗證器
```

## 測試涵蓋

| 檔案 | 驗證的規格 |
| --- | --- |
| `Keyring.t.sol` | 開戶綁定、JWT 攔截無法綁別的金鑰、標準模式額度與時間鎖、綁卡、大額需卡片、竄改螢幕內容被拒、同步金鑰不能當卡片、模組安裝 72h |
| `Recovery.t.sol` | R1 卡片立即恢復（含螢幕內容不符被拒）、R2 48h 清除卡片、R3 7 天、取消與冷卻、主金鑰模式停用 R3、JWT／JWKS 過期 |
| `Channel.t.sol` | AI 政策內付款、門檻／每日上限、白名單、超額 intent 需卡片核准、撤銷回收、Visa authorize/capture/release、鎖定資金不可被撤銷取走 |
| `Paymaster.t.sol` | 帳戶零 gas 代幣仍可交易、每日配額、竄改 UserOp 後簽章失效 |

## 已知限制（上線前必須處理）

1. **ERC-7562 驗證規則**：`KeyringValidator` 與 `ChannelValidator` 在驗證階段讀取 `block.timestamp`（每日額度與時間鎖），`RecoveryValidator` 讀取 `JwksRegistry`。這需要 CAFECA 自營的 bundler 放寬規則；另一條路是把額度移到執行期 hook，或等待 Boltchain 原生 AA（RIP-7560）。
2. **帳戶實作**：`CafecaAccount` 只是參考實作，正式版請換成經稽核的 Nexus 或 Kernel。
3. **OIDC 電路**：`MockOidcVerifier` 需換成電路產生的 Groth16 驗證器。
4. **ERC-1271**：DAILY 金鑰可以簽任意雜湊，存在被誘騙簽下 Permit／Permit2 的風險。需改用 ERC-7739 並限制可簽的 domain。
5. **未實作**：通道自動補款（`autoTopUp`）、新增第二個登入渠道（`linkIdentity`）、通道多代幣。
6. **本地 EVM**：測試使用 `evm_version = prague`，P-256 由 OZ 的軟體實作驗證（gas 較高）。Boltchain 為 Osaka，會走 EIP-7951 precompile。

## 卡片 CTXD 協定（摘要）

1. App 以 `KeyringValidator.previewAssessment(account, callData)` 取得 `TxSummary[]` 與 `ctxd`。
2. 將 `abi.encode(TxSummary[])` 傳給卡片，卡片在螢幕上顯示。
3. 使用者按指紋後，卡片在 authenticatorData 擴充寫入 `A1 64 "ctxd" 58 20 ‖ sha256(...)`，並設定 ED 旗標。
4. 鏈上從 callData 重建摘要並比對，不一致就拒絕。
