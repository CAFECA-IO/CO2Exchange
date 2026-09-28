# TideBit-DeFi 碳權交易所

國家級減量額度的**登錄、交易與註銷**平台。企業完成 ISO 14064-2 減量、14064-3 第三方查驗後，
由查驗機構以自己的金鑰簽章核發額度；額度可販售給個人、機構或其他企業，買方註銷後取得可附於申報文件的憑證。

由卡菲卡金融科技股份有限公司（CAFECA）建置，**設計為控制權可完整移轉給國家單位、由 CAFECA 代運營**。
目前是 **Phase 0**：功能完整、可以從頭走到尾，但身分驗證與查驗簽章是模擬的。

目標鏈是 **Boltchain 8018**（CAFECA 的身分合約在那裡，交易所要同鏈）。**使用者的錢是信託專戶裡的真新台幣**：
入金是匯款、出金是匯款，鏈上只有帳本合約自己建立的記帳 TWD（不能轉出，作為審計數據）。
登入是**以 CAFECA 登入**（EIP-712 SignIn + ERC-1271）。anvil 只出現在本機開發與自動測試。

| 你是誰 | 從哪裡開始 |
|---|---|
| 想知道這是什麼 | [一、這是什麼](#一這是什麼) |
| 要在本機跑起來 | [三、本機開發](#三本機開發) |
| 要部署到 Boltchain | [四、部署到外部鏈](#四部署到外部鏈boltchain-8018) |
| 要營運 | [五、日常營運](#五日常營運) |
| 要驗證本站沒有作弊 | [六、自己驗證](#六自己驗證) |
| 東西壞了 | [八、出問題怎麼修](#八出問題怎麼修) |
| 要接手維護 | [九、設計說明](#九設計說明) |

---

## 一、這是什麼

一套可以完整走完「額度從哪裡來 → 誰買走了 → 誰用掉了 → 憑證長什麼樣」的系統，
而且每一步都留下**任何人都能自己驗一次**的紀錄。

### 設計 v4：鏈上只放證據

| 在哪裡 | 放什麼 |
|---|---|
| **鏈上**（`src/ledger/Ledger.sol`） | 每小時一期的**承諾**（事件 log root、帶總額的餘額樹 root、登錄簿 root、身分 root、逐批次總量雜湊），前後串連；**授權金鑰清單與門檻**（誰能簽核發、身分、凍結、費率、對帳）；**記帳 TWD**（`LedgerTWD`：只有帳本合約能持有、不能轉出，總量＝營運方宣稱的信託專戶餘額）；營運 Safe 的**入金與出金確認**（帶銀行交易參考號的雜湊） |
| **鏈上治理** | 國家 Safe 2-of-3（授權清單、門檻）、營運 Safe（入出金確認、承諾提交者）、Timelock 48h（角色本身的更換）。部署者移轉後沒有任何權限 |
| **鏈下帳本**（`web/data/ledger/`） | 所有事件：委託、撤單、註銷、出金請求（與營運方的退回）、核發、身分、凍結、費率、轄區、對帳報告……每一筆帶簽章，依序接成雜湊鏈。持有、成交、憑證是**重播的結果**，不另外記 |
| **官方登錄簿** | 碳權本身。國內額度在專案方的額度帳戶，國外額度在本站於核發國登錄簿的託管帳戶。帳本記的是對它們的請求權 |

**它是**：

- 一個**登錄簿**：專案登錄、查驗機構簽章核發、序號唯一、註銷後發出憑證（PDF 雜湊記入帳本）。
- 一個**市場**：使用者在 CAFECA 錢包簽 EIP-712 委託單，帳本收單、回簽收收據、引擎撮合。不付 gas、不等出塊。
- 一個**可驗證的託管方**：每小時把「誰有多少」壓成帶總額的 Merkle 樹上鏈；使用者下載自己的證明檔，
  用任一節點就能驗；合約拒絕宣稱欠的新台幣多於記帳 TWD 的總量。
- 一個**錢在信託專戶的地方**：入金匯款到信託專戶（備註填入金識別碼）→ 營運 Safe 在鏈上確認；
  出金簽請求（帶收款帳戶的雜湊）→ 下一期承諾 → 營運方匯款 → 營運 Safe 憑證據確認、銷毀記帳 TWD。
  **沒有鏈上提領、沒有逃生門**：營運方停擺時，最後一期的證據是債權憑證，不是提款單。
- 一個**可以交出去的系統**：主權與營運兩層角色從第一天就分開，移轉是 `grantRole` / `renounceRole`。

**它不是**：

- 不是把既有碳權「橋接」上鏈。本平台自己就是登錄簿，額度在這裡誕生。
- Phase 0 **不是正式營運**。身分驗證、查驗機構簽章由平台金鑰模擬，信託專戶尚未開立（入出金是模擬的）。見 [十、Phase 0 限制](#十phase-0-限制與後續)。

### 保證的降級（要寫在最前面）

原本由合約在交易當下拒絕的規則——身分與效期、自然人不得註銷、轄區是否開放、國外額度用途、凍結、
手續費、撮合——現在由帳本引擎（`web/lib/ledger/engine.ts`）執行。保證從「**合約拒絕**」變成「**重播抓得到**」：
營運方收下一筆違規事件，鏈上不會擋，但任何重播帳本的人都會在同一個位置看到，承諾也對不上。

營運方仍然做不到的：替使用者簽單、改已上鏈的任何一期、宣稱欠的新台幣多於記帳 TWD 的總量、把記帳 TWD 轉給任何人、
同一筆匯款入帳兩次、確認超過使用者請求的出金、不經查驗機構金鑰核發。
營運方做得到但藏不住的：決定同時到達的事件順序、拒收事件、停止提交承諾、收下出金請求卻不匯款。

**新台幣這一層的降級**：錢在信託專戶，鏈上證明不了專戶裡真的有那麼多錢（記帳 TWD 是營運方的宣稱，
與專戶的相符靠信託銀行對帳與查核報告），也沒有任何機制能繞過營運方把錢領出來。能強制的是信託契約與主管機關。

這一段也寫在網站的 `/audit`（審計）與平台使用約定書第五條之一。

### 延伸文件

| 文件 | 內容 |
|---|---|
| [`docs/proof-schemes.md`](docs/proof-schemes.md) | 證明檔與雜湊規則的完整規格（Boltchain Explorer Issue #1 格式） |
| `web/contracts/*.md` | 七份定型化契約與政策（內容雜湊即版本指紋） |
| `reports/` | 靜態分析（Slither、Aderyn）與 gas 報告 |
| Claude project `CO2Exchange` | 架構決策（`claude/design-v4-proofs-only.md`）、簽章模型、法律性質、Boltchain 實測 |

---

## 二、為什麼要做這個

《氣候變遷因應法》上路後，排放大戶要繳碳費，而**減量額度可以扣除收費排放量**：

| 額度來源 | 扣除上限 | 扣除比率 |
|---|---|---|
| 國內減量額度 | 收費排放量的 **10%** | 自願減量／抵換專案 **1.2** |
| 國外減量額度 | **5%**（高碳洩漏風險事業不得使用） | — |

碳權市場最常被質疑的不是「不能買賣」，而是：**這張額度是真的嗎？有沒有被用兩次？交易所手上真的有嗎？
交得出去嗎？** 四個問題的共同答案是可驗證——不是「相信我們」，而是「你自己算一次」。

用區塊鏈只為三件別的做法做不到的事：紀錄不可竄改而且不需要相信營運方、控制權可以用密碼學交接、
第三方可以自己重算。**不需要鏈的部分就不上鏈**：撮合、委託簿、身分明細都在鏈下，只有壓縮後的證據上鏈。

**法規落差**（需要主管機關一起決定）：交易拍賣及移轉管理辦法 §26「每單位移轉以一次為限、由主管機關移轉」。
本平台的做法是帳本裡只轉**請求權**，那唯一一次官方移轉留到最終買方註銷時（專案方帳戶 → 買方帳戶），
寫在平台使用約定書第三條與服務流程說明書。這個解讀需要主管機關確認。

---

## 三、本機開發

需要 git、Node 20+、curl。Foundry 由 `setup.sh` 裝。

```bash
git clone https://github.com/CAFECA-IO/CO2Exchange.git
cd CO2Exchange && bash setup.sh                     # Foundry、釘死版本的 submodule、build、test

cd web && npm install && cp .env.example .env.local && cd ..

bash script/demo-box.sh rebuild                     # 開 anvil、部署帳本合約、回填展示資料、提交第一期
cd web && npm run dev                               # 另一個終端，http://localhost:10010
bash script/demo-box.sh commit-loop                 # 再一個終端：每小時一期承諾＋公開檔（COMMIT_EVERY 可調）
```

依賴（git submodule，已釘版本）：forge-std v1.16.2、openzeppelin-contracts v5.1.0、safe-smart-account v1.4.1。

| | 埠 | 覆蓋方式 |
|---|---|---|
| 前端 | **10010** | `PORT=xxxx npm run dev` |
| 鏈 | **28545** | `RPC_URL=http://127.0.0.1:xxxx bash script/demo-box.sh rebuild` |

刻意避開 3000／8545：那兩個埠上什麼都可能在跑，連到別人的服務而不自知比連不上更難查。

本機登入用**開發用登入**（首頁的輸入框填代號，例如 `alice`）：伺服器從代號推出一把測試金鑰代簽，
簽的是真的 EIP-712，最後的 `ledger:verify` 會在收單區塊重驗每一筆。只在 chainId 31337／1337 開放。

`demo-box.sh` 的其他指令：

| 指令 | 做什麼 |
|---|---|
| `rebuild` | 僅本機鏈：新鏈、部署、回填 `LEDGER_DAYS` 天（預設 60）× `LEDGER_USERS` 人（預設 40）、提交第一期 |
| `deploy` | 部署到設定的那條鏈（外部鏈 ＝ `bootstrap.sh deploy`） |
| `seed` | 鋪資料（本機 ＝ 回填；外部鏈 ＝ 模擬人物從現在開始交易 `EXT_TICKS` 輪） |
| `commit` | 提交一期承諾（先完整查核，不過就不送） |
| `commit-loop` / `live` | 每 `COMMIT_EVERY` 秒一期，並寫出每期公開檔（前景，Ctrl-C 結束） |
| `status` | 現在是什麼狀態 |

`.env.local` 至少確認：`RPC_URL` / `CHAIN_ID`（對不上時畫面全空但不報錯）、
`ADMIN_ADDRESSES` / `VERIFIER_ADDRESSES`（`KYC_AUTO_APPROVE=0` 時要包含你自己登入後的地址；
非 production 留空時退回開發用登入 `admin` / `verifier` 推出的兩個地址）。

---

## 四、部署到外部鏈（Boltchain 8018）

```bash
export RPC_URL=http://211.22.118.149:8545

./script/preflight.sh "$RPC_URL"       # Cancun（MCOPY）、EIP-1559、eth_getLogs 範圍、營運 Safe 金鑰、部署者餘額
bash script/bootstrap.sh               # 建金鑰 → 等撥款 → 驗餘額 → 部署 → 寫回 web/.env.local

cd web && npm install && npm run build && npm start
```

`bootstrap.sh` 分開跑也可以：`keys` / `fund` / `deploy` / `status` / `roles`。

**金鑰在你的機器上產生**（`cast wallet new`），直接寫進 `web/.env.local`（權限 600）。腳本只印地址，不印私鑰；
已經有值的一律保留不覆寫。

| 金鑰 | 做什麼 | 要餘額嗎 |
|---|---|---|
| `DEPLOYER_PK` | 部署帳本合約與治理（部署完放棄全部權限）；送營運 Safe 的入出金確認交易、模擬人物的 gas 也從它出（它只付 gas，不是持有人） | 要，最多 |
| `RELAYER_PK` | 每小時提交承諾（COMMITTER）、簽收單回執（RECEIPT_SIGNER） | 要（`COMMIT_DAYS` × 24 × `COMMIT_GAS`） |
| `IDENTITY_VERIFIER_PK` | 只簽帳本的身分事件 | 不要 |
| `CARBON_VERIFIER_PK` | 只簽帳本的核發事件、月度查核 | 不要 |
| `DOCUMENT_SIGNER_PK` | 只簽憑證文件雜湊事件 | 不要 |

**治理 Safe 的 owner 金鑰寫在 `.governance.env`，不是 `web/.env.local`**：網站伺服器持有國家 Safe 的 owner 金鑰，
等於把主權／營運分權整個抵銷。腳本產生的五把治理金鑰全部落在同一台機器上——展示可以，正式不行。
正式部署由各持有人自己產生，只把**地址**設成 `NATIONAL_OWNERS` / `OPERATOR_OWNERS`。

**不接外部結算幣**（不再使用 CAFECA 的 TWDC，`SETTLEMENT_TOKEN` 已經不用了）。帳本合約部署時建立自己的記帳 TWD，
只有營運 Safe 確認入金時鑄出、確認出金時銷毀。做市與模擬人物的撥款也是營運 Safe 的入金確認，
所以跑 `npm run mm` / 模擬器的那台機器要有營運 Safe 持有人的金鑰（`.governance.env` 的 `OPERATOR_OWNER_<n>_PK`）。

部署完兩件事要自己做：`SITE_ORIGIN` 與瀏覽器網址列逐字相同；登入一次後把 `/account` 上的地址填進
`ADMIN_ADDRESSES` 再重啟。

`web/.env.local` 的 CAFECA 段目前**必須設死**（對方的 `.well-known` 設定檔 `chain.rpc` 指向 Explorer、
`issuer` 還是 `localhost:10002`）：`CAFECA_CHAIN_ID` / `CAFECA_RPC_URL` / `CAFECA_ATTESTATION` /
`CAFECA_RECOVERY` / `CAFECA_FACTORY` / `CAFECA_KEYRING`，見 `web/.env.example`。

> 規則版本（`RULES_VERSION`）改過就要重新部署帳本合約：舊合約的承諾格式與新的餘額樹葉子不相容。
> 目前是第 4 版（新台幣入出金：出金請求帶 `payoutRef`、營運方退回 `withdrawReject`；合約 `ledgerVersion` 3）。
> 從第 3 版升上來要重新部署：`bash script/bootstrap.sh deploy`（舊的 `web/data/` 會搬到 `data.bak-<時間>`）。

---

## 五、日常營運

### 三個常駐行程

| 行程 | 指令 | 失敗時的後果 |
|---|---|---|
| 網站 | `cd web && npm start` | 收不了單。帳本與鏈上不受影響 |
| 承諾 | `bash script/demo-box.sh commit-loop`（或排程 `npm run ledger:commit`＋`npm run ledger:publish`） | 出金請求進不了證據，營運方不能確認出金；揭露頁的數字停在最後一期。沒有新事件時仍會每 `HEARTBEAT_AFTER`（預設 24h）提交一期空的 |
| 做市 | `bash script/mm-service.sh install`（macOS launchd／Linux systemd） | 掛單簿變薄。控制在 `/admin`「後台做市」 |

### 承諾

```bash
cd web
npm run ledger:commit -- --plan     # 只算、不送：這一期會提交什麼
npm run ledger:commit               # 先完整查核（重播、重驗每一筆簽章、對帳入出金），全過才送
npm run ledger:verify               # 查核者模式：重播全部，逐期比對鏈上的 anchor
```

送出前的查核任何一項不過就不送——那代表帳本被動過、或有簽章在收單當時沒有授權。

### 發布與監理鏡像

```bash
npm run ledger:publish                          # 每期公開檔 → web/data/public/epochs/<期>.json（已存在的不重寫）
npm run ledger:publish -- --out /srv/co2x-public
npm run ledger:publish -- --mirror /path/to/mirror   # 完整帳本＋部署檔＋SHA-256 清單，交給查核機構與主管機關
```

公開檔在寫出前都先和鏈上承諾比對，對不上就不寫。網站也從 `/api/public/epochs` 提供同一份。

### 授權事件（k-of-n）

主權、營運、查核角色的事件（費率、轄區、政策、凍結、退回出金請求、對帳報告）門檻大於 1 時變成**提案**，
持有人各自簽，收滿門檻才寫進帳本。持有人的私鑰不放在本站：

```bash
npm run ledger:authority -- list
npm run ledger:authority -- show <id>                        # 要簽的 EIP-712，交給硬體錢包
npm run ledger:authority -- sign <id> --key-env MY_OWNER_PK  # 用你自己 shell 裡的私鑰（只印地址）
npm run ledger:authority -- add-signature <id> 0x…
npm run ledger:authority -- submit <id>
```

### 鏈上治理（`script/govern.sh`）

```bash
./script/govern.sh status                                   # 角色、Safe、門檻、epoch、記帳 TWD 發行量

read T D < <(./script/govern.sh build revoke-authority CARBON_VERIFIER 0xABC…)
H=$(./script/govern.sh safe national hash $T $D)            # 給每位簽章者
S1=$(./script/govern.sh sign $H --ledger)                   # 各自簽（--private-key / --ledger / --trezor）
./script/govern.sh safe national exec $T $D 0xOwner1:$S1 0xOwner2:$S2
```

| 預設 | 由誰 | 即時或延遲 |
|---|---|---|
| `grant-authority` / `revoke-authority <角色> <地址>`、`threshold <角色> <k>` | 國家 Safe | 即時；重播以事件所在區塊為起點 |
| `deposit <帳戶> <最小單位> <銀行參考號>`、`committer-grant` / `committer-revoke` | 營運 Safe | 即時（出金確認要帶證據，用 `npm run fiat -- settle … --print`） |
| `grant-role` / `revoke-role <sovereign\|operator\|admin>` | 國家 Safe 經 Timelock | 48 小時 |
| `safe-add-owner` / `safe-remove-owner` / `safe-swap-owner` / `safe-threshold` | 各 Safe 自己 | 即時 |

⚠️ Safe 持有人異動時，帳本的 SOVEREIGN／OPERATOR 授權清單要跟著改（`grant/revoke-authority`），
否則新持有人簽不了帳本事件、舊持有人仍然簽得了。

### 做市與模擬市場

`npm run mm`（或 `mm-service.sh`）讀 `/admin` 寫的設定，做市帳戶的金鑰在 repo 根目錄的 `.mm.env`（第一次跑時產生，權限 600）；
網站**不持有**做市金鑰。報價是簽名委託單，和使用者同一條撮合與查核路徑；做市只被動報價，絕不與平台控制的帳戶成交。
模擬模式只在 `SIMULATION_CHAINS` 列出的測試鏈上能開，掛單簿上會標「模擬」，`/custody` 揭露做市帳戶。

### 新台幣入出金（`npm run fiat`）

使用者的錢是**信託專戶裡的真新台幣**，鏈上只有記帳 TWD。兩個動作都是營運 Safe 的鏈上交易，
**網站不持有營運 Safe 的金鑰**：在持有人的機器上（金鑰在 `.governance.env`）用 `npm run fiat`，
或在 `/admin`「出入金」取得要執行的內容（本機鏈才由網站直接代送，因為持有人是公開的測試金鑰）。

**入金**：使用者匯款到信託專戶、備註填自己的**入金識別碼**（`/trade`「新台幣」卡上，由地址決定的 10 位數字）→
營運方對帳 → 確認：

```bash
cd web
npm run fiat -- code 0x…                           # 查某個帳戶的入金識別碼
npm run fiat -- deposit <地址或入金識別碼> 12345.5 'TXN-20260929-0001'   # 金額是元；參考號只以雜湊上鏈，不能重複
```

**出金**：使用者在 `/trade` 設定收款帳戶（銀行代碼、帳號、戶名；明文只在營運方，帳本記加鹽的雜湊 `payoutRef`）
→ 簽出金請求（可動用 → 待出金）→ 下一期承諾上鏈 → 營運方依 `/admin`「出入金」的收款帳戶**匯款** → 確認：

```bash
npm run fiat -- list                               # 待出金、可確認多少、收款帳戶雜湊
npm run fiat -- settle <地址> 1000 'WIRE-20260929-0007'   # 附最新一期的證據，不能超過已承諾的請求
npm run fiat -- settle … --print                   # 不送出：印出 to / data，交給硬體錢包走 govern.sh
```

不匯款就退回（金額回到可動用）：`/admin`「出入金」的「退回請求」，或
`npm run ledger:authority -- propose withdrawReject '{"account":"0x…","amount":"…","reason":"收款帳戶有誤"}'`。

**沒有鏈上提領、沒有逃生門。** 記帳 TWD 只存在帳本合約裡、不能轉出；它的發行量是營運方宣稱的信託專戶餘額，
每月的對帳報告由查核機構比對它與銀行對帳單。停止營運時只留證據：最後一期的承諾與每位使用者的證明檔是債權憑證。

---

## 六、自己驗證

三種層次，都不需要相信本站：

```bash
# ① 我的持有：/trade 下載證明檔，任一節點
node web/scripts/verify-proof.mjs 證明檔.json --rpc <任一節點> [--out 報告.json]

# ② 某一期的公開內容：/audit 或 /api/public/epochs/<期>，依 docs/proof-schemes.md 重建 root，對照鏈上 Committed 事件

# ③ 整份帳本（查核機構、主管機關）：監理鏡像
LEDGER_DIR=<鏡像>/ledger DEPLOYMENT_FILE=<鏡像>/deployment.json RPC_URL=<任一節點> npm run ledger:verify
```

`verify-proof.mjs` 只用 viem、不引用本站任何程式碼；它自己回鏈上取承諾，不相信證明檔裡寫的 root。

---

## 七、測試

```bash
forge test                                   # 34：帳本合約、記帳 TWD、Merkle 樹、治理（真 Safe v1.4.1 ＋ Timelock）

cd web
npm run check:boundary                       # 前端沒有直接連節點
npm run check:api-envelope                   # 每支 API 都走制式信封與錯誤碼
npm run test:ledger                          # 24：引擎規則、重播、雜湊鏈、出金請求／退回／確認
npm run test:cafeca                          # 23：登入 nonce、SignIn digest、委託單 EIP-712、設定檔解析
npm run test:keys && npm run test:mm         # 金鑰來源、做市策略
npm run build

# 需要 anvil 的端到端（各自一條鏈）
anvil --port 38546 & npm run test:ledger-chain    # 帳本 × 合約：營運 Safe 入金、承諾、重播、出金確認
anvil --port 38548 & npm run test:ledger-mm       # 11：做市與模擬器
anvil --port 38549 & npm run test:ledger-proof    # 10：npm run fiat、證明檔、公開檔、監理鏡像、沒有逃生門
# 65：網站 API → 帳本 → 收款帳戶、出金、/admin 出入金 → 承諾 → 查核。前置見 scripts/e2e-ledger-write.mjs 開頭
npm run test:ledger-write
```

`npm run gen:ledger-fixture` / `gen:tree-fixture` 產生 `test/fixtures/` 給 forge 用，確保 TypeScript 與 Solidity 兩份雜湊逐位元組一致。

---

## 八、出問題怎麼修

| 症狀 | 多半是 |
|---|---|
| 畫面全空、沒有錯誤訊息 | `.env.local` 的 `RPC_URL` / `CHAIN_ID` 對到另一條鏈 |
| 啟動就報「不是帳本部署（沒有 ledger 欄位）」 | `deployments/<chainId>.json` 是舊的全合約版本。重新部署：`bash script/bootstrap.sh deploy`（本機 `demo-box.sh rebuild`） |
| 登入一直說「驗證沒有通過」 | `SITE_ORIGIN` 與瀏覽器網址列不是**逐字**相同（含 scheme 與 port）。真正原因在伺服器 console 的 `[cafeca] 登入驗證失敗：…` |
| 「nonce 格式錯誤」 | CAFECA 錢包要求 `[A-Za-z0-9_-]{8,128}`；本站發的是固定 61 字元。瀏覽器快取了舊版前端就重新整理 |
| 登入了但每個按鈕按下去都失敗 | 沒有開啟 CAFECA 簽章通道。回首頁重新登入一次 |
| 下單說「被帳本規則拒絕」 | 事件已簽收但不生效（身分、餘額、轄區、用途……），理由寫在訊息裡 |
| 匯款了但帳本餘額沒變 | 營運方還沒對帳確認（Phase 0 人工，通常一個營業日內）；確認之後鏡像才入帳。`npm run fiat -- list` / `/admin`「出入金」 |
| 確認出金說「證據不是最新一期」／`NotLatestEpoch` | 剛換期。重新整理出金佇列再送 |
| 確認出金說「還沒進承諾」 | 出金請求要先進一期承諾（最長一小時） |
| 確認入金說「參考號已經確認過了」／`BankRefUsed` | 同一筆匯款不能入帳兩次。確認一下是不是重複按了 |
| `npm run fiat` 說「沒有營運 Safe 持有人的金鑰」 | 這台機器沒有 `.governance.env` 的 `OPERATOR_OWNER_<n>_PK`。加 `--print` 交給持有人簽 |
| 承諾送不出去 `ChainBroken` / `EpochOutOfOrder` | 承諾程式讀到的帳本和上一期不是同一份，或上一期沒上鏈。`npm run ledger:verify` 會指出哪一期 |
| 承諾送不出去 `Insolvent` | 帳本宣稱欠的新台幣比記帳 TWD 多。**立刻查**：多半是帳本裡有一筆入金不是鏈上的確認鏡像來的 |
| 承諾送不出去 AccessControl revert | `COMMITTER` 不是 `RELAYER_PK` 的地址。`bash script/bootstrap.sh roles` |
| 部署被 `PublicKeyOnPublicChain` 擋下 | 有角色還用著 anvil 的預設帳戶（常見是 `NATIONAL_OWNERS`）。`bash script/bootstrap.sh keys` |
| 部署一開始就 `nonce too high` | 節點的 txpool 不收未來 nonce，而 forge 預設整批送。`bootstrap.sh` 在外部鏈上會自動加 `--slow` |
| 腳本報 `invalid private key` | shell 裡有同名的佔位變數蓋過了 `web/.env.local`。`unset DEPLOYER_PK RELAYER_PK` |
| `/admin` 做市顯示「常駐程式沒有回應」 | `npm run mm` 沒在跑。`bash script/mm-service.sh status` / `logs` |
| 做市撥款沒發生、狀態說沒有營運 Safe 金鑰 | 撥款是營運 Safe 的入金確認；跑 `npm run mm` 的機器要有 `.governance.env` 的持有人金鑰，或照警告印的 `npm run fiat` 指令請持有人確認 |
| 開不了模擬交易（FORBIDDEN） | 這條鏈不在 `SIMULATION_CHAINS`。刻意的：正式市場不可以有平台自己的虛擬成交 |
| 前端報 `0x` 開頭的八位十六進位 | `web/lib/error-abi.ts` 沒跟上合約：`cd web && npm run gen:errors` |
| 重新部署後畫面有資料但對不上 | `web/data/` 是舊部署的。`cd web && npm run data:reset`（搬到 `data.bak-<時間戳>`，不是刪除） |

**shell 腳本的坑**：變數展開後面接中文字一定要用 `${VAR}`——macOS 內建的 bash 3.2 會把後面的多位元組字元當成識別字的一部分，
在 `set -u` 下直接 unbound variable。

---

## 九、設計說明

### 目錄

```
src/ledger/Ledger.sol          帳本合約：承諾鏈、授權清單、營運 Safe 的入出金確認（沒有提領、沒有逃生門）
src/ledger/LedgerTWD.sol       記帳 TWD：只有帳本合約能持有、不能轉出
src/ledger/LedgerMerkle.sol    事件、登錄簿、身分樹（葉子格式的 Solidity 參考實作，給跨語言一致性測試）
src/ledger/MerkleSumTree.sol   帶總額的餘額樹（葉子 v2：kg、cash、requested、settled）
src/governance/GovernanceLib.sol  Safe v1.4.1 基礎設施與 Timelock
script/DeployLedger.s.sol      部署（含治理移轉；部署者移轉後沒有任何權限）
script/{bootstrap,preflight,demo-box,govern,mm-service}.sh
web/lib/ledger/                引擎、事件、簽章、樹、證據、公開檔、儲存——不依賴 Next，查核工具直接用
web/lib/server/ledger/         網站的讀寫面（收單、檢視、證據）
web/scripts/                   承諾、發布、查核、授權提案、做市、模擬、端到端測試
web/contracts/*.md             定型化契約與政策
```

### 事件（`web/lib/ledger/events.ts`）

21 種：入金／出金確認的鏡像（1、2）、轄區、政策、費率（3–5）、身分、凍結（6、7）、專案、匯入專案、專案狀態（8–10）、
核發（11）、掛單、撤單、註銷（12–14）、憑證文件、官方註銷（15、16）、對帳報告與查核（17、18）、金鑰鏡像（19）、
出金請求（20，帶收款帳戶雜湊 `payoutRef`）、營運方退回出金請求（21）。**只記輸入，不記結果**：成交、憑證、批次餘額都是引擎算出來的。

每一筆帶序號、邏輯時間與收單區塊高度。收單區塊決定用哪一份授權清單驗簽——查核時只用 ecrecover
與鏈上的授權歷史，**不讀任何歷史狀態**（Boltchain 只保留最近 128 個區塊，archive 節點不是前提）。

### 簽章

| 誰簽 | 格式 | 驗法 |
|---|---|---|
| 使用者（CAFECA 身分合約） | EIP-712：PlaceOrder／CancelOrder／RetireCredits／RegisterProject／RequestWithdrawal | ERC-1271 簽章依 CAFECA 版面解析、驗 WebAuthn ES256；公鑰與有效區間來自 keyring 的 `KeyAdded`／`KeyRemoved` 事件（鏡像進帳本） |
| 做市、模擬人物（EOA） | 同上 | ecrecover |
| 授權單位 | `LedgerEvent(version, kind, payload)`，payload 是內容雜湊 | ecrecover；k-of-n 時附門檻數量的不同持有人簽章 |
| 本站收單 | 簽收收據（RECEIPT_SIGNER） | ecrecover |

### 出金（規則第 4 版）

帳本記每個帳戶的**待出金**、**累計請求**、**累計已確認**；葉子帶 `requested` 與 `settled`。
合約記 `withdrawnTotal[帳戶]`（累計，不分期）：營運 Safe 能確認的上限是最新一期的 `requested − withdrawnTotal`。
所以換了幾期、鏡像晚了幾個區塊都一樣，同一筆錢不會確認兩次。鏈上的 `CashWithdrawn` 鏡像進帳本時**只能銷待出金**
（超過就拒絕：沒有逃生提領，不存在「從可動用扣」的情況）；營運方退回的 `withdrawReject` 把待出金放回可動用。
每一筆入出金確認帶 `bankRef`（銀行交易參考號的雜湊，入金 `co2x:bank:in:`、出金 `co2x:bank:out:` 前綴），合約記用過的，不收第二次。

### 前端與 API 的邊界

瀏覽器不直接連節點（`check:boundary` 擋），ABI 只在伺服器端；所有 API 回 `{ ok, data }` 或制式錯誤碼
（`check:api-envelope` 擋，錯誤碼在 `web/lib/error-codes.ts`）。

### 部署指紋

`web/data/.deployment.json` 記下資料屬於哪一次部署（帳本合約、記帳 TWD、`deployedAt`）。對不上時申請與憑證紀錄一律擋下
（`DATA_STALE`），不悄悄拿舊的來用。anvil 重開後重新部署會得到相同地址，所以 `deployedAt` 不是多餘的。

### 舊的全合約版本

第 7 期之前的版本（KYCRegistry、CarbonRegistry、CarbonCredit1155、Listing、CarbonPool、Bank、PasskeyAccount、
Uniswap v4 hook／router）已經移除，保留在 git 歷史（`e86089d` 以前）。Boltchain 上 rules v2 的舊帳本合約
（`0x71034Ae8…`，區塊 26654），以及 rules v3（接 CAFECA 的 TWDC、有鏈上提領與逃生門）的帳本合約，在以 rules v4 重新部署後都不再由本站使用。

---

## 十、Phase 0 限制與後續

- **新台幣的保證靠信託，不靠密碼學**：鏈上沒有提領與逃生門；記帳 TWD 與信託專戶真實餘額的相符靠信託銀行對帳與查核報告。
  營運方收下出金請求卻不匯款，鏈上只留證據。**持有使用者的新台幣並提供帳戶間移轉可能涉及電子支付／儲值的監理規定**，
  正式營運前要有法律意見與金融機構的合作（信託契約、虛擬帳號、對帳檔介接）。
- **拒收請求的缺口**：營運方可以不給某一人的委託單或出金請求簽收收據。目前靠簽章與沒有收據這件事申訴；鏈上強制收單列為後續。
- 入金識別碼是由地址算出的 10 位數字（填在匯款備註）；正式營運應換成信託銀行發的虛擬帳號，對帳改為自動。
- 身分驗證是模擬的（管理員核准即通過），未介接憑證管理中心；證號目前明文存在伺服器端。
- 查驗機構的簽章金鑰在本站（`CARBON_VERIFIER_PK`）；正式由查驗機構自己簽。
- 治理金鑰由腳本在同一台機器產生；正式由三位持有人各自產生。
- CAFECA 錢包的 `.well-known` 設定檔尚未對外（`issuer` 是 localhost），正式網域的站台還登不進去。
- RPC 是 `http://`（沒有 TLS）。瀏覽器碰不到它，但伺服器到節點是明文。
- 正式營運的前提：主管機關認可、查驗機構以自己的金鑰簽章、金融機構提供的結算工具與信託專戶。

| | 內容 | 鏈 |
|---|---|---|
| **Phase 0**（現在） | 提案展示。功能完整；身分驗證與查驗簽章是模擬的 | Boltchain 8018 |
| **Phase 1** | 試點。真實憑證整合、查驗機構自行簽章、強制收單、索引器與監控、金鑰移交 HSM | Besu + QBFT 四節點（Cancun） |
| **Phase 2** | 正式。信託專戶與虛擬帳號介接落地、指定做市商、第三方稽核、法遵定案、控制權移轉演練 | — |

---

## 授權

本 repo 的程式碼為 **MIT**（見 [`LICENSE`](LICENSE)），著作權人為卡菲卡金融科技股份有限公司。
`lib/` 底下的第三方元件以 submodule 引入，各依其原授權條款（forge-std：MIT／Apache-2.0；
OpenZeppelin Contracts：MIT；Safe Smart Account：LGPL-3.0）。
