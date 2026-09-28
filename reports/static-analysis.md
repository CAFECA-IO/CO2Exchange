# 靜態分析（2026-09-29，帳本合約）

舊的全合約版本（KYCRegistry、CarbonRegistry、CarbonCredit1155、Listing、CarbonPool、Bank、PasskeyAccount、
Uniswap v4 hook／router 等）已於第 7 期移除，這一份只涵蓋現在的 `src/`：

| 檔案 | nSLOC |
| --- | ---: |
| src/ledger/Ledger.sol | 244 |
| src/ledger/MerkleSumTree.sol | 72 |
| src/ledger/LedgerMerkle.sol | 17 |
| src/governance/GovernanceLib.sol | 36 |
| src/mocks/MockTWD.sol | 16 |

工具與完整輸出：

- Slither 0.11：`slither . --filter-paths "lib/|test/|script/" --exclude-dependencies --checklist` → `slither.md`
- Aderyn：`aderyn . --src src -o reports/aderyn.md` → `aderyn.md`

## 判讀

| 來源 | 發現 | 判讀 |
| --- | --- | --- |
| Slither incorrect-equality（3） | `escapeActive` / `escapeIn` 的 `at == 0`、`withdrawCash` 的 `pay == 0` | 不改。`at` 是最新一期的 `committedAt`，0 代表「還沒有任何承諾」，是狀態旗標不是餘額比較；`pay == 0` 只在逃生模式合約餘額為 0 時成立，此時 revert `NothingLeft` 是預期行為 |
| Slither timestamp（4） | 逃生門以 `block.timestamp` 判斷 72 小時 | 不改。逃生門本來就是時間條件；出塊者能挪動的秒數相對 72 小時可忽略 |
| Aderyn H-1 reentrancy（2） | `commit` 與 `withdrawCash` 在 `cash.balanceOf` 之後寫狀態 | 誤報。`balanceOf` 是 `view`（編譯為 STATICCALL），被呼叫方無法改狀態也無法重入；真正轉帳的 `safeTransfer` 在所有狀態寫入之後 |
| Aderyn L-1 centralization（8） | 角色權限 | 設計如此，並已移轉：主權角色在國家 Safe（2-of-3）、營運角色在營運 Safe、DEFAULT_ADMIN 在 48 小時 Timelock，部署者移轉後沒有任何權限（`test/LedgerGovernance.t.sol`）。逃生門沒有任何角色關得掉 |
| Aderyn L-2 shadowing（1） | `CommitInput.epoch` 與狀態變數 `epoch` 同名 | 不改。那是 struct 欄位，不是區域變數；名稱與鏈上事件、鏈下承諾程式一致 |
| Aderyn L-3 revert in loop（1） | `MerkleSumTree.computeRoot` 迴圈內 `parent()` 的加總溢位檢查（Solidity 0.8 內建） | 不改。證據任何一層不合法整筆都應該失敗；迴圈長度另有 255 的上限 |
| Aderyn L-4 unchecked return（5） | 建構子的 `_grantRole` 回傳值 | 不改。回傳值只表示「是否新授予」，建構子裡恆為 true |

沒有需要修改的發現。
