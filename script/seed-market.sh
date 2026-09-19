#!/usr/bin/env bash
# 逐筆買進 SeedMarket 掛出的單，並在每筆之間推進區塊時間，
# 讓每一筆成交落在不同的時間戳上 —— 行情圖的 K 棒才有時間軸可分。
#
# 前提：anvil + 已部署 + 已執行 forge script script/SeedMarket.s.sol --sig "seed()"
#
#   ./script/seed-market.sh [rpc] [first_order_id] [count]
#
# 只適用於 Anvil（用到 evm_increaseTime / evm_mine）。

set -uo pipefail

RPC="${1:-${RPC_URL:-http://127.0.0.1:8545}}"
FIRST="${2:-}"
COUNT="${3:-72}"
MAX_LOT_KG=2000
STEP_SECONDS=${STEP_SECONDS:-1800} # 每筆間隔 30 分鐘

PK_ALICE=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
PK_B=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

command -v cast >/dev/null 2>&1 || { echo "找不到 cast，請先安裝 Foundry（bash setup.sh）"; exit 1; }

CHAIN_ID=$(cast chain-id --rpc-url "${RPC}" 2>/dev/null) || { echo "連不上 ${RPC}"; exit 1; }
DEPLOY_FILE="deployments/${CHAIN_ID}.json"
[ -f "${DEPLOY_FILE}" ] || { echo "找不到 ${DEPLOY_FILE}，請先部署"; exit 1; }
LISTING=$(python3 -c "import json;print(json.load(open('${DEPLOY_FILE}'))['listing'])")
TWD=$(python3 -c "import json;print(json.load(open('${DEPLOY_FILE}'))['settlementToken'])")

# 沒指定起始 orderId 就往回找：nextOrderId - COUNT
if [ -z "${FIRST}" ]; then
  NEXT=$(cast call "${LISTING}" "nextOrderId()(uint256)" --rpc-url "${RPC}" | awk '{print $1}')
  FIRST=$((NEXT - COUNT))
fi

echo "Listing  ${LISTING}"
echo "成交 ${COUNT} 筆，orderId ${FIRST} 起，每筆 0.4–2 噸不等，間隔 ${STEP_SECONDS}s"
echo

# 一次授權足夠的額度，後面每筆就不用再 approve
for PK in "${PK_ALICE}" "${PK_B}"; do
  cast send "${TWD}" "approve(address,uint256)" "${LISTING}" \
    0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
    --private-key "${PK}" --rpc-url "${RPC}" >/dev/null 2>&1
done

ok=0; fail=0
for ((i = 0; i < COUNT; i++)); do
  ORDER=$((FIRST + i))
  # 買方交替，成交明細看起來才像有兩邊在動
  if (( i % 3 == 0 )); then PK="${PK_B}"; else PK="${PK_ALICE}"; fi

  # 成交量刻意做出高低差：每根 K 棒的量都一樣高，圖看起來就假了
  LOT=$(( 400 + ((i * 617 + 191) % 1601) ))
  (( LOT > MAX_LOT_KG )) && LOT=${MAX_LOT_KG}

  if cast send "${LISTING}" "buy(uint256,uint256)" "${ORDER}" "${LOT}" \
      --private-key "${PK}" --rpc-url "${RPC}" >/dev/null 2>&1; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
  fi

  # 推進鏈上時間，下一筆才會落在新的 K 棒
  cast rpc evm_increaseTime "${STEP_SECONDS}" --rpc-url "${RPC}" >/dev/null 2>&1
  cast rpc evm_mine --rpc-url "${RPC}" >/dev/null 2>&1

  printf '\r  已成交 %d/%d（失敗 %d）' "${ok}" "${COUNT}" "${fail}"
done
echo
echo "完成。重新整理首頁就會看到走勢。"
