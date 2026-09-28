# TideBit-DeFi 碳權交易所

國家級減量額度的**登錄、交易與註銷**平台。企業完成 ISO 14064-2 減量、14064-3 第三方查驗後，
由查驗機構以自己的金鑰簽章核發額度；額度可販售給個人、機構或其他企業，買方註銷後取得可附於申報文件的憑證。

由卡菲卡金融科技股份有限公司（CAFECA）建置，**設計為控制權可完整移轉給國家單位、由 CAFECA 代運營**。
目前是 **Phase 0**：功能完整、可以從頭走到尾，但身分驗證與查驗簽章是模擬的。

目標鏈是 **Boltchain 8018**（CAFECA 的身分合約在那裡，交易所要同鏈），結算幣是鏈上既有的 **TWDC**，
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
| **鏈上**（`src/ledger/Ledger.sol`） | 每小時一期的**承諾**（事件 log root、帶總額的餘額樹 root、登錄簿 root、身分 root、逐批次總量雜湊），前後串連；**授權金鑰清單與門檻**（誰能簽核發、身分、凍結、費率、對帳）；**結算幣託管**；**提領與逃生門**；碳權**請求權登記** |
| **鏈上治理** | 國家 Safe 2-of-3（授權清單、門檻）、營運 Safe（提領開關、承諾提交者）、Timelock 48h（角色本身的更換）。部署者移轉後沒有任何權限 |
| **鏈下帳本**（`web/data/ledger/`） | 所有事件：委託、撤單、註銷、提領請求、核發、身分、凍結、費率、轄區、對帳報告……每一筆帶簽章，依序接成雜湊鏈。持有、成交、憑證是**重播的結果**，不另外記 |
| **官方登錄簿** | 碳權本身。國內額度在專案方的額度帳戶，國外額度在本站於核發國登錄簿的託管帳戶。帳本記的是對它們的請求權 |

**它是**：

- 一個**登錄簿**：專案登錄、查驗機構簽章核發、序號唯一、註銷後發出憑證（PDF 雜湊記入帳本）。
- 一個**市場**：使用者在 CAFECA 錢包簽 EIP-712 委託單，帳本收單、回簽收收據、引擎撮合。不付 gas、不等出塊。
- 一個**可驗證的託管方**：每小時把「誰有多少」壓成帶總額的 Merkle 樹上鏈；使用者下載自己的證明檔，
  用任一節點就能驗；合約拒絕宣稱欠的結算幣多於它持有的承諾。
- 一個**拿得回來的地方**：提領請求 → 下一期承諾 → 憑證據從合約領回；
  72 小時沒有新承諾就進逃生模式，任何人憑最後一期的證據領回全部，沒有角色關得掉。
- 一個**可以交出去的系統**：主權與營運兩層角色從第一天就分開，移轉是 `grantRole` / `renounceRole`。

**它不是**：

