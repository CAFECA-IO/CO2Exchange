#!/bin/sh
# 單機挖礦的 Boltchain 私有鏈：一個節點、不連任何 peer、礦工獎勵全部給 BENEFICIARY（部署用金鑰的地址）。
#
#   BENEFICIARY      收礦工獎勵的地址（必填；bootstrap.sh 會填 DEPLOYER_PK 的地址）
#   MINING_THREADS   挖礦執行緒（預設 1）
#   RANDOMX_FAST     1 = RandomX fast 模式（每把 key 2 GiB 記憶體，雜湊快很多；預設 light）
#   GENESIS          genesis 檔（預設映像檔內建的 /etc/boltchain/genesis.json）
#   EXTRA_ARGS       其他要傳給 `boltchain mine` 的參數
#
# 換 BENEFICIARY 不會影響鏈上資料：已經挖到的獎勵留在舊地址，之後的區塊給新地址。
set -eu

case "${BENEFICIARY:-}" in
  0x[0-9a-fA-F][0-9a-fA-F]*) ;;
  *) echo "!! 沒有設定 BENEFICIARY（收礦工獎勵的地址）。用 bash script/bootstrap.sh chain 啟動，"
     echo "   或在專案根目錄的 .env 寫 BOLTCHAIN_BENEFICIARY=0x...（40 碼地址）"; exit 2;;
esac
if [ "${#BENEFICIARY}" -ne 42 ]; then echo "!! BENEFICIARY 不是 0x 加 40 碼的地址：${BENEFICIARY}"; exit 2; fi

GENESIS=${GENESIS:-/etc/boltchain/genesis.json}
set -- mine \
  --genesis "$GENESIS" \
  --datadir /data \
  --rpc 0.0.0.0:8545 \
  --metrics 0.0.0.0:9017 \
  --p2p-host 127.0.0.1 \
  --beneficiary "$BENEFICIARY" \
  --mining-threads "${MINING_THREADS:-1}" \
  --extra-data "co2x"
[ "${RANDOMX_FAST:-0}" = "1" ] && set -- "$@" --randomx-fast
# shellcheck disable=SC2086
[ -n "${EXTRA_ARGS:-}" ] && set -- "$@" $EXTRA_ARGS

echo ">> boltchain $(boltchain --version 2>/dev/null | awk '{print $2}')：私有挖礦鏈，獎勵給 ${BENEFICIARY}"
exec boltchain "$@"
