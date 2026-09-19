# CO2Exchange — 減量額度登錄、交易與註銷平台（Phase 0）

企業完成 ISO 14064-2 減量、14064-3 第三方查驗後，由查驗機構在鏈上簽章核發減量額度；
額度可掛單販售給個人、機構或其他企業，買方註銷後取得可附於申報文件的憑證。
由 CAFECA 建置，設計為控制權可完整移轉給國家單位、CAFECA 代運營。

架構決策、風險與分期紀錄於 Claude project `CO2Exchange › claude/architecture-decisions.md`。

## 分層

```
帳戶層             PasskeyAccount / Factory  P-256 passkey 擁有的智能帳戶，CREATE2 決定地址，WebAuthn 驗簽（OZ P256）
身分層（UUPS）     KYCRegistry            政府憑證 attestation → tier / expiry / frozen / recover
登錄層（不可升級） CarbonRegistry         查驗機構 EIP-712 簽章核發、序號唯一、專案登錄
                   CarbonCredit1155       額度本體，白名單主防線在 _update；retire → 憑證
                   RetirementCertificate  ERC-721 註銷憑證（soulbound，含受益人 hash、用途、PDF hash）
市場層（UUPS）     Listing                企業以專案名義定價掛單（Phase 1 主市場）
                   CarbonPool + CCT       同年份池化 ERC-20；FIFO 免費贖回、指定批次收費、redeemAndRetire
v4 模組（展示）    CarbonKYCHook          只接受 TrustedRouter、建池需 OPERATOR、每日限額以實際 delta 計
                   TrustedRouter          把 msg.sender 編進 hookData，直接在使用者與 PoolManager 間結算
mock               MockTWD                6 decimals 結算幣；正式由金融機構存款代幣化取代
```

白名單規則：持有與註銷永遠允許；轉帳需雙方有效且未凍結；自然人預設不可轉出（政策開關）；KYC 到期只擋交易不鎖資產。

## 治理（Safe + Timelock）

```
國家單位 Safe（2-of-3）──提案/執行──▶ TimelockController（48h）──DEFAULT_ADMIN──▶ 所有合約（升級、角色結構）
        │                                                  └── owner ──▶ PoolManager
        └──── SOVEREIGN_ROLE（即時）──▶ 凍結地址/批次、暫停、認可/撤銷查驗機構與身分驗證服務、撤換營運
營運 Safe（CAFECA）── OPERATOR_ROLE ──▶ 暫停/恢復、手續費、recover、hook 設定
```

角色階層：`OPERATOR_ROLE` 的 admin 是 `SOVEREIGN_ROLE`（國家 Safe 可即時撤換營運方，不用等 48 小時）；
`SOVEREIGN_ROLE` 的 admin 是 `DEFAULT_ADMIN_ROLE`（只有 Timelock 能變更主權歸屬）。緊急權即時、結構權延遲。

`Deploy.s.sol` 會部署 Safe v1.4.1（singleton / factory / fallback handler）、兩個 Safe、Timelock，佈線完成後把所有治理角色交給
Safe / Timelock 並由部署者 `renounceRole` —— 部署結束時沒有任何 EOA 持有治理角色。保留的服務角色：身分驗證服務簽章、查驗機構簽章、
MockTWD 鑄幣（demo faucet）。

操作工具 `script/govern.sh`（cast 包裝）：`status` 檢查權限狀態、`build <preset>` 組 calldata、`timelock schedule|execute|cancel|state`、
`safe national|operator hash|exec`、`sign`、Safe owner 管理。完整 SOP（緊急凍結、升級、簽章者管理、移轉驗收）見 project 文件「CO2Exchange 治理操作手冊」。

環境變數：`NATIONAL_SAFE` / `OPERATOR_SAFE`（既有 Safe 地址）或 `NATIONAL_OWNERS`（逗號分隔）/ `NATIONAL_THRESHOLD`、
`OPERATOR_OWNERS` / `OPERATOR_THRESHOLD`、`TIMELOCK_DELAY`（秒）。Phase 0 預設：國家 Safe = Anvil 帳戶 5,6,7（2-of-3），營運 Safe = 帳戶 8,9（1-of-2）。

## 安裝

第一次（會裝 Foundry、git init、以釘死版本加入依賴、build、test）：

```bash
bash setup.sh
```

之後：

```bash
forge build
forge test
```

依賴（git submodule，已釘版本）：

| lib | 版本 |
|---|---|
| v4-core | v4.0.0 (`e50237c`) |
| openzeppelin-contracts | v5.1.0 |
| openzeppelin-contracts-upgradeable | v5.1.0 |
| forge-std | v1.16.2 |
| safe-smart-account | v1.4.1 |

## 本地展示（Anvil）

