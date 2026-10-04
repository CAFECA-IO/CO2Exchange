#!/usr/bin/env bash
# 展示機：把資料鋪起來，然後（可選）持續跑。
#
# **目標鏈由設定決定，不是寫死 anvil。** 這支腳本看 `RPC_URL`（與 web/.env.local
# 同一個變數），只有在那條鏈是**本機開發鏈**（chainId 31337 / 1337）時才會去
# 管理 anvil 行程。正式與測試環境都不用 anvil——anvil 只出現在開發與自動測試裡。
#
# 這個分野是實質的，不只是換個位址：
#   · 本機鏈可以砍掉重來、可以把時間調到一年前再回填（anvil_setTime）。
#   · 外部鏈兩件都做不到。鏈不是我們的，時間也不是我們的。所以外部鏈上
#     「rebuild」這個動作不存在，只有「部署一次」與「從現在開始鋪資料」。
#
#   bash script/demo-box.sh rebuild      # 僅本機鏈：新鏈、部署帳本合約、回填 LEDGER_DAYS 天、提交第一期
#   bash script/demo-box.sh deploy       # 部署到設定的那條鏈（外部鏈＝bootstrap.sh deploy）
#   bash script/demo-box.sh seed         # 鋪資料（本機＝回填；外部＝模擬人物從現在開始交易 EXT_TICKS 輪）
#   bash script/demo-box.sh commit       # 提交一期承諾（先完整查核，不過就不送）
#   bash script/demo-box.sh commit-loop  # 每 COMMIT_EVERY 秒提交一期，並寫出每期的公開檔（前景，Ctrl-C 結束）
#   bash script/demo-box.sh live         # 等於 commit-loop；做市與模擬交易由 npm run mm 管（/admin「做市」頁）
#   bash script/demo-box.sh status       # 現在是什麼狀態
#
# 鏈上只有帳本合約（script/DeployLedger.s.sol）：資料是鏈下的簽章事件，每小時一期承諾上鏈。
#
# 環境變數：
#   RPC_URL=http://127.0.0.1:28545   目標鏈。與 web/.env.local 同名同義
#   LEDGER_DAYS=60 LEDGER_USERS=40   本機回填的規模（事件時間回溯，收單區塊是現在）
#   SIM_USERS=30 EXT_TICKS=10 EXT_INTERVAL=30   外部鏈 seed 的規模
#   COMMIT_EVERY=3600                承諾的間隔（秒）
#   金鑰：外部鏈一律讀 web/.env.local（bootstrap.sh keys 產生）。shell 裡的同名變數會蓋過它
#   WEB=http://localhost:10010
#   STATE=          給 anvil --state 的檔案（只有本機鏈用得到）
set -euo pipefail

# 變數展開後面接中文字時一定要用 ${VAR} 大括號。macOS 內建的 bash 3.2 會把後面的
# 多位元組字元當成識別字的一部分，於是 "$VAR）" 變成變數 "VAR<byte>"，
# 在 set -u 之下直接 unbound variable。preflight.sh 早就踩過同一個坑。

cd "$(dirname "$0")/.."
ROOT=$(pwd)
# RPC_URL 是正式名稱（web 也讀這個）。RPC 是舊名，留著相容，但會提醒。
if [ -n "${RPC:-}" ] && [ -z "${RPC_URL:-}" ]; then
  echo "!! RPC 這個變數名已經換成 RPC_URL（與 web/.env.local 一致）。這次仍照舊處理。" >&2
  RPC_URL=$RPC
fi
# shell 沒給就讀 web/.env.local——bootstrap.sh 部署完會把 RPC_URL 寫在那裡，
# 網站讀的也是它。兩邊都沒有才退回本機鏈。
if [ -z "${RPC_URL:-}" ] && [ -f web/.env.local ]; then
  RPC_URL=$(sed -n 's/^RPC_URL=//p' web/.env.local | tail -1)
