# 靜態分析與自查（2026-09-19）

工具：Slither 0.11.6（`slither . --filter-paths "lib/|test/|script/" --exclude-dependencies`），完整輸出在 `slither.md`。
Aderyn 0.6.8 已安裝，但需連線 binaries.soliditylang.org 下載 solc，本環境無法；在可連網環境執行 `aderyn . --src src/`。

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

## Fuzz / invariant（`test/Fuzz.t.sol`、`test/Invariant.t.sol`）

見該檔案註解；`forge test` 一併執行。

## Gas

`forge test --gas-report` 輸出在 `gas-report.md`；`.gas-snapshot` 供 CI 比對回歸。
