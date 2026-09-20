#!/usr/bin/env bash
# 部署前檢查：確認目標鏈能不能跑這套合約，以及要用哪種部署模式。
#
#   ./script/preflight.sh                        # 預設 http://127.0.0.1:28545
#   ./script/preflight.sh http://127.0.0.1:20024 # 指定 RPC
#   RPC_URL=... ./script/preflight.sh
#
# 檢查項目：
#   1. RPC 是否連得上、chainId 是多少
#   2. EIP-1153（TSTORE/TLOAD）—— Uniswap v4 PoolManager 的硬需求
#   3. EIP-5656（MCOPY）—— Cancun 的另一個指令，solc 0.8.26 + evm_version=cancun 會用到
#   4. EIP-1559 —— 決定 forge script 要不要加 --legacy
#   5. 部署者餘額 —— 私有鏈上 Anvil 預設金鑰通常是 0 餘額
#
# 結尾會印出建議的部署指令。

set -uo pipefail

# 注意：變數展開後面接中文字時一定要用 ${VAR} 大括號。
# macOS 內建的 bash 3.2 會把後面的多位元組字元當成識別字的一部分，
# 於是 "$CHAIN_ID）" 會被解析成變數 "CHAIN_ID）"，在 set -u 下直接 unbound variable。

RPC="${1:-${RPC_URL:-http://127.0.0.1:28545}}"
DEPLOYER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

# 只做 TSTORE→TLOAD→回傳 的 initcode；eth_call 會回傳 0x..01，鏈不支援則整段 revert。
TSTORE_PROBE=0x600160005D60005C60005260206000F3
# 同樣手法測 MCOPY（0x5E）。
MCOPY_PROBE=0x60206000600060005E60005260206000F3

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

command -v cast >/dev/null 2>&1 || { echo "找不到 cast，請先安裝 Foundry（bash setup.sh）"; exit 1; }

echo "目標 RPC：$RPC"
echo

# --- 1. 連線與 chainId ---------------------------------------------------
echo "[1/5] 連線"
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

# --- 2. EIP-1153 TSTORE --------------------------------------------------
echo "[2/5] EIP-1153（TSTORE / TLOAD）— Uniswap v4 必要"
HAS_TSTORE=0
RES=$(cast call --rpc-url "$RPC" --create "$TSTORE_PROBE" 2>&1)
case "$RES" in
  0x*1) HAS_TSTORE=1; ok "支援，v4 模組可以部署" ;;
  *)    bad "不支援（或已停用）—— v4 模組無法部署，改用 script/Deploy.s.sol" ;;
esac
echo

# --- 3. EIP-5656 MCOPY ---------------------------------------------------
echo "[3/5] EIP-5656（MCOPY）— solc evm_version=cancun 產出的碼會用到"
HAS_MCOPY=0
RES=$(cast call --rpc-url "$RPC" --create "$MCOPY_PROBE" 2>&1)
case "$RES" in
  0x*) HAS_MCOPY=1; ok "支援" ;;
  *)   bad "不支援 —— 必須把 foundry.toml 的 evm_version 降到 shanghai 或 paris 後重新編譯" ;;
esac
echo

# --- 4. EIP-1559 ---------------------------------------------------------
echo "[4/5] EIP-1559（動態手續費）"
BASEFEE=$(cast block latest --json --rpc-url "$RPC" 2>/dev/null | grep -o '"baseFeePerGas":"[^"]*"' | head -1 | cut -d'"' -f4)
LEGACY_FLAG=""
if [ -n "$BASEFEE" ] && [ "$BASEFEE" != "null" ]; then
  ok "支援（baseFeePerGas = ${BASEFEE}）"
else
  LEGACY_FLAG=" --legacy"
  warn "區塊沒有 baseFeePerGas —— forge script 要加 --legacy"
fi
echo

# --- 5. 部署者餘額 -------------------------------------------------------
echo "[5/5] 部署者"
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PK" 2>/dev/null)
if [ -z "$DEPLOYER" ]; then
  bad "DEPLOYER_PK 格式不正確"
  exit 1
fi
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)
BAL_ETH=$(cast from-wei "${BAL:-0}" 2>/dev/null || echo 0)
echo "  地址：$DEPLOYER"
if [ "${BAL:-0}" = "0" ]; then
  bad "餘額 0 —— 部署一定失敗"
  echo "    私有鏈上 Anvil 的預設金鑰沒有錢。請設一把這條鏈上有餘額的金鑰："
  echo "    export DEPLOYER_PK=0x<你的私鑰>"
else
  ok "餘額 ${BAL_ETH}（整套部署約需數千萬 gas，含 Safe 基礎設施）"
fi
echo
echo "  注意：前端的 RELAYER_PK / CARBON_VERIFIER_PK / DOCUMENT_SIGNER_PK 也要在這條鏈上有餘額，"
echo "  它們要替使用者代送交易（Phase 0 的 gas 由平台付）。"
echo

# --- 結論 ----------------------------------------------------------------
echo "────────────────────────────────────────────────────────"
if [ "$HAS_MCOPY" = "0" ] || [ "$HAS_TSTORE" = "0" ]; then
  echo "結論：這條鏈比 Cancun 舊。"
  echo
  echo "  缺 TSTORE  → v4 展示模組不能部署（改用 Deploy.s.sol，主市場 Listing 不受影響）"
  if [ "$HAS_MCOPY" = "0" ]; then
    echo "  缺 MCOPY   → 連其他合約都不能跑：solc 以 evm_version=cancun 編出來的碼會用到 MCOPY，"
    echo "               必須把 foundry.toml 的 evm_version 改成 shanghai 再重編。"
    echo
    echo "  v4 的編譯期相依已經拆乾淨了，但 shanghai 這條路還卡在 Safe v1.4.1 編不過，"
    echo "  詳見 README「目標鏈沒有 Cancun 的話」與 foundry.toml 的 [profile.shanghai]。"
  fi
  echo
  echo "  最省事的另一條路：把這條鏈的節點升級到有 Cancun（EIP-1153 + EIP-5656）的版本。"
  exit 2
fi

if [ "$HAS_TSTORE" = "1" ]; then
  echo "結論：完整部署（含 v4 展示模組）"
  echo
  echo "  forge script script/DeployV4.s.sol --rpc-url ${RPC} --broadcast${LEGACY_FLAG}"
else
  echo "結論：用 script/Deploy.s.sol 部署（登錄 / 身分 / Listing 市場 / 池化 / 治理全都會部署，只少掉 v4 展示模組）"
  echo "v4 本來就只是展示用，主市場是 Listing，功能不受影響。"
  echo
  echo "  forge script script/Deploy.s.sol --rpc-url ${RPC} --broadcast${LEGACY_FLAG}"
fi
echo
echo "部署後前端（web/.env.local）："
echo "  RPC_URL=$RPC"
echo "  CHAIN_ID=$CHAIN_ID"
echo "────────────────────────────────────────────────────────"