fi
RPC_URL=${RPC_URL:-http://127.0.0.1:28545}
WEB=${WEB:-http://localhost:10010}
LOG=${LOG:-$ROOT/.demo-box}
mkdir -p "$LOG"
LEDGER_DAYS=${LEDGER_DAYS:-60}
LEDGER_USERS=${LEDGER_USERS:-40}
COMMIT_EVERY=${COMMIT_EVERY:-3600}

export PATH="$HOME/.foundry/bin:$PATH"

rpc_up () { curl -fs --max-time ${RPC_TIMEOUT:-8} -X POST "${RPC_URL}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' >/dev/null 2>&1; }

# 連不上就回空字串。**這個函式不該有能力終止腳本**——它只是在探測。
#
# 原本寫成一條 curl | sed 的管線，而 `set -o pipefail` 會把 curl 的逾時（exit 28）
# 變成整條管線的結果，於是 `id=$(chain_id)` 在 `set -e` 之下直接讓腳本死掉，
# 連一句「那條鏈沒有回應」都印不出來。探測失敗是**預期中的一種答案**，不是錯誤。
chain_id () {
  local out
  out=$(curl -fs --max-time "${RPC_TIMEOUT:-8}" -X POST "${RPC_URL}" \
        -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' 2>/dev/null) || return 0
  printf '%s' "$out" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p'
}

# 這條鏈是不是「我們可以砍掉重來」的本機開發鏈。
#
# 判準是 **chainId**，不是主機名。理由：127.0.0.1 上也可能跑著一條我們不該亂動的
# 鏈（別的專案、或一個對外服務的節點的本機代理），而 31337 / 1337 是 anvil 與
# hardhat 的慣例值，拿它當判準才對得上「這是一條可拋棄的開發鏈」這個意思。
# 連不上的時候看 CHAIN_ID，再不然看位址是不是 localhost——那是「還沒開起來的
# 本機 anvil」唯一合理的解釋。
is_local () {
  local id
  id=$(chain_id)
  if [ -n "$id" ]; then
    [ "$((id))" = "31337" ] || [ "$((id))" = "1337" ]
    return
  fi
  if [ -n "${CHAIN_ID:-}" ]; then
    [ "${CHAIN_ID}" = "31337" ] || [ "${CHAIN_ID}" = "1337" ]
    return
  fi
  case "$RPC_URL" in *127.0.0.1*|*localhost*|*'[::1]'*) return 0;; *) return 1;; esac
}

# anvil 要開在哪個埠，從 RPC 位址推出來——兩個地方各寫一次遲早會不一致
ANVIL_PORT=$(printf '%s' "$RPC_URL" | sed 's|.*:||; s|/.*||')
case "$ANVIL_PORT" in ''|*[!0-9]*) ANVIL_PORT=28545;; esac

banner () {
  local id; id=$(chain_id)
  if [ -n "$id" ]; then
    echo ">> 目標鏈 ${RPC_URL}（chainId $((id))，$(is_local && echo '本機開發鏈' || echo '外部鏈')）"
  else
    echo ">> 目標鏈 ${RPC_URL}（目前沒有回應）"
  fi
}

refuse_external () {
  cat >&2 <<MSG
!! rebuild 只適用於本機開發鏈（chainId 31337 / 1337）。

   目前的目標是 ${RPC_URL}，那不是一條我們可以砍掉重來的鏈：
     · 鏈不是我們的，停不掉也重開不了。
     · 時間不是我們的，沒有 anvil_setBalance，回填的入金做不到。
     · 每天重新部署會讓前一次的部署變成孤兒，而上面可能有真的餘額。

   外部鏈上要做的是這三件事，分開執行：
     bash script/bootstrap.sh          # 建金鑰 → 撥款 → 部署（只做一次）
     bash script/demo-box.sh seed      # 從現在開始鋪資料（縮時，不是回填）
     bash script/demo-box.sh live      # 持續跑
MSG
  exit 1
}

start_anvil () {
  echo ">> 停掉現有的 anvil（只停 :${ANVIL_PORT} 這一個）"
  # 用 pkill -x anvil 會把機器上其他專案的 anvil 一起殺掉——
  # 換了非預設埠之後，同時開好幾條鏈是很正常的事。
  if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti tcp:"$ANVIL_PORT" 2>/dev/null || true)
    [ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
  else
    pkill -f "anvil .*--port $ANVIL_PORT" 2>/dev/null || true
  fi
  sleep 1

  # anvil 預設把每個區塊的歷史狀態寫到這裡，每重開一次留一份，幾 GB 起跳。
  echo ">> 清掉 anvil 的歷史狀態快取"
  rm -rf "$HOME/.foundry/anvil/tmp" 2>/dev/null || true
  # 這裡不能寫成 [ -n "$STATE" ] && rm -f "$STATE"：STATE 是空的時候整行回傳 1，
  # 在 set -e 之下會讓整支腳本靜靜地結束——看起來就像什麼都沒發生。
  if [ -n "${STATE:-}" ]; then rm -f "$STATE"; fi

  # 回填的是事件的邏輯時間，鏈的時間就是現在（收單區塊確實是現在才收的）
  local TS; TS=$(date +%s)
  echo ">> 開 anvil（起始時間 $(date -u -d "@$TS" +%F 2>/dev/null || date -u -r "$TS" +%F)，--prune-history，:${ANVIL_PORT}）"
  # setsid 讓 anvil 脫離這個 shell 的 process group。只用 nohup 不夠：
  # 終端機關掉、或排程工具收掉整個 process group 的時候，anvil 會跟著被帶走。
  # shellcheck disable=SC2086
  local RUN="anvil --port $ANVIL_PORT --timestamp $TS --prune-history ${STATE:+--state $STATE} --silent"
  if command -v setsid >/dev/null 2>&1; then
    setsid $RUN > "$LOG/anvil.log" 2>&1 < /dev/null &
  else
    # macOS 沒有 setsid；nohup + disown 是能做到的最好程度
    nohup $RUN > "$LOG/anvil.log" 2>&1 < /dev/null &
    disown 2>/dev/null || true
  fi
  for _ in $(seq 30); do rpc_up && break; sleep 1; done
  rpc_up || { echo "!! anvil 沒起來，看 $LOG/anvil.log"; exit 1; }
}

do_deploy () {
  if ! is_local; then
    # 外部鏈的部署**一律交給 bootstrap.sh**：角色地址、治理持有人、CAFECA keyring、--slow 都在那裡。
    # 兩條路做同一件事，遲早有一條會落後——所以只留一條。
    echo ">> 外部鏈部署交給 bootstrap.sh（驗餘額 → 部署 → 寫回 web/.env.local → 角色檢查）"
    RPC_URL="$RPC_URL" bash script/bootstrap.sh deploy
    return
  fi
  # 本機展示：國家 Safe 2-of-3、營運 Safe 1-of-2 的持有人是 anvil 帳戶 5–9（DeployLedger 的預設）。
  # 另外把部署者（anvil 0）登記成主權與營運的簽章者之一：營運門檻 1，後台的費率設定就能直接簽；
  # 主權門檻仍是 2，ledger-seed 會用本機助記詞裡的持有人湊滿門檻。
  local A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  echo ">> 部署帳本合約（DeployLedger）"
  mkdir -p deployments   # 部署紀錄不進版本控制，新 clone 可能沒有這個資料夾；forge 不會自己建
  SOVEREIGN_SIGNER=${SOVEREIGN_SIGNER:-$A0} OPERATOR_SIGNER=${OPERATOR_SIGNER:-$A0} \
    forge script script/DeployLedger.s.sol --rpc-url "$RPC_URL" --broadcast > "$LOG/deploy.log" 2>&1 \
    || { echo "!! 部署失敗，看 $LOG/deploy.log"; exit 1; }
  grep -q "ONCHAIN EXECUTION COMPLETE" "$LOG/deploy.log" || { echo "!! 部署沒有完成，看 $LOG/deploy.log"; exit 1; }
  # 重新部署等於換了一本帳：web/data/ 裡的帳本與紀錄屬於舊合約。data-reset 是搬走不是刪掉。
  echo ">> 清掉上一次部署的 web/data/（搬到 data.bak-<時間>）"
  ( cd web && node scripts/data-reset.mjs ) | sed 's/^/   /'
}

# 提交一期，成功就寫出公開檔（web/data/public/epochs/<期別>.json；已存在的不重寫）。
# `seed`、`commit`、`commit-loop` 都走這裡，公開檔不會漏期。
do_commit () {
  # 先同步 CAFECA 實名（暫停、撤銷、過期的身分在這一期就失效）。失敗不擋提交：讀不到 CAFECA 不代表帳本不能承諾
  mkdir -p "$LOG"
  ( cd web && RPC_URL="$RPC_URL" node --experimental-strip-types --no-warnings scripts/kyc-sync.mjs >> "$LOG/kyc-sync.log" 2>&1 ) \
    || echo "   ⚠️ CAFECA 實名同步沒有完成，看 $LOG/kyc-sync.log"
  ( cd web && RPC_URL="$RPC_URL" node --experimental-strip-types --no-warnings scripts/ledger-commit.mjs ) || return 1
  mkdir -p "$LOG"
  ( cd web && RPC_URL="$RPC_URL" node --experimental-strip-types --no-warnings scripts/ledger-publish.mjs >> "$LOG/publish.log" 2>&1 ) \
    || echo "   ⚠️ 公開檔沒有寫出來，看 $LOG/publish.log"
}

# 每 COMMIT_EVERY 秒一期。某一期失敗（查核不過、RPC 斷線）不中止迴圈：下一輪會重算，
# 而沒有送出的那一期不會留下任何半套狀態——承諾是一筆交易，送成或沒送。
# 但**連續失敗要出聲**：沒有新承諾，出金請求就進不了證據，營運方不能確認出金。
commit_loop () {
  local fails=0
  echo ">> 每 ${COMMIT_EVERY} 秒提交一期承諾（log：$LOG/commit.log）。Ctrl-C 結束。"
  while true; do
    if do_commit >> "$LOG/commit.log" 2>&1; then
      fails=0; echo "   $(date -u +'%F %T') ✓ $(tail -1 "$LOG/commit.log")"
    else
      fails=$((fails + 1)); echo "   $(date -u +'%F %T') ✗ 第 ${fails} 次失敗：$(grep '✗' "$LOG/commit.log" | tail -1)"
      [ "$fails" -ge 3 ] && echo "   ⚠️ 連續 ${fails} 期沒有提交。沒有新承諾，營運方就不能確認新的出金（見 status）。"
    fi
    sleep "$COMMIT_EVERY"
  done
}

do_seed () {
  if ! is_local; then
    # 外部鏈不能回填（沒有 anvil_setBalance、時間不是我們的）：模擬人物從現在開始交易幾輪。
    # 人物的入金是營運 Safe 的鏈上入金確認（creditDeposit）：這台機器要有營運 Safe 持有人的金鑰
    # （repo 根目錄 .governance.env 的 OPERATOR_OWNER_<n>_PK），沒有的話模擬器只會用帳本裡已有的錢。
    local users=${SIM_USERS:-30} ticks=${EXT_TICKS:-10} interval=${EXT_INTERVAL:-30}
    echo ">> 外部鏈：模擬人物 ${users} 人從現在開始交易 ${ticks} 輪（每 ${interval} 秒一輪）"
    echo "   入金由營運 Safe 在鏈上確認（模擬的匯款，bankRef sim:…）；gas 由營運金鑰代付"
    ( cd web && RPC_URL="$RPC_URL" node --experimental-strip-types --no-warnings scripts/ledger-sim.mjs \
        --users "$users" --ticks "$ticks" --interval "$interval" )
    echo ">> 提交一期承諾"
    do_commit | tail -4
    return
  fi
  echo ">> 帳本回填：${LEDGER_USERS} 人、${LEDGER_DAYS} 天的事件（事件時間回溯，收單區塊是現在）"
  ( cd web && RPC_URL="$RPC_URL" node --experimental-strip-types --no-warnings scripts/ledger-seed.mjs \
      --days "$LEDGER_DAYS" --users "$LEDGER_USERS" ) | tail -5
  echo ">> 提交第一期承諾"
  do_commit | tail -4
}

case "${1:-}" in

rebuild)
  banner
  is_local || refuse_external
  start_anvil
  do_deploy
  do_seed
  echo ">> 完成。前端若在跑，重新整理就會看到新資料。"
  ;;

