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
#   bash script/demo-box.sh rebuild   # 僅本機鏈：新鏈、部署、回填 DAYS 天
#   bash script/demo-box.sh deploy    # 部署到設定的那條鏈（外部鏈＝bootstrap.sh deploy）
#   bash script/demo-box.sh seed      # 鋪市場資料（本機＝回填；外部＝縮時，從現在開始）
#   bash script/demo-box.sh live      # 持續跑（前景，Ctrl-C 結束）
#   bash script/demo-box.sh status    # 現在是什麼狀態
#
# 環境變數：
#   RPC_URL=http://127.0.0.1:28545   目標鏈。與 web/.env.local 同名同義
#   DAYS=365        回填幾天（只有本機鏈用得到）
#   TICK=8h         每輪代表多久
#   SIM_USERS=30 EXT_DAYS=30 EXT_TICK=1d   外部鏈 seed 的規模（每筆交易都要等出塊）
#   金鑰：外部鏈一律讀 web/.env.local（bootstrap.sh keys 產生）。shell 裡的同名變數會蓋過它
#   WEB=http://localhost:10010
#   STATE=          給 anvil --state 的檔案（只有本機鏈用得到）
set -euo pipefail

# 變數展開後面接中文字時一定要用 ${VAR} 大括號。macOS 內建的 bash 3.2 會把後面的
# 多位元組字元當成識別字的一部分，於是 "$TICK）" 變成變數 "TICK<byte>"，
# 在 set -u 之下直接 unbound variable。preflight.sh 早就踩過同一個坑。

cd "$(dirname "$0")/.."
ROOT=$(pwd)
DAYS=${DAYS:-365}
TICK=${TICK:-8h}
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

# 幾天前的日期。GNU 與 BSD(macOS) 的 date 參數不同，兩種都試。
days_ago () {
  date -u -d "@$(( $(date +%s) - $1 * 86400 ))" +%F 2>/dev/null \
    || date -u -r "$(( $(date +%s) - $1 * 86400 ))" +%F
}

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
     · 時間不是我們的，沒有 anvil_setTime，回填一年份做不到。
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

  # 回填只能把鏈的時間往前推，不能倒退，所以鏈要從 DAYS 天前開始。
  local TS; TS=$(( $(date +%s) - DAYS * 86400 ))
  echo ">> 開 anvil（起始時間 $(days_ago "$DAYS")，--prune-history，:${ANVIL_PORT}）"
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
  if is_local; then
    echo ">> 部署（DemoFlowV4，含一張最小的示範桌子）"
    forge script script/DemoFlowV4.s.sol --rpc-url "$RPC_URL" --broadcast --sig "demo()" \
      > "$LOG/deploy.log" 2>&1 \
      || { echo "!! 部署失敗，看 $LOG/deploy.log"; exit 1; }
  else
    # 外部鏈不跑 demo()：那支會用 anvil 的預設帳戶當企業與做市商，
    # 在別人的鏈上那些地址不是我們的，也沒有餘額。
    #
    # 外部鏈的部署**一律交給 bootstrap.sh**。這裡以前自己呼叫 forge，少了三件事：
    # 角色地址（IDENTITY_VERIFIER / CARBON_VERIFIER / DOCUMENT_SIGNER 會變成 deployer，
    # 網站的簽章全部被合約拒絕）、治理 owner、CREATE2 deployer 的檢查。
    # 兩條路做同一件事，遲早有一條會落後——所以只留一條。
    echo ">> 外部鏈部署交給 bootstrap.sh（驗餘額 → 部署 → 寫回 web/.env.local → 角色檢查）"
    RPC_URL="$RPC_URL" bash script/bootstrap.sh deploy
    return
  fi
  grep -q "ONCHAIN EXECUTION COMPLETE" "$LOG/deploy.log" \
    || { echo "!! 部署沒有完成，看 $LOG/deploy.log"; exit 1; }

  # 重新部署等於換了一條鏈：web/data/ 裡的 KYC 與憑證紀錄是用**舊**合約算出來的
  # 帳戶地址當鍵的，在新部署上對不到任何人。不清掉的話，前端每個讀鏈的端點都會
  # 回 503「紀錄屬於另一次部署」。data-reset 是搬走不是刪掉。
  echo ">> 清掉上一次部署的 web/data/（搬到 data.bak-<時間>）"
  ( cd web && node scripts/data-reset.mjs ) | sed 's/^/   /'
}

do_seed () {
  if is_local; then
    echo ">> 回填 $(days_ago $(( DAYS - 1 ))) → 現在（每輪 ${TICK}）"
    ( cd web && RPC_URL="$RPC_URL" node scripts/simulate.mjs \
        --from "$(days_ago $(( DAYS - 1 )))" --tick "$TICK" --quiet ) | tail -3
  else
    # 外部鏈沒有 anvil_setTime，所以劇本的一年會壓縮成「現在這一段時間」。
    # 模擬器自己會說這件事（見 simulate.mjs 的縮時模式提示）。
    #
    # 規模刻意縮小。外部鏈每筆交易都要等出塊（Boltchain 6 秒），而模擬器一筆等一筆：
    # 本機預設的一百人 × 一年 × 每 8 小時一輪，在這裡要跑好幾天。
    # 預設 30 人 × 30 天 × 每天一輪，大約一小時；要更多就自己調 SIM_USERS / EXT_DAYS / EXT_TICK。
    #
    # **不要**不帶 --from：那是持續模式，永遠不會結束——以前這裡就是那樣寫的，
    # 再接一個 `| tail -3`，結果是一個永遠不回來、也什麼都不印的指令。
    local users=${SIM_USERS:-30} days=${EXT_DAYS:-30} tick=${EXT_TICK:-1d}
    echo ">> 縮時鋪資料：${users} 人、劇本 ${days} 天、每輪 ${tick}（外部鏈不能調整區塊時間，劇本壓在現在）"
    # 人物帳戶的 gas 由平台出：模擬器的 ensureGas() 會在餘額不足時從 DEPLOYER_PK
    # （沒有就 RELAYER_PK）真的轉一筆過去。所以要備的是**營運金鑰**的餘額。
    # 金鑰從 web/.env.local 讀（shell 有設同名變數會蓋過它）。
    echo "   人物帳戶的 gas 由平台金鑰代付（每個 ${SIM_GAS_TOPUP:-0.001} BOLT）。"
    echo "   每筆交易等一次出塊，會跑一陣子；中斷後重跑會接手鏈上已有的帳戶。"
    ( cd web && RPC_URL="$RPC_URL" node scripts/simulate.mjs \
        --users "$users" --from "$(days_ago $(( days - 1 )))" --tick "$tick" )
  fi
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

live)
  banner
  rpc_up || { echo "!! $RPC_URL 沒有回應"; exit 1; }
  echo ">> 持續模式。提醒：年度需求額度大約一小時會用完，之後只剩做市商還在買。"
  echo "   本機展示機請改用排程每天 rebuild，見 README「五、日常怎麼營運 › 持續運作」。"
  cd web && RPC_URL="$RPC_URL" exec node scripts/simulate.mjs "${@:2}"
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
  pgrep -f "simulate.mjs" >/dev/null && echo "模擬器     在跑" || echo "模擬器     沒在跑"
  ;;

*)
  sed -n '2,26p' "$0"; exit 1;;
esac
