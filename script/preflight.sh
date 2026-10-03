#!/usr/bin/env bash
# 部署前檢查：確認目標鏈跑不跑得動帳本合約（script/DeployLedger.s.sol）。
#
#   ./script/preflight.sh                        # 預設 http://127.0.0.1:28545
#   ./script/preflight.sh http://211.22.118.149:8545
#   RPC_URL=... ./script/preflight.sh
#
# 檢查項目：
#   1. RPC 連線、chainId、節點版本、目前高度
#   2. EIP-5656（MCOPY）—— solc 0.8.26 + evm_version=cancun 產出的碼會用到
#   3. EIP-1559 —— 決定 forge script 要不要加 --legacy
#   4. eth_getLogs 單次可讀的區塊範圍 —— 帳本的鏡像與重播靠它
#   5. 新台幣入出金 —— 記帳 TWD 由部署建立；營運 Safe 持有人的金鑰在不在這台機器上（只看有沒有，不印）
#   6. 部署者餘額與公開鏈的金鑰檢查
#
# 只印位址，不印任何私鑰。

set -uo pipefail

# 注意：變數展開後面接中文字時一定要用 ${VAR} 大括號。
# macOS 內建的 bash 3.2 會把後面的多位元組字元當成識別字的一部分，
# 於是 "$CHAIN_ID）" 會被解析成變數 "CHAIN_ID）"，在 set -u 下直接 unbound variable。

# 目標鏈：參數／shell 的 RPC_URL → web/.env.local 的 RPC_URL → 本機 anvil
if [ -z "${RPC_URL:-}" ] && [ -f "$(dirname "$0")/../web/.env.local" ]; then
  RPC_URL=$(sed -n 's/^RPC_URL=\(.*\)$/\1/p' "$(dirname "$0")/../web/.env.local" | tail -1 | tr -d '"'"'"'\r')
fi
RPC="${1:-${RPC_URL:-http://127.0.0.1:28545}}"
ANVIL_PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# 金鑰：shell → web/.env.local（bootstrap.sh keys 寫在那裡）→ anvil 預設。
# 以前只看 shell，於是剛跑完 `bootstrap.sh keys` 再跑這支，還是說「部署者是 Anvil 的預設帳戶、餘額 0」——
# 金鑰明明產生好了，這支根本沒去讀。bootstrap.sh deploy 讀的是 web/.env.local，這裡要看同一份。
ENV_LOCAL="$(dirname "$0")/../web/.env.local"
from_env_local () { [ -f "$ENV_LOCAL" ] && sed -n "s/^$1=\(0x[0-9a-fA-F]\{64\}\)$/\1/p" "$ENV_LOCAL" | tail -1 || true; }
DEPLOYER_SRC="shell"
if [ -z "${DEPLOYER_PK:-}" ]; then DEPLOYER_PK=$(from_env_local DEPLOYER_PK); DEPLOYER_SRC="web/.env.local"; fi
if [ -z "${DEPLOYER_PK:-}" ]; then DEPLOYER_PK=$ANVIL_PK0; DEPLOYER_SRC="anvil 預設（沒有找到 DEPLOYER_PK）"; fi
RELAYER_PK="${RELAYER_PK:-$(from_env_local RELAYER_PK)}"
FILE_CHAIN=$( [ -f "$ENV_LOCAL" ] && sed -n 's/^CHAIN_ID=\([0-9]*\).*$/\1/p' "$ENV_LOCAL" | tail -1 || true )

# MCOPY（0x5E）探針：把 32 bytes 複製一份再回傳；鏈不支援則整段 revert。
MCOPY_PROBE=0x60206000600060005E60005260206000F3

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
FAIL=0

command -v cast >/dev/null 2>&1 || { echo "找不到 cast，請先安裝 Foundry（bash setup.sh）"; exit 1; }

echo "目標 RPC：$RPC"
echo

