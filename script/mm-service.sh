#!/usr/bin/env bash
# 把後台做市程式（web/scripts/mm/mm.mjs）裝成常駐服務：當掉會重啟、開機會自己起來。
#
#   bash script/mm-service.sh install     # macOS：launchd；Linux：印出 systemd unit 與安裝指令
#   bash script/mm-service.sh uninstall
#   bash script/mm-service.sh status
#   bash script/mm-service.sh logs
#
# 服務本身不帶任何金鑰或設定——mm.mjs 自己讀 web/.env.local（鏈與服務金鑰）與
# repo 根目錄的 .mm.env（做市帳戶）。所以換鏈、換參數都不必重裝服務，重啟就好。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LABEL=tw.tidebit.co2x.mm
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "!! 找不到 node"; exit 1; }

case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  LOGF="$HOME/Library/Logs/co2x-mm.log"
  case "${1:-}" in
  install)
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOGF")"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>scripts/mm/mm.mjs</string></array>
  <key>WorkingDirectory</key><string>${ROOT}/web</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${LOGF}</string>
  <key>StandardErrorPath</key><string>${LOGF}</string>
</dict>
</plist>
PL
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo ">> 已安裝 ${PLIST}"
    echo "   紀錄：${LOGF}"
    echo "   控制：/admin →「後台做市」。服務只負責讓程式活著，報不報價看那一頁的設定。"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"; echo ">> 已移除（做市帳戶上的報價不會自動撤掉——先在 /admin 按「停止報價」）";;
  status) launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | grep -E "state|pid|last exit" || echo "沒有安裝";;
  logs)   tail -n 50 -f "$LOGF";;
  *) sed -n '2,11p' "$0"; exit 1;;
  esac
  ;;
Linux)
  UNIT=/etc/systemd/system/co2x-mm.service
  case "${1:-}" in
  install)
    TMP=$(mktemp)
    cat > "$TMP" <<UN
[Unit]
Description=TideBit-DeFi 後台做市
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=${ROOT}/web
ExecStart=${NODE} scripts/mm/mm.mjs
Restart=always
RestartSec=30
# SIGTERM 之後 mm.mjs 會跑完這一輪再結束；外部鏈一輪可能要一兩分鐘
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
UN
    if [ -w "$(dirname "$UNIT")" ]; then
      cp "$TMP" "$UNIT"; systemctl daemon-reload; systemctl enable --now co2x-mm
      echo ">> 已安裝並啟動 co2x-mm"
    else
      echo ">> 需要 root 權限。請執行："
      echo "   sudo cp $TMP $UNIT && sudo systemctl daemon-reload && sudo systemctl enable --now co2x-mm"
    fi
    ;;
  uninstall) echo "sudo systemctl disable --now co2x-mm && sudo rm $UNIT && sudo systemctl daemon-reload";;
  status) systemctl status co2x-mm --no-pager || true;;
  logs) journalctl -u co2x-mm -n 50 -f;;
  *) sed -n '2,11p' "$0"; exit 1;;
  esac
  ;;
*) echo "!! 不支援的系統：$(uname -s)"; exit 1;;
esac
