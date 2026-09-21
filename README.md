# TideBit-DeFi 碳權交易所（Phase 0）

企業完成 ISO 14064-2 減量、14064-3 第三方查驗後，由查驗機構在鏈上簽章核發減量額度；
額度可掛單販售給個人、機構或其他企業，買方註銷後取得可附於申報文件的憑證。
由卡菲卡金融科技股份有限公司（CAFECA）建置，設計為控制權可完整移轉給國家單位、CAFECA 代運營。

品牌識別（logo、favicon、主色 #29c1e1→#1ae2a0）沿用 [CAFECA-IO/TideBit-DeFi](https://github.com/CAFECA-IO/TideBit-DeFi)。
鏈上的技術識別字串（EIP-712 domain `CO2Exchange KYCRegistry` / `CO2Exchange CarbonRegistry`、repo 名稱）
**維持原樣**：那是已部署合約的一部分，改動等於換一組簽章網域，所有既有 attestation 會失效。
品牌名與協定識別字串是兩件事，前者可以改，後者不該為了改名而動。

架構決策、風險與分期紀錄於 Claude project `CO2Exchange › claude/architecture-decisions.md`。

**要動手的人看這裡**：[營運手冊](#營運手冊) — [啟動（全新機器）](#啟動一台全新的機器)、[建立模擬資料](#建立模擬資料)、[更新](#更新)、[日常營運](#日常營運)、[持續運作](#持續運作展示機)、[出事的時候](#出事的時候)。
其餘章節是設計說明：[分層](#分層)、[治理](#治理safe--timelock)、[安裝](#安裝)、[部署到私有鏈](#部署到既有的私有鏈)、
[前端](#前端webnextjs-16--react-19)、[模擬市場](#模擬市場100-個有人格的帳戶)、[測試](#測試113)、[自我審查](#自我審查self-review--audit-prep)。

## 分層

```
帳戶層             PasskeyAccount / Factory  P-256 passkey 擁有的智能帳戶，CREATE2 決定地址，WebAuthn 驗簽（OZ P256）
身分層（UUPS）     KYCRegistry            政府憑證 attestation → tier / expiry / frozen / recover
登錄層（不可升級） CarbonRegistry         查驗機構 EIP-712 簽章核發、序號唯一、專案登錄、**轄區（國別）政策**
                   CarbonCredit1155       額度本體，白名單主防線在 _update；retire → 用途 × 轄區檢查 → 憑證
                   RetirementCertificate  ERC-721 註銷憑證（soulbound，含受益人 hash、用途、核發國、PDF hash）
                   ReserveAttestation     每月 5 日的託管與準備金對帳報告；查核機構簽署後不可修改
市場層（UUPS）     Listing                企業以專案名義定價掛單（Phase 1 主市場）
                   CarbonPool + CCT       同年份池化 ERC-20（只收國內額度）；即時市價買賣的交割層
市場層（不可升級） FeeSchedule            **各國**交易手續費（bps）與註銷手續費（每噸固定金額）
v4 模組（展示）    CarbonKYCHook          只接受 TrustedRouter、建池需 OPERATOR、每日限額以實際 delta 計
                   TrustedRouter          把 msg.sender 編進 hookData，直接在使用者與 PoolManager 間結算
mock               MockTWD                6 decimals 結算幣；正式由金融機構存款代幣化取代
```

白名單規則：持有與註銷永遠允許；轉帳需雙方有效且未凍結；自然人預設不可轉出（政策開關）；KYC 到期只擋交易不鎖資產。

**轄區規則**：每個專案帶一個核發國（ISO 3166-1 alpha-2）與機制名稱，額度與憑證都繼承。
國內額度（TW）四種註銷用途全開；國外額度只允許「扣除碳費排放量」與「自願性碳中和」——
氣候變遷因應法第 27 條把國外額度限縮到碳費與超額量抵銷，增量抵換（第 24 條）與環評承諾都做不到，
所以 `CarbonCredit1155.retire` 直接 revert，不是只在介面提示。轄區可由主權角色開啟／關閉；
關閉後不能再上架，但既有持有不受影響（流動性可以停，持有不能沒收）。
Phase 0 已開放：TW、JP（J-Credit）、KR（KOC）、TH（T-VER）、ID（SPE-GRK）、AU（ACCU）；
CN（CCER）與 IN（CCC）因跨境使用規定尚未訂定而關閉；SG 為買方框架，不核發額度。

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

## 營運手冊

五件事：**啟動**（從零到能用）、**建立模擬資料**（讓畫面上有東西可看）、**更新**（拉了新版之後要補做什麼）、
**日常營運**（每天／每月固定要做的）、**持續運作**（讓一台展示機一直活著）。
出事的時候看最後一段。

### 啟動：一台全新的機器

需要的東西只有三樣：git、Node 20+、curl。Foundry 由 `setup.sh` 自己裝。

```bash
# 1. 取得程式碼與依賴。setup.sh 會裝 Foundry、取出釘死版本的 submodule、build、test
git clone https://github.com/CAFECA-IO/CO2Exchange.git
cd CO2Exchange && bash setup.sh

# 2. 前端的依賴與設定
cd web && npm install && cp .env.example .env.local && cd ..

# 3. 鏈 + 部署 + 一年份的市場資料（一道指令，約三到五分鐘）
bash script/demo-box.sh rebuild

# 4. 前端（另一個終端）
cd web && npm run dev
```

開 <http://localhost:10010>，首頁的地球上應該有六個轄區亮著、旁邊清單有數字。

| | 埠 | 覆蓋方式 |
|---|---|---|
| 前端 | **10010** | `PORT=xxxx npm run dev`（e2e 則是 `BASE_URL`） |
| anvil | **28545** | `RPC=http://127.0.0.1:xxxx bash script/demo-box.sh rebuild`；`demo-box.sh` 會從這個位址推出 anvil 要開在哪個埠 |

前端與鏈都刻意避開預設埠（3000／8545）：那兩個埠上什麼都可能在跑，
連到別人的服務上而不自知，比連不上更難查。

> 只想把流程跑一次、不需要一年份的資料，第 3 步可以換成手動兩行：
> `anvil --port 28545 --prune-history`，另一個終端
> `forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"`。
> 差別是行情圖上只有一兩根 K 棒、地球上只有臺灣有柱子。

`.env.local` 至少要確認三件事：

| 變數 | 為什麼非看不可 |
|---|---|
| `RPC_URL` / `CHAIN_ID` | 對不上的話前端讀的是另一條鏈，畫面全空但不會報錯 |
| `ADMIN_EMAILS` / `VERIFIER_EMAILS` | `KYC_AUTO_APPROVE=0` 時**必須包含你自己登入用的 email**，否則申請會卡在沒有人能核准的佇列裡 |
| `RELAYER_PK` / `DOCUMENT_SIGNER_PK` | Phase 0 由平台代付 gas。這兩把在該鏈上沒餘額，建帳戶與註銷都會失敗 |

環境還在、只是關掉了（第二天開工）：

```bash
bash script/demo-box.sh rebuild     # 重新鋪一次（約三到五分鐘）
cd web && npm run dev
```

> Anvil 一關就忘光，所以預設是重鋪。想留住昨天的鏈，給 `demo-box.sh` 一個
> `STATE=~/anvil-state.json`，或自己開
> `anvil --port 28545 --state ~/anvil-state.json --prune-history`（`--state` 是 `--load-state`
> 與 `--dump-state` 的別名：檔案在就載入、關掉時寫回，第一次跑檔案不存在也不會失敗）。
> 這樣就不必每天重跑部署，前端 `web/data/` 的申請紀錄也還對得上——
> 那些紀錄是用**帳戶地址**當鍵的，鏈重開又重新部署就會對不上，
> 機制與處理方式見下面「出事的時候」。

**確認真的跑起來了**（三個都該有東西）：

```bash
./script/govern.sh status                                  # 治理角色是不是都在該在的地方
curl -s localhost:10010/api/market/ticker?hours=24 | head -c 200   # 行情讀得到鏈
curl -s localhost:10010/api/market/by-country | head -c 200        # 各轄區統計讀得到鏈
```

`govern.sh status` 印出來的那張表，每一格都該是 `true`，而且 `admin` 那一欄要指向 Timelock、
`sov` 指向國家 Safe。有 `false` 就是部署沒完成，不要繼續往下用。

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

`DemoFlowV4` 用 Anvil 預設帳戶：account0 = 國家單位 / 營運 / 身分驗證服務 / 查驗機構（Phase 0 合一），
account1 = 減量企業，account2 = 做市商，account3 = 自然人。流程：憑證 attestation 註冊 → 專案登錄 →
查驗簽章核發 100 噸 → 30 噸掛單、60 噸入池、做市商提供 v4 流動性 → 自然人從掛單與 v4 各買一次 → 兩邊註銷取得憑證。


### 建立模擬資料

`demo()` 只鋪一張最小的桌子：幾個專案、幾張掛單，夠把流程走一次，但行情圖上只有一兩根 K 棒、
首頁的地球只有一個國家有柱子。要讓畫面像個市場，有三個等級：

| 要什麼 | 用什麼 | 花多久 |
|---|---|---|
| 只要流程能走一遍 | `DemoFlowV4.s.sol` 的 `demo()` | 十幾秒 |
| 只要行情圖有 K 棒 | `SeedMarket.s.sol` + `npm run seed:market` | 一兩分鐘 |
| 要整個市場：多國、掛單簿厚薄、申報季波峰、每月託管報告 | `npm run simulate` | 三到五分鐘（一年份） |

**只要一條像樣的價格曲線**（不需要人物與多國資料）：

```bash
forge script script/SeedMarket.s.sol --rpc-url anvil --broadcast   # 掛出一批單
cd web && npm run seed:market -- --days 365 --per-day 3            # 逐筆買掉，每筆推進時間
```

每筆成交之間會推進區塊時間，K 棒才有時間軸可分；全程一個行程、keep-alive 連線，
不是每筆開一個 `cast`。

**要完整的市場**（首頁地球、各轄區統計、託管揭露都會有資料）：

```bash
# 1. 鏈要從一年前開始。回填只能把時間往前推，不能倒退
anvil --port 28545 --timestamp $(( $(date +%s) - 365*86400 )) --prune-history

# 2. 部署
forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"

# 3. 回填。--from 要晚於鏈上現在的時間
cd web
npm run simulate -- --dry-run                              # 先看人物名冊，不送任何交易
npm run simulate -- --from 2025-11-25 --tick 8h --quiet    # 回填到現在，約 3–5 分鐘
```

跑完會有：約 3,600 筆交易、十七萬噸核發、十五萬噸成交、九個轄區的掛單簿，以及十一期每月託管對帳報告。
參數與人物設定見下面「模擬市場」。

**這三件事不照做就會踩到：**

1. **`--prune-history` 不是可選的。** anvil 預設把每個區塊的歷史狀態寫到 `~/.foundry/anvil/tmp/`，
   五千筆交易下來好幾 GB，而且**每次重開 anvil 都留一份**——磁碟會在你還沒發現的時候滿掉。
   歷史狀態對這裡沒有用：行情、公告欄與託管揭露讀的是事件與區塊標頭，那兩樣 `--prune-history` 都會保留。
   已經滿了就清掉（anvil 沒在跑的時候）：`rm -rf ~/.foundry/anvil/tmp/*`
2. **`--from` 必須晚於鏈上現在的時間。** 回填用 `anvil_setTime` 推進時間，而區塊時間只能往前。
   對不上的時候腳本會直接印出該用的 anvil 指令，不會跑到一半才爆。
3. **模擬跑的時候不要同時用前端下單。** 模擬器假設自己是鏈上唯一的寫入者，
   掛單簿與持有量都在記憶體裡跟著更新（這是一年份回填能從「幾萬次 RPC」降到「幾千筆交易」的原因）。

**續跑與重來：**

```bash
npm run simulate -- --from <上次停的日期> --tick 8h   # 接著跑：會從鏈上把狀態全部認回來
npm run simulate                                      # 持續模式：依真實時間每分鐘一輪
```

續跑會把已註冊的帳戶、持有量、掛單簿、已登錄的專案與已發布的對帳期別認回來，
參考價由掛單簿的中位數推回——不會把同一個開發者的專案再登錄一次，也不會讓價格跳回起始值。
要完全重來就重開 anvil，然後回到第 1 步。

### 更新

拉了新版之後要補做什麼，看你改動了什麼：

| 改了什麼 | 要做的事 |
|---|---|
| 只有前端（`web/app`、`web/components`） | `npm run dev` 熱更新就好 |
| 前端依賴（`web/package.json`） | `cd web && npm install` |
| 合約原始碼（`src/`） | `forge build && forge test` → `forge snapshot`（更新 gas 基準線）→ `cd web && npm run gen:errors`（重產 error 對照表）→ **重新部署** → `npm run data:reset` |
| 合約的自訂 error | `cd web && npm run gen:errors`。**漏了這步，前端的 revert 會退回顯示 `0x…` 四個位元組**——使用者看不出是沒簽契約還是餘額不足 |
| 部署腳本或治理參數 | 重新部署 → `./script/govern.sh status` 確認角色都對 |
| 合約依賴（`lib/`，git submodule） | `git submodule update --init --recursive` → `forge build` |
| 契約條文（`web/contracts/*.md`） | 不必重部署，但**條文雜湊會變，既有同意紀錄失效、使用者要重簽**——這是預期行為 |
| 地球的地理資料 | 只有要換底圖或加轄區才需要重跑 `scripts/gen-globe-mask.py`（來源 `scripts/world-land-0.6deg.json.gz` 也在版控裡），產生出來的 `lib/globe-mask.ts` 已經在版控裡 |

合約改了就一定要重新部署，重新部署就一定要處理 `web/data/`：

```bash
forge build && forge test
anvil --port 28545 --prune-history                                 # 重開鏈
forge script script/DemoFlowV4.s.sol --rpc-url anvil --broadcast --sig "demo()"
cd web && npm run data:reset                                       # 搬到 data.bak-<時間戳>，不是刪除
npm run build && npm run e2e                                       # 收工前跑一次
```

`data:reset` 為什麼跳不過，見下面「出事的時候 › 重新部署之後」。備份裡有使用者上傳的身分文件，
確認不需要再自行刪除；想把兩個部署的資料分開留著，設 `DATA_DIR` 指到不同資料夾即可。

**發版前的檢查清單：**

```bash
forge test                          # 113 個合約測試
forge snapshot --check --no-match-contract "FuzzTest|PoolInvariantTest"   # gas 有沒有非預期的迴歸
cd web && npm run lint && npm run build
npm run e2e                         # 三條流程，需 KYC_AUTO_APPROVE=0

# shell 腳本：變數展開後面不可以直接接中文字（見下）
grep -nP '\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]' ../script/*.sh ../setup.sh
```

> 最後那一條 grep 要是有輸出就是有問題。**macOS 內建的是 bash 3.2**，它會把緊接在變數
> 後面的多位元組字元當成識別字的一部分——`"每輪 $TICK）"` 會被解析成變數 `TICK<位元組>`，
> 在 `set -u` 之下直接 unbound variable 而中斷。在 Linux 的 bash 5 上完全正常，
> 所以這個 bug 只會在使用者的 Mac 上出現。規則很簡單：**後面接中文就用 `${VAR}`**。
> 這個坑這個專案已經踩過兩次（`preflight.sh` 檔頭就寫著同一段警告）。

### 日常營運

Phase 0 的營運動作分三種節奏。**誰做**那一欄很重要：營運方做得到的事情是刻意被限縮的，
凍結、開關轄區、換查驗機構這些都要國家 Safe。

| 節奏 | 做什麼 | 誰 | 在哪 |
|---|---|---|---|
| 每天 | 審 KYC 申請（核准＝簽 attestation 上鏈） | 管理員（`ADMIN_EMAILS`） | `/admin` › KYC 審核 |
| 每天 | 審核發申請（檢視 ISO 14064-3 報告與雜湊 → 簽章核發或退回） | 查驗機構（`VERIFIER_EMAILS`） | `/verifier` |
| 每天 | 產生註銷憑證 PDF 並把 SHA-256 回寫鏈上 | 管理員 | `/admin` › 憑證文件 |
| 每月 5 日 | 發布託管與準備金對帳報告，查核機構簽署 | 報表金鑰 + 查核機構 | **見下方警告** |
| 不定期 | 調整各轄區交易費（bps）與註銷費（每噸） | 管理員（服務金鑰持 `PRICING_ROLE`） | `/admin` › 費率設定 |
| 不定期 | 認可／撤銷查驗機構、停用專案 | 國家 Safe | `govern.sh build approve-verifier` / `revoke-verifier` / `set-project-active` |
| 不定期 | 開啟／關閉轄區 | 國家 Safe | **見下方警告** |
| 緊急 | 凍結地址或批次、暫停市場、撤換營運方 | 國家 Safe（即時，不等 48h） | `script/govern.sh` |
| 結構變更 | 升級合約、變更主權歸屬 | 國家 Safe → Timelock 48h | `script/govern.sh` |

> ⚠️ **兩個已知的營運缺口**，不是還沒寫進文件的功能，是真的還沒有人做得了：
>
> 1. **每月 5 日的託管報告沒有營運端介面。** `/custody` 與 `/api/custody` 都是唯讀的，
>    鏈上真正會呼叫 `ReserveAttestation.publish()` 的只有模擬器（`web/scripts/simulate.mjs`）。
>    Phase 0 的展示資料靠模擬器產生；正式營運前必須補上報表端介面或腳本，
>    否則平台在首頁與契約裡承諾的「每月 5 日公開對帳」沒有人執行得了。
> 2. **開關轄區沒有進 `govern.sh`。** `CarbonRegistry.setJurisdiction()` 要 `SOVEREIGN_ROLE`，
>    但 `govern.sh build` 沒有對應的子指令，現在得自己用
>    `cast calldata 'setJurisdiction(bytes2,(bool,bool,uint8,string,string,string,string))' 0x<國碼> '(...)'`
>    組出 calldata 再丟給 `safe national hash|exec`。開一個轄區是主權行為，
>    這條路徑應該跟凍結、撤換查驗機構一樣有現成指令。

治理操作一律是「組 calldata → 簽 → 執行」三步，`govern.sh` 把 cast 包起來：

```bash
./script/govern.sh status                                  # 先看現況
./script/govern.sh build freeze 0x<地址> true              # 組出 target + calldata
./script/govern.sh safe national hash <target> <calldata>  # 算出要簽的 hash
./script/govern.sh sign <hash> <私鑰>                      # 各簽章者各自簽
./script/govern.sh safe national exec <target> <calldata> <簽章串>
```

要走 Timelock 的（升級、主權變更）中間多一段 `timelock schedule` → 等 48 小時 → `timelock execute`，
`timelock state` 查現在到哪一步。完整 SOP（緊急凍結、升級、簽章者管理、移轉驗收）
見 project 文件「CO2Exchange 治理操作手冊」。

### 持續運作（展示機）

想讓一台機器一直開著、資料一直看起來是新的，有一件事必須先知道：

> ⚠️ **持續模式跑大約一個小時，一年份的需求就用完了。**
> 實測每輪成交約 1,590 噸，而非做市商的年度採購額度合計 95,408 噸——
> 以 `--interval 60` 算，大約 60 輪、一小時就見底。之後買方全部收手
> （年度預算是刻意設的，見「模擬市場」），只剩做市商還在掛單成交，
> 畫面看起來像市場停了。要等到模擬世界的隔年一月，額度才會重置。

所以展示機的作法**不是「跑一次然後放著」，而是每天重建一次**：

```bash
# 每天早上六點重鋪一年份的市場
0 6 * * *  cd /path/to/CO2Exchange && bash script/demo-box.sh rebuild >> /tmp/demo-box.log 2>&1
```

重建是安全的：Anvil 從同一個部署者、同樣的 nonce 順序跑同一支腳本，
**十七個合約地址一字不差**（只有部署檔裡的 `deployedAt` 會變）。
前端的設定不用動，使用者的 passkey 地址也還是同一個——那是 CREATE2 從公鑰算出來的。

只有 `web/data/` 需要注意：那裡的 KYC 與核發申請是用帳戶地址當鍵的，
鏈上狀態歸零之後它們對不到任何東西，所以指紋檢查會擋下來並回 `503 DATA_STALE`。
`demo-box.sh rebuild` 會在部署之後自己跑一次 `data:reset`（搬到 `data.bak-<時間戳>`，不是刪除），
所以走這條路不用自己記得。手動重新部署才需要自己補那一行。
展示機另外建議設 `KYC_AUTO_APPROVE=1`（申請直接核准，不留佇列）。

**想在白天看到即時的成交**，重建之後再掛上持續模式：

```bash
bash script/demo-box.sh live -- --interval 60
```

它會依真實時間每分鐘跑一輪。跑滿一小時左右買方收手是預期的——
隔天早上的 rebuild 會把一切重來。不要為了讓它撐久一點而調大 `--interval`：
那只是把同樣的額度攤在更長的時間裡，市場反而更冷清。

**讓它活過重開機。** 這三個行程要有人看著：anvil、Next.js、（可選的）模擬器。
macOS 用 launchd，Linux 用 systemd；最省事的是讓 `demo-box.sh rebuild`
在開機時跑一次，前端用 `npm run build && npm start`（不是 `npm run dev`）。

```ini
# /etc/systemd/system/co2x-web.service
[Unit]
After=network.target
[Service]
WorkingDirectory=/path/to/CO2Exchange/web
Environment=KYC_AUTO_APPROVE=1
ExecStart=/usr/bin/npm start
Restart=always
[Install]
WantedBy=multi-user.target
```

**磁碟**：`--prune-history` 已經寫進 `demo-box.sh`，但每次重開 anvil 仍會在
`~/.foundry/anvil/tmp/` 留一份；`rebuild` 每次都會先清掉那個資料夾，
所以照這個流程走不會累積。手動開 anvil 的話要自己留意，見「建立模擬資料」。

**確認它還活著**：

```bash
bash script/demo-box.sh status
```

### 出事的時候

| 症狀 | 多半是 |
|---|---|
| 畫面全空、沒有錯誤訊息 | `.env.local` 的 `RPC_URL` / `CHAIN_ID` 對到另一條鏈 |
| 建帳戶或註銷失敗 | `RELAYER_PK` / `DOCUMENT_SIGNER_PK` 在該鏈上沒餘額（Phase 0 平台代付 gas） |
| KYC 申請卡住沒人能核准 | `KYC_AUTO_APPROVE=0` 但 `ADMIN_EMAILS` 沒有你登入用的 email |
| 部署腳本最後一筆 `AttestationExpired` | anvil 閒置太久，見下 |
| 重新部署後畫面有資料但對不上鏈 | `web/data/` 的舊紀錄，見下 |
| 磁碟莫名其妙滿了 | `~/.foundry/anvil/tmp/` 的歷史狀態，見「建立模擬資料」 |
| 首頁地球轉但沒有柱子 | 鏈上還沒有核發資料，跑 `bash script/demo-box.sh rebuild` |
| 前端報 `0x` 開頭的八位十六進位、看不出原因 | `web/lib/error-abi.ts` 沒跟上合約，`cd web && npm run gen:errors` |
| 市場突然安靜、只剩零星成交 | 持續模式把年度需求跑完了，見「持續運作」 |

#### `AttestationExpired`：部署腳本最後一筆交易失敗

症狀：`forge script ... --broadcast` 模擬成功、前面上百筆交易都 ✅，然後在
`kyc.register` 那筆 ❌，只花三萬 gas。原因是 **anvil 閒置太久**：

forge 模擬時讀到的是鏈上**最後一個區塊**的時間戳，而 anvil 沒有新交易就不產生新區塊；
等到真的送出交易，anvil 才用**現在的真實時間**打上時間戳。中間這段閒置如果超過簽章的
有效期，attestation 送到鏈上就已經過期了，而錯誤訊息只有一句 `AttestationExpired`。

解法：**重開 anvil**。demo 與種子腳本的簽章有效期已放寬到一年（`DEMO_SIG_TTL`），
正常不會再遇到；正式環境的 attestation 由簽章服務即時簽發，短效期才是對的。

#### 重新部署之後：`web/data/` 的舊紀錄

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

### 前端不直接跟區塊鏈說話

瀏覽器裡**沒有**任何一條連到節點的 RPC 連線。所有鏈上讀寫都經過 `web/app/api/*`，
由伺服器端的 `publicClient`（`lib/server/chain.ts`）執行。`/api/config` 也不回傳
RPC 位址——前端根本不知道節點在哪。

這條界線的實際差別：

- **節點不必公開。** 位址一旦發給瀏覽器就等於公開，任何人都能拿它對節點發請求。
- **只有一條鏈。** 瀏覽器連得到的節點與伺服器連得到的節點不一定是同一個（內網節點、
  IP 白名單、公司防火牆），兩邊各讀一次就會各看到一份狀態，而畫面不會告訴你這件事。
- **ABI 只有一份。** 合約改版時不必擔心某個使用者的瀏覽器還快取著舊的那一份。

唯一留在瀏覽器的鏈相關動作是 **passkey 簽章**——私鑰在裝置的安全元件裡，非在本機簽不可。
但「要簽什麼」仍由後端算：`POST /api/relay/prepare` 回 `nonce` 與 `digest`，
瀏覽器簽完再 `POST /api/relay` 交給 relayer 送出。

`npm run check:boundary`（已併進 `npm run e2e`）會掃過所有會進瀏覽器的檔案，
擋下 `createPublicClient`、指向節點的 `http()`、`rpcUrl` 與 `@/lib/server/*` 的值匯入。
這條規則很容易在某次「先動起來再說」的修改裡被破掉，而破掉時不會有任何測試變紅。

### 頁面

四種角色、十一個頁面：

| 角色 | 頁面 | 內容 |
|---|---|---|
| 自然人 / 法人 | `/`、`/kyc`、`/trade`、`/portfolio`、`/retire` | 首頁＝市場現況（地球＋各轄區清單）→ 登入 → passkey 建帳戶 → 身分驗證申請 → 交易（買賣同頁、限價與市價、下單前確認單）→ 我的資產（持有、成本、損益、**註銷憑證**）→ 註銷 |
| 任何人（免登入） | `/about`、`/registry`、`/custody`、`/agreements`、`/agreements/<id>` | 認識碳權（制度說明與行情圖表）、公告欄（TCER 五分頁 + 轄區）、託管與稽核揭露（每月 5 日）、七份契約與條款全文（五份定型化契約 + 網站服務條款 + 隱私權政策，每份一個網址） |
| 法人 | `/enterprise` | 登錄專案、上傳 ISO 14064-3 查驗報告申請核發、批次掛單 / 入池、取消掛單 |
| 查驗機構（`VERIFIER_EMAILS`） | `/verifier` | 待查驗佇列：檢視報告與雜湊 → 簽署 IssuanceAttestation 核發，或退回 |
| 管理員（`ADMIN_EMAILS`） | `/admin` | KYC 審核佇列（核准 = 簽 attestation 上鏈）、憑證 PDF 產生與 `documentHash` 回寫、**各國費率設定**、治理狀態（角色矩陣、Safe、Timelock 排程） |

### 首頁的地球

首頁是**市場現況**：一顆會轉的點陣地球，柱子的高度是各轄區的核發量（或交易量、成交均價，
可以切換），旁邊是同一份資料的清單。

第三個量原本是「掛單量」——掛單簿上現在有幾噸。那個數字不回答任何人真正想問的問題：
它隨著誰剛好在掛單而跳動，多不代表便宜，少也不代表搶手。換成**成交均價**（近一年、
以成交量加權）：同樣一噸碳在哪一國要花多少錢，這才是把六個轄區並排比較的理由。
加權而不是取最後一筆，是因為最後一筆可能是某個人買 0.1 噸留下的。制度說明——什麼是自願減量專案、巴黎協定第六條、
ISO 14064、額度能用在哪——連同 K 線與市場概況全部在 `/about`。
那些是進場前讀一次的東西，不是每天回來要看的東西。

**地球不負責讓人讀出數字。** 球面會把靠近邊緣的柱子壓短，透視也會讓正對鏡頭的那一根
看起來比較長；要比較量就看旁邊清單裡的水平長條，那裡沒有曲面。地球回答的是
「在哪裡、大概多少」，清單回答「精確是多少」。同理，一次只畫一個量——
三個量的性質差很遠（核發是累計、交易是區間、價格是比率），疊在同一顆球上就得畫兩把尺，
而讀者無法從一根柱子判斷它用的是哪一把。

清單才是可近用的那一份：畫布掛 `aria-hidden`，每一國在清單裡都是一個真的按鈕，
鍵盤與螢幕報讀器走那條路。`prefers-reduced-motion` 之下地球不自轉。

實作是**零依賴的 Canvas 2D**，沒有 three.js、沒有 WebGL：正交投影下地球的輪廓永遠是正圓，
每個點的縮放係數都一樣，柱子的長度才有可比性。深淺兩色都能上色（`--globe-ocean`／
`--globe-land` 兩個變數），沒有 WebGL 的裝置照常運作。

地理資料壓在 `web/lib/globe-mask.ts` 裡，約 18KB，由 `web/scripts/gen-globe-mask.py` 產生：

```bash
npm pack world-atlas@2 && tar xzf world-atlas-*.tgz
pip install matplotlib numpy
python3 scripts/gen-globe-mask.py ./package > lib/globe-mask.ts
```

分成兩層是有原因的。均勻取樣的球面點陣畫得出澳洲，畫不出臺灣——要讓臺灣拿到看得出
形狀的點數，全球得鋪到六位數個點，那既跑不動也送不動。所以底圖只負責陸地輪廓，
九個轄區另外用各自的密度取樣：大國疏、小國密，每一國都是看得出形狀的一塊，
而不是一個圓點。

底圖是 **0.6 度的經緯格點**（`web/scripts/world-land-0.6deg.json.gz`，59,443 格陸地），
一格一個位元、列優先做 RLE + deflate，289×600 格只花 5,740 個字元；座標不存，前端從索引
算回經緯度。格線的好處是可以拿一份地圖逐格核對——換成「算出點的位置、再問程式庫那裡是不是
陸地」的做法，畫出來的海岸線就是那個程式庫的解析度，對不對只能用看的。

畫面上不會把 59,443 格全部畫出來：`lib/globe.ts` 以 2×2 為一塊抽稀成約 9,500 個點
（赤道間距約 133 公里），經度方向再除以 `cos(緯度)`，點在**地表上**才是等距的。抽稀是
「整塊裡有一格是陸地就留一個點，位置取塊內離中心最近的那一格陸地」——只取每塊的固定
那一格的話，日本、中美洲、島鏈這種一格寬的地形會整段消失。要更密或更疏改 `BASE_POOL`
一個常數，資料不用重產。

來源是 0.6 度陸地格點與 Natural Earth 1:50m 國界，皆為公有領域。

`/trade` 的買進與賣出共用同一個下單面板，使用者只處理**數量**與**單價**；最小成交量與使用期限有預設值、收在「進階」裡。
送出前一律跳出確認單，把成交條件、費用、對方與待簽的定型化契約攤開，按下去就是簽章上鏈。
註銷另開 `/retire`——註銷是「用掉」不是「賣掉」，而且自然人做不了，混在下單頁裡會讓人以為買完就該註銷。
`/portfolio` 以**移動加權平均成本**算持有成本，已實現與未實現損益分開列；核發取得的部位成本以 0 計並在介面標示。
註銷憑證併在同一頁——憑證是「已經用掉的那一部分」的收據，跟資產是同一件事的兩面。

**限價與市價**：限價是掛單簿（指定專案與價格）；市價是即時成交，只填數量。
市價買進在同一筆 passkey 簽章裡做完「換到額度」與「**立刻拆解成具體批次**」兩件事——
使用者的持有清單裡只會有帶專案、年份、核發國的碳權批次，不會出現中介代幣。
技術上走 v4 池（精準輸出換入 + FIFO 贖回），但那是實作細節，介面上不出現「池」這個概念。

**託管與揭露**：碳權託管在各國政府的官方登錄簿帳戶（國內＝專案方於環境部開立的額度帳戶，
國外＝本站於該國登錄簿的託管帳戶），入金託管在信託專戶。每月 5 日發布對帳報告、查核機構簽署上鏈，
公開於 `/custody`；該頁同時顯示**本頁自己從鏈上事件算出來的**流通量，兩欄並列，看得出報告有沒有對上事實。

**費率**：`/admin` 的「費率設定」可逐一轄區設定交易手續費（bps，上限 5%）與註銷手續費（每噸固定金額），
未設定者走預設值。兩者單位不同是刻意的——註銷是代辦一次官方移轉與註銷申請，成本按件與按量算，與市價無關。

`KYC_AUTO_APPROVE=1` 時申請直接核准（demo）；`0` 時進管理後台佇列——**這時 `ADMIN_EMAILS` 必須包含你自己登入用的 email**，
否則申請會卡在沒有人能核准的佇列裡（要走查驗核發那條線同理，`VERIFIER_EMAILS` 也要加）。憑證 PDF 用 `fonts/NotoSansTC-Subset.otf`（Big5 常用字子集），
檔案 SHA-256 由 `DOCUMENT_SIGNER_PK`（`DOCUMENT_ROLE`）回寫鏈上，任何人可重算比對。

錢包架構：`PasskeyAccount`（P-256 passkey 是唯一擁有者，地址由公鑰經 CREATE2 決定，換裝置不變）。
Phase 0 交易由平台 relayer 代送 `execute`（`/api/relay`，gas 由平台付），授權來自使用者的 WebAuthn 簽章，relayer 無法竄改內容；
Phase 1 換成 ERC-4337 EntryPoint + paymaster，帳戶簽章格式與 nonce 語意不變。

Apple / Google 登入：在 `.env.local` 設 `AUTH_GOOGLE_ID/SECRET`、`AUTH_APPLE_ID/SECRET` 後自動出現；登入只建立 session，不是身分根。

端到端測試（Chromium 虛擬 passkey，需 `npx playwright install chromium`）：`npm run e2e` 跑三條流程 ——
`e2e/flow.mjs`（自然人：KYC 人工核准 → 購買 → 註銷 → 管理員產生 PDF 並回寫 → 下載）、
`e2e/enterprise.mjs`（法人 KYC → 專案登錄 → 上傳報告 → 查驗核發 → 掛單 + 入池 → 另一自然人購買並註銷）與
`e2e/globe.mjs`（首頁地球與各轄區清單：資料、選取、換量、減少動態、手機不橫捲，以及 `/about` 的章節有沒有搬齊）。
需 anvil + DemoFlowV4 + `KYC_AUTO_APPROVE=0` 的伺服器。

e2e 等的是 `data-testid` 標記的**狀態**，不是畫面上的某一句話。之前帳戶建好與否是等
「帳戶已就緒」四個字，於是改一次文案就有三個測試掛掉——掛的不是功能，是字串。

## 模擬市場（100 個有人格的帳戶）

怎麼跑見上面「營運手冊 › 建立模擬資料」，這一節講的是**裡面是什麼**：參數、人物模型，
以及為什麼要這麼做。要看見「市場的樣子」——申報季的量能、掛單簿的厚薄、價格的走勢——
需要一批**會照自己的理由行動**的人，而不是一批亂數。

| 參數 | 預設 | 說明 |
|---|---|---|
| `--users N` | 100 | 帳戶數。錢包由 anvil 助記詞的 index 100 起推導，避開預設十個帳戶 |
| `--from DATE` | — | 回填起點（`YYYY-MM-DD`）。不給就是持續模式 |
| `--tick DUR` | `6h` | 回填時每一輪代表多久（`30m` / `8h` / `1d`） |
| `--interval SEC` | 60 | 持續模式的實際間隔秒數 |
| `--seed S` | `co2x` | 人物種子。**同一個種子一定產生同一批人**，出問題可以重現、截圖可以重拍 |
| `--quiet` | — | 只印每 40 輪的摘要 |

**人物不是隨機的。** 每個帳戶有角色（專案開發者／碳價履約對象／自願宣告企業／開發案抵換／做市商／
個人投資者）、產業、排放規模、申報地、心理價位、活躍度，以及願意用多少比例的國外額度。行為從這些設定推導：

- **申報季會塞車**。臺灣碳費 5 月底前申報、韓國 K-ETS 6 月底履約、日本 3 月年度結算——
  各國的月份不同，所以量能不是一條均勻的雜訊，而是幾個錯開的波峰。
- **法規限制真的會擋**。高碳洩漏風險事業（鋼鐵、水泥、石化）不買國外額度；
  開發案抵換只認本地額度；自然人不註銷（官方登錄簿不開個人帳戶）。
  這些不是模擬器自己客氣，是合約層會 revert，模擬器只是不去撞牆。
- **供給有上限**。一個專案一年核發不出比它實際減下來更多的額度。
  沒有這條，模擬器會變成一個無限印額度的水龍頭，掛單簿就成了一面永遠填不完的牆。

續跑、回填的時間限制、`--prune-history`，都在「營運手冊 › 建立模擬資料」。

## 測試（113）

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
| `Jurisdiction.t.sol`（新增） | 國別屬性：國內專案預設 TW、國外專案只有主權角色能登錄、憑證載明核發國、國外額度的增量抵換與環評承諾被鏈上擋下、關閉轄區後不能上架但仍可轉讓、池化拒收國外額度 |
| `Reserve.t.sol`（新增） | 託管揭露：只有報表金鑰能發布、只有查核機構能簽署、簽署後不可再改、更正以新報告發布且舊報告保留、空報告被拒 |
| `FeeSchedule.t.sol`（新增） | 各國費率：預設值與專屬費率、清除後回到預設、交易費上限 5%、註銷費按每噸固定金額收取（預設 0）、只有 PRICING_ROLE 能調、只有額度合約能收費 |
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
  **改了合約就要重跑 `forge snapshot` 更新基準線並一起提交**，否則下一個人跑 `--check` 會看到一堆
  與他無關的差異，然後學會忽略這個檢查——那比沒有這個檢查更糟。
- **尚未涵蓋**：正式第三方合約稽核、形式驗證（如 Certora）、經濟/賽局面攻擊面分析、跨合約 MEV/夾單分析、
  正式 bug bounty。這些屬 Phase 1/2 範疇，見下方「尚未包含」與 project 文件的分期規劃。

## 授權

本 repo 的程式碼為 **MIT**（見 [`LICENSE`](LICENSE)），著作權人為卡菲卡金融科技股份有限公司。
`lib/` 底下的第三方元件以 submodule 引入，各依其原授權條款，其中一項要特別注意：

`lib/v4-core/src/PoolManager.sol` 為 **BUSL-1.1**（interfaces 與 `Hooks` library 為 MIT）。
本 repo 的 v4 模組僅供非生產展示；國家單位正式營運屬生產使用，需 Uniswap Additional Use Grant、等 Change Date、或改用自寫 AMM。
Phase 1 主市場為 `Listing`，不依賴 v4。

## 尚未包含（Phase 0 後續）

- ERC-4337 EntryPoint + paymaster（目前為 relayer 代送）
- 查驗機構自行簽章（目前簽章金鑰在本站 `CARBON_VERIFIER_PK`）
- 身分驗證服務：工商憑證 / 自然人憑證 / TW FidO 驗證後端（目前以簽章金鑰模擬）
- Besu + QBFT 四節點測試網（需啟用 Cancun / EIP-1153）