# --- 1. 連線與 chainId ---------------------------------------------------
echo "[1/6] 連線"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null)
if [ -z "$CHAIN_ID" ]; then
  bad "連不上 $RPC"
  echo
  echo "  鏈沒開，或 port 不對。本機 demo 請先在另一個終端執行：anvil"
  exit 1
fi
ok "連線正常，chainId = $CHAIN_ID"
CLIENT=$(cast rpc web3_clientVersion --rpc-url "$RPC" 2>/dev/null | tr -d '"')
[ -n "$CLIENT" ] && ok "節點版本：$CLIENT"
BLOCK=$(cast block-number --rpc-url "$RPC" 2>/dev/null)
ok "目前高度：${BLOCK:-unknown}"
echo "  部署檔會寫到 deployments/${CHAIN_ID}.json（前端需設 CHAIN_ID=${CHAIN_ID}）"
echo

# --- 2. EIP-5656 MCOPY ---------------------------------------------------
echo "[2/6] EIP-5656（MCOPY）— solc evm_version=cancun 產出的碼會用到"
RES=$(cast call --rpc-url "$RPC" --create "$MCOPY_PROBE" 2>&1)
case "$RES" in
  0x*) ok "支援" ;;
  *)   bad "不支援 —— 這條鏈比 Cancun 舊，帳本合約與 Safe v1.4.1 都跑不了"; FAIL=1 ;;
esac
echo

# --- 3. EIP-1559 ---------------------------------------------------------
echo "[3/6] EIP-1559（動態手續費）"
BASEFEE=$(cast block latest --json --rpc-url "$RPC" 2>/dev/null | grep -o '"baseFeePerGas":"[^"]*"' | head -1 | cut -d'"' -f4)
LEGACY_FLAG=""
if [ -n "$BASEFEE" ] && [ "$BASEFEE" != "null" ]; then
  ok "支援（baseFeePerGas = ${BASEFEE}）"
else
  LEGACY_FLAG=" --legacy"
  warn "區塊沒有 baseFeePerGas —— forge script 要加 --legacy（bootstrap.sh 會自動判斷）"
fi
echo

# --- 4. eth_getLogs 範圍 -------------------------------------------------
# 帳本的鏡像（入金、出金、金鑰）與重播驗證都靠 eth_getLogs。Boltchain 單次上限 10,000 個區塊，
# web/lib/ledger/chain.ts 的 getLogsPaged 會自動分段；這裡只是讓人知道這條鏈的上限。
echo "[4/6] eth_getLogs"
if [ -n "${BLOCK:-}" ] && [ "$BLOCK" -gt 0 ] 2>/dev/null; then
  for span in 50000 10000 2000; do
    FROM=$(( BLOCK > span ? BLOCK - span : 0 ))
    if cast logs --from-block "$FROM" --to-block "$BLOCK" --address 0x0000000000000000000000000000000000000001 --rpc-url "$RPC" >/dev/null 2>&1; then
      ok "單次讀 ${span} 個區塊可以（鏡像會自動分段）"; break
    fi
    [ "$span" = 2000 ] && { bad "連 2,000 個區塊都讀不了 —— 鏡像會很慢，請確認節點有開 eth_getLogs"; FAIL=1; }
  done
else
  warn "高度 0，跳過"
fi
echo

# --- 5. 新台幣入出金 -----------------------------------------------------
echo "[5/6] 新台幣入出金"
ok "記帳 TWD 由帳本合約部署時建立（LedgerTWD：只在帳本合約裡、不能轉出），不需要外部代幣"
[ -n "${SETTLEMENT_TOKEN:-}" ] && warn "SETTLEMENT_TOKEN 已經不用了，忽略"
GOV_FILE=${GOV_FILE:-$(dirname "$0")/../.governance.env}
if [ -f "$GOV_FILE" ] && grep -q '^OPERATOR_OWNER_[0-9]_PK=0x' "$GOV_FILE"; then
  ok "這台機器有營運 Safe 持有人的金鑰（$(grep -c '^OPERATOR_OWNER_[0-9]_PK=0x' "$GOV_FILE") 把）：可以在這裡用 npm run fiat 確認入出金"
