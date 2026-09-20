#!/usr/bin/env bash
# 展示機：把整條鏈砍掉重來，鋪出一年份的市場，然後（可選）持續跑。
#
# 為什麼需要這支：持續模式會把一年份的需求在**大約一個小時內**用完
# （實測每輪約 1,590 噸，非做市商的年度採購額度合計 95,408 噸）。
# 用完之後就只剩做市商還在買，市場看起來像停了——而且要等到模擬世界的
# 隔年一月才會恢復。所以展示機的作法不是「跑一次然後放著」，
# 而是**每天重建一次**：永遠有完整一年的歷史，而且需求永遠是新的。
#
#   bash script/demo-box.sh rebuild     # 砍掉重來：新鏈、部署、回填 365 天
#   bash script/demo-box.sh live        # 在現有鏈上持續跑（前景，Ctrl-C 結束）
#   bash script/demo-box.sh status      # 現在是什麼狀態
#
# 環境變數：
#   DAYS=365        回填幾天
#   TICK=8h         回填時每輪代表多久
#   RPC=http://127.0.0.1:8545
#   STATE=          給 anvil --state 的檔案；設了就能跨重開保留鏈（rebuild 會先刪掉它）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
DAYS=${DAYS:-365}
TICK=${TICK:-8h}
RPC=${RPC:-http://127.0.0.1:8545}
LOG=${LOG:-$ROOT/.demo-box}
mkdir -p "$LOG"

export PATH="$HOME/.foundry/bin:$PATH"

# 幾天前的日期。GNU 與 BSD(macOS) 的 date 參數不同，兩種都試。
days_ago () {
  date -u -d "@$(( $(date +%s) - $1 * 86400 ))" +%F 2>/dev/null \
    || date -u -r "$(( $(date +%s) - $1 * 86400 ))" +%F
}

rpc_up () { curl -fs -X POST "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' >/dev/null 2>&1; }

case "${1:-}" in

rebuild)
  echo ">> 停掉現有的 anvil"
  # -x 比對執行檔名。用 -f "^anvil" 比對整條命令列會漏掉——
  # 實際的命令列是絕對路徑（/…/bin/anvil），開頭不是 anvil。
  pkill -x anvil 2>/dev/null || true
  sleep 1

  # anvil 預設把每個區塊的歷史狀態寫到這裡，每重開一次留一份，幾 GB 起跳。
  echo ">> 清掉 anvil 的歷史狀態快取"
  rm -rf "$HOME/.foundry/anvil/tmp" 2>/dev/null || true
  # 這裡不能寫成 [ -n "$STATE" ] && rm -f "$STATE"：STATE 是空的時候整行回傳 1，
  # 在 set -e 之下會讓整支腳本靜靜地結束——看起來就像什麼都沒發生。
  if [ -n "${STATE:-}" ]; then rm -f "$STATE"; fi

  # 回填只能把鏈的時間往前推，不能倒退，所以鏈要從 DAYS 天前開始。
  TS=$(( $(date +%s) - DAYS * 86400 ))
  echo ">> 開 anvil（起始時間 $(days_ago "$DAYS")，--prune-history）"
  # shellcheck disable=SC2086
  nohup anvil --timestamp "$TS" --prune-history ${STATE:+--state "$STATE"} --silent \
    > "$LOG/anvil.log" 2>&1 &
  for _ in $(seq 30); do rpc_up && break; sleep 1; done
  rpc_up || { echo "!! anvil 沒起來，看 $LOG/anvil.log"; exit 1; }

  echo ">> 部署"
  forge script script/DemoFlowV4.s.sol --rpc-url "$RPC" --broadcast --sig "demo()" \
    > "$LOG/deploy.log" 2>&1
  grep -q "ONCHAIN EXECUTION COMPLETE" "$LOG/deploy.log" \
    || { echo "!! 部署失敗，看 $LOG/deploy.log"; exit 1; }

  echo ">> 回填 $(days_ago $(( DAYS - 1 ))) → 現在（每輪 $TICK）"
  ( cd web && node scripts/simulate.mjs --from "$(days_ago $(( DAYS - 1 )))" --tick "$TICK" --quiet ) \
    | tail -3

  echo ">> 完成。前端若在跑，重新整理就會看到新資料。"
  ;;

live)
  rpc_up || { echo "!! $RPC 沒有回應，先跑 rebuild"; exit 1; }
  echo ">> 持續模式。提醒：年度需求額度大約一小時會用完，之後只剩做市商還在買。"
  echo "   展示機請改用排程每天 rebuild，見 README「營運手冊 › 持續運作」。"
  cd web && exec node scripts/simulate.mjs "${@:2}"
  ;;

status)
  if rpc_up; then
    BN=$(curl -fs -X POST "$RPC" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      | sed 's/.*"result":"\([^"]*\)".*/\1/')
    TS=$(curl -fs -X POST "$RPC" -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBlockByNumber\",\"params\":[\"$BN\",false],\"id\":1}" \
      | sed 's/.*"timestamp":"\([^"]*\)".*/\1/')
    echo "anvil      在跑，區塊 $((BN)) ，鏈上時間 $(date -u -d "@$((TS))" +'%F %H:%M' 2>/dev/null || date -u -r "$((TS))" +'%F %H:%M')"
  else
    echo "anvil      沒在跑"
  fi
  curl -fs localhost:3000/api/market/by-country >/dev/null 2>&1 \
    && echo "前端       在跑（localhost:3000）" || echo "前端       沒在跑"
  pgrep -f "simulate.mjs" >/dev/null && echo "模擬器     在跑" || echo "模擬器     沒在跑"
  ;;

*)
  sed -n '2,20p' "$0"; exit 1;;
esac
