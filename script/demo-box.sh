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
#   RPC=http://127.0.0.1:28545   （anvil 的埠由這個位址決定，不必另外設）
#   WEB=http://localhost:10010
#   STATE=          給 anvil --state 的檔案；設了就能跨重開保留鏈（rebuild 會先刪掉它）
set -euo pipefail

# 變數展開後面接中文字時一定要用 ${VAR} 大括號。macOS 內建的 bash 3.2 會把後面的
# 多位元組字元當成識別字的一部分，於是 "$TICK）" 變成變數 "TICK<byte>"，
# 在 set -u 之下直接 unbound variable。preflight.sh 早就踩過同一個坑。

cd "$(dirname "$0")/.."
ROOT=$(pwd)
DAYS=${DAYS:-365}
TICK=${TICK:-8h}
RPC=${RPC:-http://127.0.0.1:28545}
WEB=${WEB:-http://localhost:10010}
# anvil 要開在哪個埠，從 RPC 位址推出來——兩個地方各寫一次遲早會不一致
ANVIL_PORT=$(printf '%s' "$RPC" | sed 's|.*:||; s|/.*||')
case "$ANVIL_PORT" in ''|*[!0-9]*) ANVIL_PORT=28545;; esac
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
  # 只停**這個埠**上的那一個。用 pkill -x anvil 會把機器上其他專案的 anvil
  # 一起殺掉——換了非預設埠之後，同時開好幾條鏈是很正常的事。
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
  TS=$(( $(date +%s) - DAYS * 86400 ))
  echo ">> 開 anvil（起始時間 $(days_ago "$DAYS")，--prune-history，:${ANVIL_PORT}）"
  # setsid 讓 anvil 脫離這個 shell 的 process group。只用 nohup 不夠：
  # 終端機關掉、或排程工具收掉整個 process group 的時候，anvil 會跟著被帶走。
  # 展示機要活過「跑完腳本就登出」，這一行是必要的。
  # shellcheck disable=SC2086
  RUN="anvil --port $ANVIL_PORT --timestamp $TS --prune-history ${STATE:+--state $STATE} --silent"
  if command -v setsid >/dev/null 2>&1; then
    setsid $RUN > "$LOG/anvil.log" 2>&1 < /dev/null &
  else
    # macOS 沒有 setsid；nohup + disown 是能做到的最好程度
    nohup $RUN > "$LOG/anvil.log" 2>&1 < /dev/null &
    disown 2>/dev/null || true
  fi
  for _ in $(seq 30); do rpc_up && break; sleep 1; done
  rpc_up || { echo "!! anvil 沒起來，看 $LOG/anvil.log"; exit 1; }

  echo ">> 部署"
  forge script script/DemoFlowV4.s.sol --rpc-url "$RPC" --broadcast --sig "demo()" \
    > "$LOG/deploy.log" 2>&1
  grep -q "ONCHAIN EXECUTION COMPLETE" "$LOG/deploy.log" \
    || { echo "!! 部署失敗，看 $LOG/deploy.log"; exit 1; }

  # 重新部署等於換了一條鏈：web/data/ 裡的 KYC 與憑證紀錄是用**舊**合約算出來的
  # 帳戶地址當鍵的，在新鏈上對不到任何人。不清掉的話，前端每個讀鏈的端點都會
  # 回 503「紀錄屬於另一次部署」——rebuild 是唯一保證會造成這個錯位的指令，
  # 所以清理就放在這裡，不要留給人自己想起來。data-reset 是搬走不是刪掉。
  echo ">> 清掉上一次部署的 web/data/（搬到 data.bak-<時間>）"
  ( cd web && node scripts/data-reset.mjs ) | sed 's/^/   /'

  echo ">> 回填 $(days_ago $(( DAYS - 1 ))) → 現在（每輪 ${TICK}）"
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
  # 問 /api/config，不要問會讀鏈的端點。後者在 web/data/ 過期時會回 503，
  # 於是「前端沒在跑」——但它明明在跑，只是資料要重置。
  # 健康檢查要問的是「這個行程活著嗎」，不是「資料是不是新的」。
  curl -fs "$WEB/api/config" >/dev/null 2>&1 \
    && echo "前端       在跑（${WEB}）" || echo "前端       沒在跑"
  pgrep -f "simulate.mjs" >/dev/null && echo "模擬器     在跑" || echo "模擬器     沒在跑"
  ;;

*)
  sed -n '2,20p' "$0"; exit 1;;
esac
