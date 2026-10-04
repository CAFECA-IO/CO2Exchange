#!/bin/bash
# 每小時提交一期承諾（給 crontab／launchd 用）。和 demo-box 的 commit-loop 做同樣的三件事：
#   ① npm run kyc:sync       CAFECA 實名同步（失敗不擋提交）
#   ② npm run ledger:commit  先完整查核，不過就不送；過了才送這一期的承諾
#   ③ ledger-publish         寫出這一期的公開檔（web/data/public）
# 最後印一行 ledger:health，log 裡一眼看得出排程有沒有落後。
#
#   crontab：5 * * * * NODE=/path/to/node /bin/bash /path/to/CO2Exchange/script/cron-commit.sh >> /path/to/CO2Exchange/.demo-box/cron.log 2>&1
#
# 為什麼要另寫一支、不在 crontab 裡直接 `npm run ledger:commit`：
#   · cron 的 PATH 幾乎是空的，找不到 nvm 裝的 node／npm。這支用 NODE 指定的絕對路徑
#   · 上一輪還沒跑完（RPC 卡住）就不要再開一輪：兩輪同時算同一期，第二筆交易必然失敗，log 只會是一片紅
#   · 結束碼：0 提交成功（或沒有新事件、不需要提交）、1 查核或送出失敗
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOG=${LOG:-$ROOT/.demo-box}
mkdir -p "$LOG"
NODE=${NODE:-$(command -v node || true)}
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "$(date '+%F %T') ✗ 找不到 node。在 crontab 那一行加上 NODE=\$(which node) 的絕對路徑"; exit 1
fi
run () { "$NODE" --experimental-strip-types --no-warnings "$@"; }

# 同時只跑一輪。macOS 沒有 flock，用 mkdir 當鎖（建立資料夾是原子操作）；超過 2 小時的鎖視為上一輪異常結束留下的
LOCK="$LOG/commit.lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  # GNU 的 `stat -c %Y` 先試：GNU 的 `stat -f` 是「檔案系統資訊」，不會失敗，只會印出一堆文字
  mtime=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo 0)
  case "$mtime" in ''|*[!0-9]*) mtime=0;; esac
  age=$(( $(date +%s) - mtime ))
  if [ "$age" -gt 7200 ]; then
    rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
    echo "$(date '+%F %T') ! 清掉 ${age} 秒前留下的鎖"
  else
    echo "$(date '+%F %T') · 上一輪還在跑（${age} 秒），這一輪跳過"; exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

cd "$ROOT/web" || exit 1
echo "── $(date '+%F %T') ──"
run scripts/kyc-sync.mjs || echo "! CAFECA 實名同步沒有完成（不擋提交）"
run scripts/ledger-commit.mjs
rc=$?
if [ "$rc" -eq 0 ]; then
  run scripts/ledger-publish.mjs > "$LOG/publish.log" 2>&1 || echo "! 公開檔沒有寫出來，看 $LOG/publish.log"
else
  echo "✗ 這一期沒有提交（結束碼 ${rc}）。下一輪會重算；連續失敗代表出金請求進不了證據"
fi
run scripts/ledger-health.mjs || true
exit "$rc"