else
  warn "這台機器沒有營運 Safe 持有人的金鑰：入出金確認要交給持有人（npm run fiat -- … --print 產生要簽的內容）"
fi
echo

# --- 6. 部署者 -----------------------------------------------------------
echo "[6/6] 部署者"
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK" 2>/dev/null)
if [ -z "$DEPLOYER" ]; then
  bad "DEPLOYER_PK 格式不正確"
  exit 1
fi
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)
BAL_ETH=$(cast from-wei "${BAL:-0}" 2>/dev/null || echo 0)
echo "  地址：$DEPLOYER（金鑰來自 ${DEPLOYER_SRC}）"
if [ "${BAL:-0}" = "0" ]; then
  bad "餘額 0 —— 部署一定失敗"; FAIL=1
  echo "    撥款給上面這個地址。要撥多少：bash script/bootstrap.sh fund"
else
  ok "餘額 ${BAL_ETH}（帳本 + 兩個 Safe + Timelock，約需數百萬 gas）"
fi
if [ -n "${RELAYER_PK:-}" ]; then
  RELAYER=$(cast wallet address --private-key "$RELAYER_PK" 2>/dev/null)
  RBAL=$(cast balance "$RELAYER" --rpc-url "$RPC" 2>/dev/null || echo 0)
  if [ "${RBAL:-0}" = "0" ]; then
    warn "RELAYER $RELAYER 餘額 0 —— 部署可以，但每小時的承諾送不出去（bash script/bootstrap.sh fund 看要撥多少）"
  else
    ok "RELAYER $RELAYER 餘額 $(cast from-wei "$RBAL" 2>/dev/null)（每小時送一次承諾）"
  fi
else
  echo "  RELAYER_PK 要有餘額（每小時送一次承諾）；三把簽章金鑰只簽鏈下事件，不需要餘額。"
fi
if [ -n "${FILE_CHAIN:-}" ] && [ "$FILE_CHAIN" != "$CHAIN_ID" ]; then
  warn "web/.env.local 的 CHAIN_ID 是 ${FILE_CHAIN}，目標鏈是 ${CHAIN_ID}：網站與 npm 工具會拒用檔案裡的金鑰。"
  echo "    bash script/bootstrap.sh deploy 部署完會把 RPC_URL／CHAIN_ID 寫回去；要先改也可以手動改這兩行。"
fi

PUBLIC_CHAIN=1
case "$CHAIN_ID" in 31337|1337) PUBLIC_CHAIN=0;; esac
if [ "$PUBLIC_CHAIN" = "1" ]; then
  if [ "$DEPLOYER_PK" = "$ANVIL_PK0" ]; then
    bad "部署者是 Anvil 的預設帳戶，而這條鏈不是本機鏈 —— DeployLedger 會直接拒絕"; FAIL=1
    echo "    那把金鑰全世界都有。請用 bash script/bootstrap.sh keys 產生新的。"
  else
    ok "部署者不是 Anvil 預設帳戶"
  fi
  echo "  治理 owners（NATIONAL_OWNERS / OPERATOR_OWNERS）不設的話預設是 Anvil 帳戶 5–9，也會被擋。"
  echo "  那幾把私鑰放 .governance.env，不要放 web/.env.local。"
fi
echo

# --- 結論 ----------------------------------------------------------------
echo "────────────────────────────────────────────────────────"
if [ "$FAIL" = 1 ]; then
  echo "結論：上面有 ✗ 的項目要先處理。"
  echo "────────────────────────────────────────────────────────"
  exit 2
fi
echo "結論：可以部署帳本。"
echo
echo "  bash script/bootstrap.sh deploy          # 建議：金鑰、角色、部署檔、web/.env.local 一次處理"
echo "  forge script script/DeployLedger.s.sol --rpc-url ${RPC} --broadcast${LEGACY_FLAG}   # 手動"
echo "────────────────────────────────────────────────────────"