- 不是把既有碳權「橋接」上鏈。本平台自己就是登錄簿，額度在這裡誕生。
- Phase 0 **不是正式營運**。身分驗證、查驗機構簽章由平台金鑰模擬，結算幣是測試幣。見 [十、Phase 0 限制](#十phase-0-限制與後續)。

### 保證的降級（要寫在最前面）

原本由合約在交易當下拒絕的規則——身分與效期、自然人不得註銷、轄區是否開放、國外額度用途、凍結、
手續費、撮合——現在由帳本引擎（`web/lib/ledger/engine.ts`）執行。保證從「**合約拒絕**」變成「**重播抓得到**」：
營運方收下一筆違規事件，鏈上不會擋，但任何重播帳本的人都會在同一個位置看到，承諾也對不上。

營運方仍然做不到的：替使用者簽單、改已上鏈的任何一期、宣稱欠的結算幣多於合約持有、阻止逃生提領、
不經查驗機構金鑰核發。營運方做得到但藏不住的：決定同時到達的事件順序、拒收事件、停止提交承諾。
**已知缺口**：營運方持續提交承諾、卻只拒收某一人的提領請求時，逃生門不會開啟（見 [十](#十phase-0-限制與後續)）。

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
export SETTLEMENT_TOKEN=0xb07f90B82eEb0269fAcafC5A6a6CC01BE4747bA3   # CAFECA 的 TWDC

./script/preflight.sh "$RPC_URL"       # Cancun（MCOPY）、EIP-1559、eth_getLogs 範圍、結算幣、部署者餘額
bash script/bootstrap.sh               # 建金鑰 → 等撥款 → 驗餘額 → 部署 → 寫回 web/.env.local

cd web && npm install && npm run build && npm start
```

`bootstrap.sh` 分開跑也可以：`keys` / `fund` / `deploy` / `status` / `roles`。

**金鑰在你的機器上產生**（`cast wallet new`），直接寫進 `web/.env.local`（權限 600）。腳本只印地址，不印私鑰；
已經有值的一律保留不覆寫。

| 金鑰 | 做什麼 | 要餘額嗎 |
|---|---|---|
| `DEPLOYER_PK` | 部署帳本合約與治理（部署完放棄全部權限）；做市與模擬人物的撥款、gas 也從它出 | 要，最多 |
| `RELAYER_PK` | 每小時提交承諾（COMMITTER）、簽收單回執（RECEIPT_SIGNER） | 要（`COMMIT_DAYS` × 24 × `COMMIT_GAS`） |
| `IDENTITY_VERIFIER_PK` | 只簽帳本的身分事件 | 不要 |
| `CARBON_VERIFIER_PK` | 只簽帳本的核發事件、月度查核 | 不要 |
| `DOCUMENT_SIGNER_PK` | 只簽憑證文件雜湊事件 | 不要 |

**治理 Safe 的 owner 金鑰寫在 `.governance.env`，不是 `web/.env.local`**：網站伺服器持有國家 Safe 的 owner 金鑰，
等於把主權／營運分權整個抵銷。腳本產生的五把治理金鑰全部落在同一台機器上——展示可以，正式不行。
正式部署由各持有人自己產生，只把**地址**設成 `NATIONAL_OWNERS` / `OPERATOR_OWNERS`。

外部結算幣（TWDC）本站沒有鑄幣權：做市與模擬人物的撥款要由 `DEPLOYER` 事先持有 TWDC。
**把 TWDC 轉到帳本合約或 DEPLOYER 的地址——不要轉到 TWDC 代幣合約本身**（那筆錢拿不回來）。

部署完兩件事要自己做：`SITE_ORIGIN` 與瀏覽器網址列逐字相同；登入一次後把 `/account` 上的地址填進
`ADMIN_ADDRESSES` 再重啟。

`web/.env.local` 的 CAFECA 段目前**必須設死**（對方的 `.well-known` 設定檔 `chain.rpc` 指向 Explorer、
`issuer` 還是 `localhost:10002`）：`CAFECA_CHAIN_ID` / `CAFECA_RPC_URL` / `CAFECA_ATTESTATION` /
`CAFECA_RECOVERY` / `CAFECA_FACTORY` / `CAFECA_KEYRING`，見 `web/.env.example`。

> 規則版本（`RULES_VERSION`）改過就要重新部署帳本合約：舊合約的承諾格式與新的餘額樹葉子不相容。
> 目前是第 3 版（提領請求事件、葉子帶 requested／settled）。

---

## 五、日常營運

### 三個常駐行程

| 行程 | 指令 | 失敗時的後果 |
|---|---|---|
| 網站 | `cd web && npm start` | 收不了單。帳本與鏈上不受影響 |
| 承諾 | `bash script/demo-box.sh commit-loop`（或排程 `npm run ledger:commit`＋`npm run ledger:publish`） | **72 小時沒有新承諾就進逃生模式**。沒有新事件時仍會每 `HEARTBEAT_AFTER`（預設 24h）提交一期空的 |
| 做市 | `bash script/mm-service.sh install`（macOS launchd／Linux systemd） | 掛單簿變薄。控制在 `/admin`「後台做市」 |

### 承諾

```bash
cd web
npm run ledger:commit -- --plan     # 只算、不送：這一期會提交什麼
npm run ledger:commit               # 先完整查核（重播、重驗每一筆簽章、對帳存提），全過才送
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

主權、營運、查核角色的事件（費率、轄區、政策、凍結、對帳報告）門檻大於 1 時變成**提案**，
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
./script/govern.sh status                                   # 角色、Safe、門檻、提領開關、epoch、逃生倒數

read T D < <(./script/govern.sh build revoke-authority CARBON_VERIFIER 0xABC…)
H=$(./script/govern.sh safe national hash $T $D)            # 給每位簽章者
S1=$(./script/govern.sh sign $H --ledger)                   # 各自簽（--private-key / --ledger / --trezor）
./script/govern.sh safe national exec $T $D 0xOwner1:$S1 0xOwner2:$S2
```

| 預設 | 由誰 | 即時或延遲 |
|---|---|---|
| `grant-authority` / `revoke-authority <角色> <地址>`、`threshold <角色> <k>` | 國家 Safe | 即時；重播以事件所在區塊為起點 |
| `withdrawals <true\|false>`、`committer-grant` / `committer-revoke` | 營運 Safe | 即時 |
| `grant-role` / `revoke-role <sovereign\|operator\|admin>` | 國家 Safe 經 Timelock | 48 小時 |
| `safe-add-owner` / `safe-remove-owner` / `safe-swap-owner` / `safe-threshold` | 各 Safe 自己 | 即時 |

⚠️ Safe 持有人異動時，帳本的 SOVEREIGN／OPERATOR 授權清單要跟著改（`grant/revoke-authority`），
否則新持有人簽不了帳本事件、舊持有人仍然簽得了。

### 做市與模擬市場

`npm run mm`（或 `mm-service.sh`）讀 `/admin` 寫的設定，做市帳戶的金鑰在 repo 根目錄的 `.mm.env`（第一次跑時產生，權限 600）；
網站**不持有**做市金鑰。報價是簽名委託單，和使用者同一條撮合與查核路徑；做市只被動報價，絕不與平台控制的帳戶成交。
模擬模式只在 `SIMULATION_CHAINS` 列出的測試鏈上能開，掛單簿上會標「模擬」，`/custody` 揭露做市帳戶。

### 提領（使用者這一側）

在 `/trade` 的提領區：簽提領請求（金額從可動用轉為待提領）→ 下一期承諾上鏈後按「領回」→ 錢包送出
`withdrawCash`（透過 CAFECA 簽章通道送出，gas 由平台贊助）。同一頁可以下載自己的證明檔。
營運方要暫停一般提領用 `govern.sh build withdrawals false`（營運 Safe）；逃生提領不受影響。

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
forge test                                   # 31：帳本合約、Merkle 樹、治理（真 Safe v1.4.1 ＋ Timelock）

cd web
npm run check:boundary                       # 前端沒有直接連節點
npm run check:api-envelope                   # 每支 API 都走制式信封與錯誤碼
npm run test:ledger                          # 24：引擎規則、重播、雜湊鏈、提領與逃生
npm run test:cafeca                          # 23：登入 nonce、SignIn digest、委託單 EIP-712、設定檔解析
npm run test:keys && npm run test:mm         # 金鑰來源、做市策略
npm run build

# 需要 anvil 的端到端（各自一條鏈）
anvil --port 38546 & npm run test:ledger-chain    # 帳本 × 合約：承諾、重播、逃生、請求權登記
anvil --port 38548 & npm run test:ledger-mm       # 11：做市與模擬器
anvil --port 38549 & npm run test:ledger-proof    # 10：證明檔、公開檔、監理鏡像、提領
# 55：網站 API → 帳本 → 承諾 → 查核。前置見 scripts/e2e-ledger-write.mjs 開頭
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
| 存入後帳本餘額沒變 | 鏡像是下一次同步才入帳；`/trade` 的存入卡會顯示錢包餘額、帳本合約與結算幣地址供核對 |
| 領回說「證據不是最新一期」／`NotLatestEpoch` | 剛換期。重新整理提領狀態再送 |
| 承諾送不出去 `ChainBroken` / `EpochOutOfOrder` | 承諾程式讀到的帳本和上一期不是同一份，或上一期沒上鏈。`npm run ledger:verify` 會指出哪一期 |
| 承諾送不出去 `Insolvent` | 帳本宣稱欠的結算幣比合約持有的多。**立刻查**：多半是有一筆存入沒在鏈上發生 |
| 承諾送不出去 AccessControl revert | `COMMITTER` 不是 `RELAYER_PK` 的地址。`bash script/bootstrap.sh roles` |
| 部署被 `PublicKeyOnPublicChain` 擋下 | 有角色還用著 anvil 的預設帳戶（常見是 `NATIONAL_OWNERS`）。`bash script/bootstrap.sh keys` |
| 部署一開始就 `nonce too high` | 節點的 txpool 不收未來 nonce，而 forge 預設整批送。`bootstrap.sh` 在外部鏈上會自動加 `--slow` |
| 腳本報 `invalid private key` | shell 裡有同名的佔位變數蓋過了 `web/.env.local`。`unset DEPLOYER_PK RELAYER_PK` |
| `/admin` 做市顯示「常駐程式沒有回應」 | `npm run mm` 沒在跑。`bash script/mm-service.sh status` / `logs` |
| 做市撥款失敗「營運金鑰的結算幣不夠」 | TWDC 鑄不出來，要先轉到 `DEPLOYER` 地址 |
| 開不了模擬交易（FORBIDDEN） | 這條鏈不在 `SIMULATION_CHAINS`。刻意的：正式市場不可以有平台自己的虛擬成交 |
| 前端報 `0x` 開頭的八位十六進位 | `web/lib/error-abi.ts` 沒跟上合約：`cd web && npm run gen:errors` |
| 重新部署後畫面有資料但對不上 | `web/data/` 是舊部署的。`cd web && npm run data:reset`（搬到 `data.bak-<時間戳>`，不是刪除） |

**shell 腳本的坑**：變數展開後面接中文字一定要用 `${VAR}`——macOS 內建的 bash 3.2 會把後面的多位元組字元當成識別字的一部分，
在 `set -u` 下直接 unbound variable。

---

## 九、設計說明

### 目錄

```
src/ledger/Ledger.sol          帳本合約：承諾鏈、授權清單、結算幣託管、提領、逃生、請求權登記
src/ledger/MerkleSumTree.sol   帶總額的餘額樹（葉子 v2：kg、cash、requested、settled）
src/ledger/LedgerMerkle.sol    事件、登錄簿、身分樹
src/governance/GovernanceLib.sol  Safe v1.4.1 基礎設施與 Timelock
script/DeployLedger.s.sol      部署（含治理移轉；部署者移轉後沒有任何權限）
script/{bootstrap,preflight,demo-box,govern,mm-service}.sh
web/lib/ledger/                引擎、事件、簽章、樹、證據、公開檔、儲存——不依賴 Next，查核工具直接用
web/lib/server/ledger/         網站的讀寫面（收單、檢視、證據）
web/scripts/                   承諾、發布、查核、授權提案、做市、模擬、端到端測試
web/contracts/*.md             定型化契約與政策
```

### 事件（`web/lib/ledger/events.ts`）

20 種：存入／提領鏡像（1、2）、轄區、政策、費率（3–5）、身分、凍結（6、7）、專案、匯入專案、專案狀態（8–10）、
核發（11）、掛單、撤單、註銷（12–14）、憑證文件、官方註銷（15、16）、對帳報告與查核（17、18）、金鑰鏡像（19）、
提領請求（20）。**只記輸入，不記結果**：成交、憑證、批次餘額都是引擎算出來的。

每一筆帶序號、邏輯時間與收單區塊高度。收單區塊決定用哪一份授權清單驗簽——查核時只用 ecrecover
與鏈上的授權歷史，**不讀任何歷史狀態**（Boltchain 只保留最近 128 個區塊，archive 節點不是前提）。

### 簽章

| 誰簽 | 格式 | 驗法 |
|---|---|---|
| 使用者（CAFECA 身分合約） | EIP-712：PlaceOrder／CancelOrder／RetireCredits／RegisterProject／RequestWithdrawal | ERC-1271 簽章依 CAFECA 版面解析、驗 WebAuthn ES256；公鑰與有效區間來自 keyring 的 `KeyAdded`／`KeyRemoved` 事件（鏡像進帳本） |
| 做市、模擬人物（EOA） | 同上 | ecrecover |
| 授權單位 | `LedgerEvent(version, kind, payload)`，payload 是內容雜湊 | ecrecover；k-of-n 時附門檻數量的不同持有人簽章 |
| 本站收單 | 簽收收據（RECEIPT_SIGNER） | ecrecover |

### 提領（規則第 3 版）

帳本記每個帳戶的**待提領**、**累計請求**、**累計已領**；葉子帶 `requested` 與 `settled`。
合約記 `withdrawnTotal[帳戶]`（累計，不分期）：一般上限是 `requested − withdrawnTotal`，
逃生上限是 `cash + settled − withdrawnTotal`。所以換了幾期、鏡像晚了幾個區塊都一樣，同一筆錢不會領兩次。
鏈上的 `CashWithdrawn` 鏡像進帳本，先銷待提領，超出的部分（只可能是逃生）從可動用扣，必要時先撤掉該帳戶的買單。

### 前端與 API 的邊界

瀏覽器不直接連節點（`check:boundary` 擋），ABI 只在伺服器端；所有 API 回 `{ ok, data }` 或制式錯誤碼
（`check:api-envelope` 擋，錯誤碼在 `web/lib/error-codes.ts`）。

### 部署指紋

`web/data/.deployment.json` 記下資料屬於哪一次部署（帳本合約、結算幣、`deployedAt`）。對不上時申請與憑證紀錄一律擋下
（`DATA_STALE`），不悄悄拿舊的來用。anvil 重開後重新部署會得到相同地址，所以 `deployedAt` 不是多餘的。

### 舊的全合約版本

第 7 期之前的版本（KYCRegistry、CarbonRegistry、CarbonCredit1155、Listing、CarbonPool、Bank、PasskeyAccount、
Uniswap v4 hook／router）已經移除，保留在 git 歷史（`e86089d` 以前）。Boltchain 上 rules v2 的舊帳本合約
（`0x71034Ae8…`，區塊 26654）不再由本站使用。

---

## 十、Phase 0 限制與後續

- **拒收提領請求的缺口**：營運方持續提交承諾、卻只拒收某一人的提領請求時，逃生門不會開啟。
  目前靠簽章與沒有收據這件事申訴；鏈上強制收單（使用者直接在合約登記請求、下一期必須納入）列為後續。
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
| **Phase 2** | 正式。結算幣落地、指定做市商、第三方稽核、法遵定案、控制權移轉演練 | — |

---

## 授權

本 repo 的程式碼為 **MIT**（見 [`LICENSE`](LICENSE)），著作權人為卡菲卡金融科技股份有限公司。
`lib/` 底下的第三方元件以 submodule 引入，各依其原授權條款（forge-std：MIT／Apache-2.0；
OpenZeppelin Contracts：MIT；Safe Smart Account：LGPL-3.0）。
