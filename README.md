# CO2Exchange — 碳權交易所（Phase 0）

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
forge script script/DeployV4.s.sol   --rpc-url anvil --broadcast                # 只部署（含 v4）
forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()" # 部署 + 完整流程
```

`DemoFlowV4` 用 Anvil 預設帳戶：account0 = 國家單位 / 營運 / 身分驗證服務 / 查驗機構（Phase 0 合一），
account1 = 減量企業，account2 = 做市商，account3 = 自然人。流程：憑證 attestation 註冊 → 專案登錄 →
查驗簽章核發 100 噸 → 30 噸掛單、60 噸入池、做市商提供 v4 流動性 → 自然人從掛單與 v4 各買一次 → 兩邊註銷取得憑證。

### 四支部署腳本

v4 的編譯期相依已經從核心拆出去，所以「要不要 v4」是選腳本，不是設旗標：

| 腳本 | 內容 | 需要 Cancun |
|---|---|---|
| `Deploy.s.sol` | 核心：登錄、身分、Listing、池化、憑證、Safe + Timelock、passkey 帳戶工廠 | 否 |
| `DeployV4.s.sol` | 核心 + v4（PoolManager / Hook / TrustedRouter） | 是 |
| `DemoFlow.s.sol` | 核心 demo（沒有 v4 時，做市商直接轉 CCT 給自然人，贖回 / 註銷流程照跑） | 否 |
| `DemoFlowV4.s.sol` | 核心 demo + v4 流動性與 swap | 是 |

用 `Deploy.s.sol` 時部署檔裡 v4 的三個地址會是 0，前端據此自動隱藏 v4 相關 UI
（`/trade` 的流動性池卡片、`/admin` 的 PoolManager 狀態）。

## 部署到既有的私有鏈

不是 Anvil、而是已經在跑的鏈（自建 Besu / geth 系私有鏈等），先跑部署前檢查：

```bash
./script/preflight.sh http://127.0.0.1:20024
```

它會檢查五件事並直接印出該用哪道部署指令：

| 檢查 | 為什麼重要 |
|---|---|
| chainId | 決定部署檔寫到 `deployments/<chainId>.json`，前端 `CHAIN_ID` 要對上 |
| **EIP-1153（TSTORE）** | Uniswap v4 `PoolManager` 的硬需求。缺了就改用 `Deploy.s.sol` |
| **EIP-5656（MCOPY）** | `evm_version = cancun` 編出來的碼會用到。缺了整條鏈都跑不了，見下方 |
| EIP-1559 | 沒有 `baseFeePerGas` 的鏈，`forge script` 要加 `--legacy` |
| 部署者餘額 | 私有鏈上 Anvil 預設金鑰是 0 餘額，要設 `DEPLOYER_PK` |

```bash
export RPC_URL=http://127.0.0.1:20024
export DEPLOYER_PK=0x<這條鏈上有餘額的私鑰>
forge script script/DeployV4.s.sol --rpc-url chain --broadcast  # 鏈支援 Cancun
forge script script/Deploy.s.sol   --rpc-url chain --broadcast  # 鏈沒有 EIP-1153
```

前端接上去：`web/.env.local` 設 `RPC_URL` / `CHAIN_ID`，並確認 `RELAYER_PK`、`DOCUMENT_SIGNER_PK`
在那條鏈上**有餘額** —— Phase 0 由平台代付 gas，沒錢的話建帳戶與註銷都會失敗。

### 目標鏈沒有 Cancun 的話

比 Cancun 舊的鏈（例如 geth 1.12.x）連核心合約都跑不了，不只是少掉 v4：
`evm_version = cancun` 編出來的碼會用到 MCOPY。要降到 `evm_version = shanghai` 重編，
而那條路目前卡在一個點上（`foundry.toml` 的 `[profile.shanghai]` 有完整紀錄）：

- `via_ir = false` → `Listing`、`CarbonPool`、`CarbonRegistry`、`CarbonCredit1155`、
  `RetirementCertificate` 五個全部 stack too deep。沒有 MCOPY 時 solc 的記憶體搬移碼比較吃堆疊，
  這是系統性的，不是某個函式區域變數太多。
- `via_ir = true` → 上面五個都過，只剩 Safe v1.4.1 的 `execTransaction` 編不過
  （Safe 的 inline assembly 沒標 memory-safe，是 Safe 已知的 via_ir 問題）。

所以唯一的阻塞點是 Safe。解法是不要編譯 Safe，改用 Safe v1.4.1 的 canonical creation bytecode
直接 CREATE —— 官方版本是 solc 0.7.6 編的，本來就不含 Cancun 指令，而且部署出來的 Safe
會與已稽核的版本位元組完全一致。**尚未實作**（Phase 0 決定留在 Anvil）。

**Phase 1 的 Besu 必須在 genesis 啟用 Cancun**，否則會撞上同一面牆。

## 前端（web/，Next.js 16 + React 19）

四種角色、七個頁面：

| 角色 | 頁面 | 內容 |
|---|---|---|
| 自然人 / 法人 | `/`、`/kyc`、`/trade`、`/certificates` | 登入 → passkey 建帳戶 → 身分驗證申請 → 購買（掛單 / v4 池）→ 註銷 → 憑證（含 PDF 下載） |
| 法人 | `/enterprise` | 登錄專案、上傳 ISO 14064-3 查驗報告申請核發、批次掛單 / 入池、取消掛單 |
| 查驗機構（`VERIFIER_EMAILS`） | `/verifier` | 待查驗佇列：檢視報告與雜湊 → 簽署 IssuanceAttestation 核發，或退回 |
| 管理員（`ADMIN_EMAILS`） | `/admin` | KYC 審核佇列（核准 = 簽 attestation 上鏈）、憑證 PDF 產生與 `documentHash` 回寫、治理狀態（角色矩陣、Safe、Timelock 排程） |

`KYC_AUTO_APPROVE=1` 時申請直接核准（demo）；`0` 時進管理後台佇列——**這時 `ADMIN_EMAILS` 必須包含你自己登入用的 email**，
否則申請會卡在沒有人能核准的佇列裡（要走查驗核發那條線同理，`VERIFIER_EMAILS` 也要加）。憑證 PDF 用 `fonts/NotoSansTC-Subset.otf`（Big5 常用字子集），
檔案 SHA-256 由 `DOCUMENT_SIGNER_PK`（`DOCUMENT_ROLE`）回寫鏈上，任何人可重算比對。

```bash
# 終端 1
anvil
# 終端 2：部署 + 種子資料
forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"
# 終端 3
cd web && cp .env.example .env.local && npm install && npm run dev
# 開 http://localhost:3000
```

錢包架構：`PasskeyAccount`（P-256 passkey 是唯一擁有者，地址由公鑰經 CREATE2 決定，換裝置不變）。
Phase 0 交易由平台 relayer 代送 `execute`（`/api/relay`，gas 由平台付），授權來自使用者的 WebAuthn 簽章，relayer 無法竄改內容；
Phase 1 換成 ERC-4337 EntryPoint + paymaster，帳戶簽章格式與 nonce 語意不變。

Apple / Google 登入：在 `.env.local` 設 `AUTH_GOOGLE_ID/SECRET`、`AUTH_APPLE_ID/SECRET` 後自動出現；登入只建立 session，不是身分根。

端到端測試（Chromium 虛擬 passkey，需 `npx playwright install chromium`）：`npm run e2e` 跑兩條流程 ——
`e2e/flow.mjs`（自然人：KYC 人工核准 → 購買 → 註銷 → 管理員產生 PDF 並回寫 → 下載）與
`e2e/enterprise.mjs`（法人 KYC → 專案登錄 → 上傳報告 → 查驗核發 → 掛單 + 入池 → 另一自然人購買並註銷）。需 anvil + DemoFlowV4 + `KYC_AUTO_APPROVE=0` 的伺服器。

### 重新部署之後（`web/data/` 的舊紀錄）

`web/data/` 裡的 KYC 申請、核發申請、passkey 對照都是用**帳戶地址**當鍵的，而地址是合約部署的產物。
鏈重開、換鏈、或 factory 重新部署之後，那些鍵在新鏈上對不到任何東西——資料讀得出來、畫面也畫得出來，錯得無聲無息。

所以資料夾裡壓了一張 `.deployment.json` 戳記，記下這批資料屬於哪一**次**部署：chainId、七個決定身分的合約地址的雜湊，
再加上部署檔裡的 `deployedAt`（`vm.unixTime()`，主機時鐘毫秒）。`poolFee` 這種不影響舊紀錄的參數不計入。

`deployedAt` 不是多餘的——**Anvil 重開後重新部署會產生一模一樣的地址**（同一個部署者、同樣的 nonce 順序，實測七個全同）。
只比對地址的話，鏈重開這件事完全看不出來，但鏈上狀態已經歸零：本機寫著「已核准」的 KYC 紀錄，
對應帳戶在新鏈上 `identityOf` 回 tier 0。加上 `deployedAt` 之後這種情況才擋得到。對不上時：

- **申請與憑證紀錄**（`kyc-requests`、`issuance-requests`）直接擋下，API 回 `503 DATA_STALE`，訊息說明怎麼處理。
  這些是證據，不該悄悄拿舊的來用。
- **`accounts.json`**（credentialId → 帳戶地址）不擋。那個地址是 CREATE2 從 factory + passkey 公鑰算出來的，**可以重算**，
  舊對照當作不存在，前端重新註冊一次就拿到新地址（`AccountProvider` 的自動重綁）。硬擋反而會讓自動重綁失效。

確認舊資料不用了：

```bash
cd web && npm run data:reset   # 搬到 data.bak-<時間戳>，不是刪除
```

備份裡有上傳的身分文件，確認不需要再自行刪除。想把兩個部署的資料分開留著，設 `DATA_DIR` 指到不同資料夾即可。

## 測試（80）

| 檔案 | 涵蓋 |
|---|---|
| `Identity.t.sol` | attestation 註冊 / 重放 / 未知簽章、到期仍可註銷、凍結、自然人轉出政策、recover |
| `Registry.t.sol` | 專案需法人、核發 metadata、序號重複、撤銷查驗機構、停用專案、註銷與 soulbound 憑證、批次凍結 |
| `Listing.t.sol` | 掛單成交與手續費、minFill、自然人不可掛單、未驗證不可買、取消、暫停、費率上限 |
| `Pool.t.sol` | 存入鑄幣、年份不符、自然人不可存、FIFO 跨批次贖回、指定贖回費與 1:1 backing、redeemAndRetire |
| `V4.t.sol` | 建池限 OPERATOR 與合法配對、LP 限法人、自然人買入、未驗證與非信任 Router 被擋、自然人不可賣出、每日限額、買入後註銷 |
| `Governance.t.sol` | 主權角色移轉、單方面撤銷營運角色、只有 admin 可升級、登錄層無升級路徑、registry 只能設一次 |
| `Registry.t.sol`（新增） | `DOCUMENT_ROLE`：只有文件服務金鑰能回寫 PDF hash，營運可更換該金鑰 |
| `SafeGovernance.t.sol` | 真實 Safe v1.4.1 多簽簽章：移轉後 EOA 無角色；國家 Safe 2-of-3 即時凍結 / 暫停 / 撤換營運，單簽被拒；營運 Safe 不能凍結或給角色；升級與主權變更必須經 Timelock 48h，未到期執行失敗；只有國家 Safe 能提案 |
| `PasskeyAccount.t.sol` | 以 `vm.signP256` 組出完整 WebAuthn 斷言：relayer 代送購買與註銷、重放、竄改、錯誤金鑰、內部 revert、ERC-1271、factory 決定性 |
| `Fuzz.t.sol`（新增） | 隨機化屬性測試（`bound()`）：掛單成交金額/手續費/庫存正確、minFill 強制、池 backing 恆等、FIFO 先進先出順序、KYC 轉帳規則、註銷不可超過核發量、WebAuthn 邊界（篡改/重放）攻擊被拒 |
| `Invariant.t.sol`（新增） | Handler-based invariant：256 runs × 500 calls（存入/贖回/指定贖回/贖回註銷隨機序列）驗證池子 1:1 backing、CCT 供給量、資產守恆、`ghostRetiredKg` 追蹤與鏈上註銷量一致，全程 0 revert |

## 自我審查（Self-review / Audit Prep）

正式第三方稽核前的內部檢查，供未來稽核方與國家單位承接時參考：

- **靜態分析**：Slither 與 Aderyn 0.6.8 都跑過。
  6 項具體修正（`TrustedRouter` 重入/callback 完整性防護、多處零地址檢查、`CarbonPool` 單次贖回批次數上限、
  event 補 indexed、區域變數顯式初始化、`KYCRegistry` 防止系統合約 tier 被覆寫），修正後 34 項殘留發現逐項附理由。
  Aderyn 4 High + 12 Low 逐項判讀後只改一項（`nonReentrant` 排到第一個 modifier，6 處），其餘是誤報或既有設計。
  詳見 [`reports/static-analysis.md`](reports/static-analysis.md)（原始輸出於 [`reports/slither.md`](reports/slither.md)、
  [`reports/aderyn.md`](reports/aderyn.md)）。
- **Fuzz / Invariant 測試**：見上方測試表 `Fuzz.t.sol`、`Invariant.t.sol`。
- **Gas 報告**：`forge test --gas-report` 全量輸出、按生命週期分組的關鍵操作耗用、部署成本，以及
  production profile（`via_ir`）的實測比較——執行期呼叫便宜 3–8%，但 bytecode 全面變大、部署變貴，合計 +3.3%，
  見 [`reports/gas-report.md`](reports/gas-report.md)；
  `.gas-snapshot`（`forge snapshot`）已提交，CI 或發版前可用 `forge snapshot --check` 偵測非預期的 gas 迴歸
  （執行時排除 fuzz/invariant：`--no-match-contract "FuzzTest|PoolInvariantTest"`）。
- **尚未涵蓋**：正式第三方合約稽核、形式驗證（如 Certora）、經濟/賽局面攻擊面分析、跨合約 MEV/夾單分析、
  正式 bug bounty。這些屬 Phase 1/2 範疇，見下方「尚未包含」與 project 文件的分期規劃。

## 授權提醒

`lib/v4-core/src/PoolManager.sol` 為 **BUSL-1.1**（interfaces 與 `Hooks` library 為 MIT）。
本 repo 的 v4 模組僅供非生產展示；國家單位正式營運屬生產使用，需 Uniswap Additional Use Grant、等 Change Date、或改用自寫 AMM。
Phase 1 主市場為 `Listing`，不依賴 v4。

## 尚未包含（Phase 0 後續）

- ERC-4337 EntryPoint + paymaster（目前為 relayer 代送）
- 查驗機構自行簽章（目前簽章金鑰在本站 `CARBON_VERIFIER_PK`）
- 身分驗證服務：工商憑證 / 自然人憑證 / TW FidO 驗證後端（目前以簽章金鑰模擬）
- Besu + QBFT 四節點測試網（需啟用 Cancun / EIP-1153）
