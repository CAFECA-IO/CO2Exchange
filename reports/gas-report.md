# Gas Report — 帳本合約（設計 v4）

產生日期：2026-09-29
工具：Foundry（forge 1.5.1）、solc 0.8.26、`evm_version = cancun`、預設 profile（`via_ir = false`）

```bash
forge test --gas-report
```

鏈上只剩帳本合約（`src/ledger/Ledger.sol`）、治理（Safe v1.4.1 + OpenZeppelin Timelock）與展示用的 MockTWD。
營運上會反覆付的只有兩筆：每小時一次的 `commit`，以及使用者自己付的存入與領回。

## 部署

| 合約 | 部署 gas | Bytecode |
| --- | ---: | ---: |
| Ledger | 2,356,406 | 11,011 bytes |

整套部署（Safe 基礎設施、兩個 Safe、Timelock、Ledger、授權清單）實測約 1,340 萬 gas。
`bootstrap.sh` 預設 `DEPLOY_GAS=20000000` 撥款。

## 經常性操作

| 函式 | 誰付 | 中位數 | 最高 | 說明 |
| --- | --- | ---: | ---: | --- |
| `commit` | 承諾提交者（RELAYER_PK） | 232,076 | 265,545 | 每小時一期；`bootstrap.sh` 以 `COMMIT_GAS=270000` 估撥款 |
| `depositCash` | 使用者 | 58,445 | 58,445 | 另加結算幣的 `approve` |
| `withdrawCash` | 使用者 | 68,015 | 103,262 | 證據深度越深越貴 |
| `claimCredits` | 使用者 | 59,957 | 83,623 | 逃生模式或提領開啟時登記碳權請求權 |

## 治理

| 函式 | 中位數 | 最高 |
| --- | ---: | ---: |
| `grantAuthority` | 48,871 | 48,871 |
| `revokeAuthority` | 26,989 | 26,989 |
| `setThreshold` | 24,546 | 48,142 |
| `setWithdrawalsEnabled` | 47,162 | 47,162 |

以上是合約本身的執行成本，不含 Safe 的 `execTransaction` 外層（約再加 3–5 萬 gas）。
正式部署前請以 `FOUNDRY_PROFILE=production forge test --gas-report` 重新量測。