```bash
anvil
# 另一個終端
forge script script/Deploy.s.sol   --rpc-url anvil --broadcast                # 只部署
forge script script/DemoFlow.s.sol --rpc-url anvil --broadcast --sig "demo()" # 部署 + 完整流程
```

`DemoFlow` 用 Anvil 預設帳戶：account0 = 國家單位 / 營運 / 身分驗證服務 / 查驗機構（Phase 0 合一），
account1 = 減量企業，account2 = 做市商，account3 = 自然人。流程：憑證 attestation 註冊 → 專案登錄 →
查驗簽章核發 100 噸 → 30 噸掛單、60 噸入池、做市商提供 v4 流動性 → 自然人從掛單與 v4 各買一次 → 兩邊註銷取得憑證。

## 前端（web/，Next.js 16 + React 19）

登入（Apple / Google / 開發用）→ passkey 建立鏈上帳戶 → 政府憑證身分驗證（Phase 0 模擬）→ 購買（企業掛單或 v4 池）→ 註銷 → 憑證。

```bash
# 終端 1
anvil
# 終端 2：部署 + 種子資料
forge script script/DemoFlow.s.sol --rpc-url anvil --broadcast --sig "demo()"
# 終端 3
cd web && cp .env.example .env.local && npm install && npm run dev
# 開 http://localhost:3000
```

錢包架構：`PasskeyAccount`（P-256 passkey 是唯一擁有者，地址由公鑰經 CREATE2 決定，換裝置不變）。
Phase 0 交易由平台 relayer 代送 `execute`（`/api/relay`，gas 由平台付），授權來自使用者的 WebAuthn 簽章，relayer 無法竄改內容；
Phase 1 換成 ERC-4337 EntryPoint + paymaster，帳戶簽章格式與 nonce 語意不變。

Apple / Google 登入：在 `.env.local` 設 `AUTH_GOOGLE_ID/SECRET`、`AUTH_APPLE_ID/SECRET` 後自動出現；登入只建立 session，不是身分根。

端到端測試（Chromium 虛擬 passkey，需 `npx playwright install chromium`）：`npm run e2e`（需 anvil + DemoFlow + `npm run dev` 或 `AUTH_DEV_LOGIN=1 npm start`）。

## 測試（67）

| 檔案 | 涵蓋 |
|---|---|
| `Identity.t.sol` | attestation 註冊 / 重放 / 未知簽章、到期仍可註銷、凍結、自然人轉出政策、recover |
| `Registry.t.sol` | 專案需法人、核發 metadata、序號重複、撤銷查驗機構、停用專案、註銷與 soulbound 憑證、批次凍結 |
| `Listing.t.sol` | 掛單成交與手續費、minFill、自然人不可掛單、未驗證不可買、取消、暫停、費率上限 |
| `Pool.t.sol` | 存入鑄幣、年份不符、自然人不可存、FIFO 跨批次贖回、指定贖回費與 1:1 backing、redeemAndRetire |
| `V4.t.sol` | 建池限 OPERATOR 與合法配對、LP 限法人、自然人買入、未驗證與非信任 Router 被擋、自然人不可賣出、每日限額、買入後註銷 |
| `Governance.t.sol` | 主權角色移轉、單方面撤銷營運角色、只有 admin 可升級、登錄層無升級路徑、registry 只能設一次 |
| `SafeGovernance.t.sol` | 真實 Safe v1.4.1 多簽簽章：移轉後 EOA 無角色；國家 Safe 2-of-3 即時凍結 / 暫停 / 撤換營運，單簽被拒；營運 Safe 不能凍結或給角色；升級與主權變更必須經 Timelock 48h，未到期執行失敗；只有國家 Safe 能提案 |
| `PasskeyAccount.t.sol` | 以 `vm.signP256` 組出完整 WebAuthn 斷言：relayer 代送購買與註銷、重放、竄改、錯誤金鑰、內部 revert、ERC-1271、factory 決定性 |

## 授權提醒

`lib/v4-core/src/PoolManager.sol` 為 **BUSL-1.1**（interfaces 與 `Hooks` library 為 MIT）。
本 repo 的 v4 模組僅供非生產展示；國家單位正式營運屬生產使用，需 Uniswap Additional Use Grant、等 Change Date、或改用自寫 AMM。
Phase 1 主市場為 `Listing`，不依賴 v4。

## 尚未包含（Phase 0 後續）

- ERC-4337 EntryPoint + paymaster（目前為 relayer 代送）
- Safe + TimelockController 治理接線（Phase 0 以 EOA 代替）
- 身分驗證服務：工商憑證 / 自然人憑證 / TW FidO 驗證後端（目前以簽章金鑰模擬）
- Besu + QBFT 四節點測試網（需啟用 Cancun / EIP-1153）
