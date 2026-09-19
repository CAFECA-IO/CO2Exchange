# CO2Exchange — 減量額度登錄、交易與註銷平台（Phase 0）

企業完成 ISO 14064-2 減量、14064-3 第三方查驗後，由查驗機構在鏈上簽章核發減量額度；
額度可掛單販售給個人、機構或其他企業，買方註銷後取得可附於申報文件的憑證。
由 CAFECA 建置，設計為控制權可完整移轉給國家單位、CAFECA 代運營。

架構決策、風險與分期紀錄於 Claude project `CO2Exchange › claude/architecture-decisions.md`。

## 分層

```
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

角色：`DEFAULT_ADMIN`（升級、角色管理）與 `SOVEREIGN_ROLE`（認可查驗機構 / 身分驗證服務、凍結、系統合約登錄）屬國家單位；
`OPERATOR_ROLE`（暫停、手續費、recover、hook 設定）屬 CAFECA，可被國家單位單方面撤銷。移轉當天只是 `grantRole` / `renounceRole`。

## 安裝

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # 需 forge ≥ 1.0，solc 0.8.26 會自動下載
git submodule update --init --recursive
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

## 測試（49）

| 檔案 | 涵蓋 |
|---|---|
| `Identity.t.sol` | attestation 註冊 / 重放 / 未知簽章、到期仍可註銷、凍結、自然人轉出政策、recover |
| `Registry.t.sol` | 專案需法人、核發 metadata、序號重複、撤銷查驗機構、停用專案、註銷與 soulbound 憑證、批次凍結 |
| `Listing.t.sol` | 掛單成交與手續費、minFill、自然人不可掛單、未驗證不可買、取消、暫停、費率上限 |
| `Pool.t.sol` | 存入鑄幣、年份不符、自然人不可存、FIFO 跨批次贖回、指定贖回費與 1:1 backing、redeemAndRetire |
| `V4.t.sol` | 建池限 OPERATOR 與合法配對、LP 限法人、自然人買入、未驗證與非信任 Router 被擋、自然人不可賣出、每日限額、買入後註銷 |
| `Governance.t.sol` | 主權角色移轉、單方面撤銷營運角色、只有 admin 可升級、登錄層無升級路徑、registry 只能設一次 |

## 授權提醒

`lib/v4-core/src/PoolManager.sol` 為 **BUSL-1.1**（interfaces 與 `Hooks` library 為 MIT）。
本 repo 的 v4 模組僅供非生產展示；國家單位正式營運屬生產使用，需 Uniswap Additional Use Grant、等 Change Date、或改用自寫 AMM。
Phase 1 主市場為 `Listing`，不依賴 v4。

## 尚未包含（Phase 0 後續）

- Passkey smart account + ERC-4337 paymaster、Next.js 前端（登入 / KYC / 購買並註銷 / 我的憑證）
- Safe + TimelockController 治理接線（Phase 0 以 EOA 代替）
- 身分驗證服務：工商憑證 / 自然人憑證 / TW FidO 驗證後端（目前以簽章金鑰模擬）
- Besu + QBFT 四節點測試網（需啟用 Cancun / EIP-1153）