deploy)
  banner
  rpc_up || { echo "!! $RPC_URL 沒有回應"; exit 1; }
  do_deploy
  echo ">> 完成。接下來 seed 鋪資料，或直接開前端。"
  ;;

seed)
  banner
  rpc_up || { echo "!! $RPC_URL 沒有回應"; exit 1; }
  do_seed
  ;;

commit)
  banner
  rpc_up || { echo "!! $RPC_URL 沒有回應"; exit 1; }
  do_commit
  ;;

commit-loop)
  banner
  rpc_up || { echo "!! $RPC_URL 沒有回應"; exit 1; }
  commit_loop
  ;;

live)
  banner
  rpc_up || { echo "!! $RPC_URL 沒有回應"; exit 1; }
  echo ">> 持續模式：每小時提交承諾、寫出公開檔。"
  echo "   做市與模擬交易另外跑：cd web && npm run mm（在 /admin「做市」頁啟動報價、開模擬交易）"
  commit_loop
  ;;

status)
  ID=$(chain_id)
  if [ -n "$ID" ]; then
    BN=$(curl -fs --max-time ${RPC_TIMEOUT:-8} -X POST "${RPC_URL}" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      | sed 's/.*"result":"\([^"]*\)".*/\1/')
    TS=$(curl -fs --max-time ${RPC_TIMEOUT:-8} -X POST "${RPC_URL}" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"$BN\",false],\"id\":1}" \
      | sed 's/.*"timestamp":"\([^"]*\)".*/\1/')
    KIND=$(is_local && echo "本機開發鏈" || echo "外部鏈")
    echo "鏈         在跑：$RPC_URL"
    echo "           chainId $((ID))（${KIND}），區塊 $((BN))，鏈上時間 $(date -u -d "@$((TS))" +'%F %H:%M' 2>/dev/null || date -u -r "$((TS))" +'%F %H:%M')"
    [ -f "deployments/$((ID)).json" ] \
      && echo "部署檔     deployments/$((ID)).json" \
      || echo "部署檔     ⚠️ 沒有 deployments/$((ID)).json —— 還沒部署到這條鏈"
  else
    echo "鏈         沒有回應：$RPC_URL"
  fi
  # 問 /api/config，不要問會讀鏈的端點。後者在 web/data/ 過期時會回 503，
  # 於是「前端沒在跑」——但它明明在跑，只是資料要重置。
  # 健康檢查要問的是「這個行程活著嗎」，不是「資料是不是新的」。
  curl -fs --max-time 5 "${WEB}/api/config" >/dev/null 2>&1 \
    && echo "前端       在跑（${WEB}）" || echo "前端       沒在跑"
  # 最新一期、距今多久、帳本欠的新台幣與記帳 TWD
  DEP="deployments/$((${ID:-0})).json"
  if [ -n "$ID" ] && [ -f "$DEP" ] && command -v python3 >/dev/null 2>&1 \
     && [ "$(python3 -c "import json,sys;print(int(json.load(open(sys.argv[1])).get('ledgerVersion',0)) >= 3)" "$DEP")" = True ]; then
    L=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ledger'])" "$DEP")
    SOLV=$(cast call --rpc-url "$RPC_URL" "$L" "solvency()(uint256,uint256,uint64,uint64)" 2>/dev/null | tr '\n' ' ' | sed 's/\[[^]]*\]//g')
    if [ -n "$SOLV" ]; then
      set -- $SOLV
      AGE=$(( $(date +%s) - ${4:-0} ))
      [ "${3:-0}" = 0 ] && echo "帳本承諾   還沒有提交過任何一期" \
        || echo "帳本承諾   第 ${3} 期，$(( AGE / 60 )) 分鐘前（帳本欠 ${1}、記帳 TWD ${2}，最小單位）"
    fi
  fi
  # 承諾排程的健康判斷（同 /api/health）：有沒有事件等太久、連 24 小時的空承諾都沒來
  if [ -n "$ID" ] && [ -f "$DEP" ]; then
    H=$( cd web && RPC_URL="$RPC_URL" node --experimental-strip-types --no-warnings scripts/ledger-health.mjs 2>/dev/null )
    [ -n "$H" ] && echo "排程健康   $H"
  fi
  pgrep -f "ledger-sim.mjs" >/dev/null && echo "模擬器     在跑" || echo "模擬器     沒在跑"
  pgrep -f "mm/mm.mjs" >/dev/null && echo "做市       在跑" || echo "做市       沒在跑"
  pgrep -f "ledger-commit.mjs" >/dev/null && echo "承諾提交   正在送一期" || true
  ;;

*)
  sed -n '2,30p' "$0"; exit 1;;
esac
