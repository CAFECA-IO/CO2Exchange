# 靜態分析與自查（2026-09-19）

工具：Slither 0.11.6（`slither . --filter-paths "lib/|test/|script/" --exclude-dependencies`），完整輸出在 `slither.md`。
Aderyn 0.6.8（`aderyn . --src src`）已於 2026-09-19 補跑，完整輸出在 `aderyn.md`，逐項判讀見下方。

## 依 Slither 結果做的修正

| 發現 | 修正 |
| --- | --- |
| `TrustedRouter._settle` 以 callback 資料中的 `user` 當 `transferFrom` 來源（arbitrary-send-erc20） | 新增 `_currentUser`：`swap` / `modifyLiquidity` 進入時記錄 `msg.sender`，`unlockCallback` 驗證 `d.user == _currentUser`，並以同一變數擋重入。原本已安全（callback 資料由 Router 自己編碼），此為縱深防禦 |
| `Listing` / `CarbonPool` treasury、`CarbonCredit1155.setRegistry` 無零位址檢查 | 加 `ZeroAddress` revert |
| `CarbonPool._takeFifo` 迴圈外部呼叫無上限（calls-loop） | 加 `MAX_BATCHES_PER_REDEEM = 20`，超過回 `TooManyBatches`，請分次贖回 |
| 事件位址參數未 indexed | `RegistrySet`、`TrustedRouterSet`、`TokenClassified` 改 indexed |
| 未初始化區域變數 | 明確 `= 0` |
| （自查）`KYCRegistry.register` 可覆寫系統合約身分 | 目標帳戶為 `SystemContract` 時 revert `InvalidTier` |

## 保留不改的發現（已評估）

| 偵測器 | 位置 | 理由 |
| --- | --- | --- |
| arbitrary-send-eth | `PasskeyAccount.execute` | 智能帳戶本意；每筆都經 WebAuthn 簽章與 nonce 驗證 |
| arbitrary-send-erc20 | `TrustedRouter._settle` | 見上方修正；`user` 必為發起交易者 |
| reentrancy-no-eth | `TrustedRouter.swap` / `modifyLiquidity` | `_currentUser` 是互斥鎖，先設後清是預期模式；重入會被 `Reentrancy()` 擋下 |
| divide-before-multiply | `Listing.buy` 手續費、`CarbonRegistry._yearOf` | 費用捨入誤差 ≤ 1 個最小單位且對買方有利；`_yearOf` 為 civil-from-days 演算法 |
| unused-return | `EnumerableSet.add/remove`、`poolManager.settle`、`modifyLiquidity` 的 feesAccrued | 回傳值無決策用途 |
| missing-zero-check | `CarbonKYCHook.setTrustedRouter` | `address(0)` 是刻意的 swap 開關（見治理手冊 kill-swaps） |
| calls-loop | `redeem` / `redeemAndRetire`（已加上限）、`recover`（recoverableTokens 固定 2 個）、`PasskeyAccount.execute`（批次呼叫本意） | 有上限或由使用者自行承擔 gas |
| reentrancy-events | 事件在外部呼叫後發出 | 只影響事件順序，不影響狀態 |
| timestamp | attestation deadline、KYC 效期、Router deadline | 秒級容差可接受 |
| low-level-calls / too-many-digits / unindexed-event-address（其餘） | — | 資訊性 |


## Aderyn 0.6.8（2026-09-19 補跑）

88 個偵測器掃 16 個檔案、1,499 nSLOC。初次結果 4 High + 12 Low，逐項判讀後**只有一項需要改**。

### 改了

| 發現 | 位置 | 處理 |
| --- | --- | --- |
| L-6 `nonReentrant` 不是第一個 modifier | `CarbonPool` 4 處、`Listing` 2 處 | 改成 `nonReentrant whenNotPaused`。這裡沒有實際風險（`whenNotPaused` 只讀狀態、不做外部呼叫），但慣例存在是為了避免哪天前面插進一個會外呼的 modifier；交出去之前照慣例排好，省得再被提一次。改完重跑 80 個測試全過，`.gas-snapshot` 已更新 |

### High：四項都是誤報或既有設計

| 發現 | 位置 | 判讀 |
| --- | --- | --- |
| H-1 `abi.encodePacked()` 雜湊碰撞 | `PasskeyAccountFactory:20` | CREATE2 的 init-code hash：`creationCode`（編譯期常數）接 `abi.encode(qx, qy)`（固定 64 bytes），無法構造碰撞。salt 本身用的是 `abi.encode` |
| H-1 | `RetirementCertificate:93,109` | `tokenURI` 組 JSON 字串用的，沒有餵進雜湊函式 |
| H-2 合約鎖住 ETH 沒有提領函式 | `KYCRegistry`、`CarbonCreditToken`、`CarbonPool`、`Listing` | 這四個是 UUPS，OZ 的 `upgradeToAndCall` 宣告為 `payable`，偵測器因此認為合約收得到 ETH。只有升級權限者（Timelock，其後是國家 Safe）能在升級時附帶 value，而且得是刻意為之。**接受，但記在這裡**：這四個合約沒有提領路徑，升級時不要帶 value |
| H-3 轉 ETH 未檢查位址 | `PasskeyAccount:48` | 智能帳戶的本意；每一筆 `call{value:}` 都經過 WebAuthn 簽章與 nonce 驗證 |
| H-4 外部呼叫後才改狀態（10 處） | `CarbonPool` 3、`Listing` 2、`CarbonCredit1155` 1、`CarbonRegistry` 1、`CarbonKYCHook` 1、`TrustedRouter` 2 | `CarbonPool` / `Listing` 全部帶 `nonReentrant`；`TrustedRouter` 有 `_currentUser` 互斥鎖（Slither 那輪加的）；`CarbonCredit1155.retire` 沒有 guard，但遵守 CEI——`_burn`、`b.retiredKg += ...` 都在 `certificate.mint()` 之前，而 `RetirementCertificate.mint` 也是先寫 `_certs[certId]`、`nextId++` 才 `_safeMint`，回呼進來時狀態已經落定，重入只會是一筆要自行通過餘額檢查的新 retire |

### Low：其餘 11 項

多數是風格或資訊性：L-11「未檢查回傳值」全部是初始化階段的 `_grantRole`（在全新 storage 上必回 true）；L-1 中心化風險即本系統的治理設計（見治理手冊）；L-3 空區塊是 `receive()` 與 UUPS 的 `_authorizeUpgrade`；L-2/L-10 迴圈內的成本在已加上限的 `redeem` 路徑上。逐項理由沿用上一節「保留不改的發現」的判斷標準：**會影響資產或權限的才改，其餘記錄理由**。

### 與 Slither 的重疊

兩個工具指到的位置高度重疊（重入、arbitrary send、迴圈內外部呼叫），Aderyn 多抓到的是 modifier 順序與 `abi.encodePacked` 這類慣例問題。沒有任何一項指向 Slither 那輪沒看過的合約邏輯。

## Fuzz / invariant（`test/Fuzz.t.sol`、`test/Invariant.t.sol`）

見該檔案註解；`forge test` 一併執行。

## Gas

`forge test --gas-report` 輸出在 `gas-report.md`；`.gas-snapshot` 供 CI 比對回歸。
