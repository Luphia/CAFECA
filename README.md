# CAFECA 數位身分錢包

以 Boltchain 為基礎的數位身分證與錢包：Google／Apple 登入開戶，ERC-4337＋ERC-7579 模組化帳戶，FIDO2 Passkey 與 CAFECA 卡（指紋＋螢幕）操作，整合端對端加密聊天、支付、AI 子錢包與 Visa 支出通道。

| 目錄 | 內容 |
| --- | --- |
| [`contracts/`](contracts) | Solidity 合約（Foundry）：帳戶、工廠、Keyring／Recovery／Channel 模組、Paymaster、登記合約 |
| [`app/`](app) | Next.js 16 原型：錢包、卡片、AI 代理、聊天、安全與恢復，部署於 Boltchain 測試網 |

快速開始請見各目錄的 README。
