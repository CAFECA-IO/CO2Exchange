# CO2Exchange 證明檔與雜湊規則

本文件是 CO2Exchange 帳本（設計 v4、規則第 3 版）證明檔的完整規格。對象是任何想獨立驗證的人，包括 Boltchain Explorer（[Issue #1](https://github.com/Luphia/Boltchain/issues/1)）、主管機關、查核機構與使用者本人。

參考實作是 `web/scripts/verify-proof.mjs`。它只用 viem，不引用交易所的任何程式碼：

```
node web/scripts/verify-proof.mjs <證明檔.json> --rpc <任一節點> [--out 報告.json]
```

## 一、鏈上的錨點

每一期承諾是帳本合約發出的一筆事件：

```solidity
struct CommitInput {
    bytes32 prev; uint64 epoch;
    bytes32 logRoot; bytes32 balanceRoot; bytes32 registryRoot; bytes32 identityRoot;
    uint256 totalKg; uint256 totalCash; bytes32 totalsHash;
    uint64 upToBlock; uint64 lastSeq; uint16 rulesVersion;
}
event Committed(uint64 indexed epoch, bytes32 anchor, CommitInput commitment);
```

證明檔裡每一項證據都帶一個 `anchor`：

```json
{ "contract": "0x…帳本合約", "event": "Committed(uint64,bytes32,(bytes32,uint64,bytes32,bytes32,bytes32,bytes32,uint256,uint256,bytes32,uint64,uint64,uint16))",
  "txHash": "0x…", "logIndex": 3, "blockNumber": "27126", "epoch": "2", "field": "commitment.balanceRoot", "root": "0x…" }
```

驗證者要自己回鏈上取 `txHash` 的收據，找到 `logIndex` 那個 log，確認發出者是 `contract`，解碼後取 `field`。檔案裡寫的 `root` 只是方便閱讀，**不能拿來比**。

## 二、三種雜湊規則

以下 `abi.encode` 與 `abi.encodePacked` 都是 Solidity 的定義。

### `co2x-keccak-abi-prefixed-v1`：事件、登錄簿、身分

```
leaf = keccak256(abi.encode(bytes1 0x00, bytes32 contentHash))
node = keccak256(abi.encode(bytes1 0x01, bytes32 left, bytes32 right))
```

- 葉子依序排列，不排序也不去重。
- 某一層節點數為奇數時，落單的那一個直接帶到上一層，不補假葉子。
- `path` 是整數位元圖：第 i 位為 1，代表第 i 個兄弟在左邊。
- 帶上去的那一層沒有兄弟，也不佔 `path` 的位元。
- 空樹的 root 是 `keccak256(abi.encode(bytes1 0x02, "co2x.empty"))`。

`contentHash` 的算法：

| 證據 | 內容 |
|---|---|
| 事件（`logRoot`） | `keccak256(encoded)`。`encoded` 是事件的正規化編碼 `abi.encode(uint16 version, uint8 kind, uint64 seq, uint64 at, uint64 atBlock, bytes payload, address signer, bytes signature)`，證明檔直接附上整段 |
| 身分（`identityRoot`） | `keccak256(abi.encode(address account, uint8 tier, uint64 expiry, bytes2 jurisdiction, bytes32 identityHash, bool frozen))`；型別與值附在 `content` |
| 批次（`registryRoot`） | `keccak256(abi.encode(uint8 3, uint256 id, uint256 projectId, uint64 monitoringStart, uint64 monitoringEnd, uint16 vintageYear, bytes32 serialHash, bytes32 reportHash, address verifier, uint64 issuedAt, uint256 issuedKg, uint256 retiredKg, bool frozen))` |

### `co2x-merkle-sum-v2`：託管（餘額總額樹）

```
leaf.hash = keccak256(abi.encodePacked(bytes1 0x00, address account, uint64 epoch, bytes32 assetsRoot,
                                       uint256 kg, uint256 cash, uint256 requested, uint256 settled))
leaf.kg = kg;  leaf.cash = cash
node.hash = keccak256(abi.encodePacked(bytes1 0x01, l.hash, l.kg, l.cash, r.hash, r.kg, r.cash))
node.kg = l.kg + r.kg;  node.cash = l.cash + r.cash
```

- 形狀規則（落單往上帶、`path` 位元圖）與上一種相同。
- 算回的 root 要同時滿足三件事：`hash == balanceRoot`、`kg == totalKg`、`cash == totalCash`。
- 葉子欄位的意義：
  - `cash`：帳本在這一期欠這個帳戶的結算幣，含可動用、掛單鎖定與待提領。
  - `requested`：提領請求的累計總額，只增不減。
  - `settled`：已在鏈上領回的累計總額，只增不減。
- 託管對照：root 的 `cash` 不得大於 `ERC20(settlementToken).balanceOf(帳本合約)`。
  - Boltchain 只保留最近 128 個區塊的狀態，所以只能讀現在的持有，不能讀承諾那一塊的。

### `co2x-asset-packed-v1`：帳戶的逐批次小樹

```
leaf = keccak256(abi.encodePacked(bytes1 0x00, uint256 batchId, uint256 kg))
node = keccak256(abi.encodePacked(bytes1 0x01, bytes32 left, bytes32 right))
```

- 葉子依 `batchId` 由小到大排列。
- 算回的 root 要等於託管葉子裡的 `assetsRoot`。

## 三、證明檔

```json
{
  "version": 1, "chainId": 8018, "generator": "CO2Exchange ledger v2 (rules 3)",
  "account": "0x…", "latestEpoch": "12", "schemes": { … },
  "proofs": [
    { "type": "custody",  "scheme": "co2x-merkle-sum-v2", "anchor": { …balanceRoot }, "leaf": { … }, "siblings": [{ "hash", "kg", "cash" }], "path": "5", "custody": { "token", "holder" } },
    { "type": "credit",   "batchId": "3", "holding": { "scheme": "co2x-asset-packed-v1", … }, "registry": { "scheme": "co2x-keccak-abi-prefixed-v1", "anchor": { …registryRoot }, "content": { "types", "values" }, … } },
    { "type": "identity", "scheme": "co2x-keccak-abi-prefixed-v1", "anchor": { …identityRoot }, "content": { "types", "values" }, … },
    { "type": "event",    "scheme": "co2x-keccak-abi-prefixed-v1", "anchor": { …logRoot（該事件所屬那一期） }, "encoded": "0x…", "contentHash": "0x…", "event": { … }, … }
  ],
  "contractArgs": { "withdrawCash": { "proof": { … } }, "claimCredits": { "<batchId>": { … } } }
}
```

- 整數一律是十進位字串。
- 兄弟節點只是雜湊，總額樹另帶兩個加總，**不含其他帳戶的任何資料**。
- `contractArgs` 是帳本合約 `withdrawCash`／`claimCredits` 要的參數，錢包可以直接送。

## 四、公開檔（每一期）

`web/data/public/epochs/<期別>.json`，也可以從 `GET /api/public/epochs/<期別>` 取得。

| 欄位 | 內容 | 怎麼驗 |
|---|---|---|
| `manifest` | 這一期的承諾與交易 | 對鏈上的 `Committed` |
| `leaves` | 這一期每一筆事件的雜湊，依序號排列 | 依 `co2x-keccak-abi-prefixed-v1` 重建，應得 `logRoot` |
| `publicEvents` | 登錄簿層事件的全文與包含證據 | 同上 |
| `registry.leaves` | 登錄簿每一片葉子的內容雜湊，依樹的順序排列 | 依同一規則重建，應得 `registryRoot` |
| `totals` | 逐批次總量表 | `totalsHash` 的原文 |

- 公開全文的事件：轄區、政策、費率、專案、核發、註銷、憑證、對帳報告、批次凍結。
- 只公開雜湊的事件：委託單、身分、存提、提領請求、金鑰鏡像、帳戶凍結。這些的全文在監理鏡像裡。

## 五、監理鏡像

完整帳本匯出方式：

```
npm run ledger:publish -- --mirror <目錄>
```

- 內容：`ledger/events.jsonl`、`ledger/head.json`、`deployment.json`、`MANIFEST.json`（附 SHA-256 清單）。
- 收到的人自己重播驗證：

```
LEDGER_DIR=<目錄>/ledger DEPLOYMENT_FILE=<目錄>/deployment.json RPC_URL=<任一節點> npm run ledger:verify
```

## 六、提領（規則第 3 版）

1. 使用者在帳本裡簽 `RequestWithdrawal(account, amount, nonce)`。帳本把那筆錢從可動用移到待提領，之後不能再交易。
2. 下一期承諾上鏈之後，他憑最新一期的託管證據呼叫 `withdrawCash`。
   - 一般模式的上限是 `leaf.requested − withdrawnTotal[account]`。
   - 逃生模式（72 小時沒有新承諾）的上限是 `leaf.cash + leaf.settled − withdrawnTotal[account]`。
3. 鏈上的 `CashWithdrawn` 鏡像進帳本，先從待提領銷帳，超出的部分（只可能是逃生提領）從可動用扣。

`withdrawnTotal` 是合約記的累計總額，不分期別。所以換了幾期、鏡像晚了幾個區塊都一樣，同一筆錢不會領到第二次。
