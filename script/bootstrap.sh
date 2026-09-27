#!/usr/bin/env bash
# 從空白到可以營運：**建金鑰 → 撥款 → 驗餘額 → 部署 → 寫回設定檔**。
#
#   bash script/bootstrap.sh          # 三步走完（fund 會等你撥款）
#   bash script/bootstrap.sh keys     # 只建金鑰
#   bash script/bootstrap.sh fund     # 印出各要多少，等到夠為止
#   bash script/bootstrap.sh deploy   # 驗餘額 → 部署 → 更新 web/.env.local
#   bash script/bootstrap.sh status   # 五把金鑰現在各有多少、部署了沒
#
# ## 金鑰在**你的機器上產生**，不會經過任何人
#
# `cast wallet new` 在本機產生，直接寫進 `web/.env.local`（權限 600，已在 .gitignore）。
# 腳本**只印地址，不印私鑰**——私鑰印到終端機就會進 scrollback，進排程就會進 log。
# 已經有值的金鑰一律保留不覆寫：覆寫一把還在用的 relayer 金鑰，等於把鏈上那些
# 角色綁定全部丟掉。
#
# 環境變數：
#   RPC_URL                   目標鏈（與 web/.env.local 同名同義）
#   SETTLEMENT_TOKEN          外部結算幣。Boltchain 上是 CAFECA 的 TWDC
#   ENV_FILE=web/.env.local   金鑰與設定寫到哪
#   DEPLOY_GAS / SERVICE_GAS  估算撥款額用的 gas 預算（見「要多少」）
#   SAFETY=2                  估出來的金額再乘上的倍數
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
RPC_URL=${RPC_URL:-http://127.0.0.1:28545}
ENV_FILE=${ENV_FILE:-$ROOT/web/.env.local}
# 治理金鑰**不放在 web/.env.local**。那個檔案是網站執行期讀的——
# 讓網站伺服器持有國家 Safe 的 owner 金鑰，等於把主權／營運分權整個抵銷掉：
# 攻進網站的人就拿到了凍結任何人、撤換營運方、升級合約的能力。
# 所以另外一個檔案，網站永遠不會讀它。
GOV_FILE=${GOV_FILE:-$ROOT/.governance.env}
DEPLOY_GAS=${DEPLOY_GAS:-60000000}
SERVICE_GAS=${SERVICE_GAS:-20000000}
SAFETY=${SAFETY:-2}
export PATH="$HOME/.foundry/bin:$PATH"

command -v cast >/dev/null 2>&1 || { echo "找不到 cast，請先安裝 Foundry（bash setup.sh）"; exit 1; }

# ── 五把金鑰 ────────────────────────────────────────────────────────
#
# 名稱｜用途｜要不要餘額。最後一欄不是抄來的，是照著程式碼查的：
#
#   RELAYER_PK           送交易（KYC 註冊、核發、retireFor、承諾上鏈、faucet）   要
#   DOCUMENT_SIGNER_PK   送交易（憑證 documentHash 回寫、費率設定）              要
#   IDENTITY_VERIFIER_PK **只簽 EIP-712 attestation**，由 relayer 送出           不要
#   CARBON_VERIFIER_PK   **只簽核發 attestation**，由 relayer 送出               不要
#
# 後兩把不需要餘額這件事，README 與 preflight.sh 以前都寫錯了（說四把都要）。
# 撥款給它們不會壞掉，但那是白放的錢，而且會讓人以為它們會動鏈。
KEY_NAMES="DEPLOYER_PK RELAYER_PK DOCUMENT_SIGNER_PK IDENTITY_VERIFIER_PK CARBON_VERIFIER_PK"
# 與上面同順序的 gas 預算；0 = 這把不送交易，不需要餘額
key_gas () {
  case "$1" in
    DEPLOYER_PK) echo "$DEPLOY_GAS";;
    RELAYER_PK|DOCUMENT_SIGNER_PK) echo "$SERVICE_GAS";;
    *) echo 0;;
  esac
}
key_role () {
  case "$1" in
    DEPLOYER_PK) echo "部署整套合約（含 Safe 基礎設施）";;
    RELAYER_PK) echo "代送使用者相關交易、承諾上鏈";;
    DOCUMENT_SIGNER_PK) echo "憑證雜湊回寫、費率設定";;
    IDENTITY_VERIFIER_PK) echo "簽身分 attestation（不送交易）";;
    CARBON_VERIFIER_PK) echo "簽核發 attestation（不送交易）";;
  esac
}

rpc () {
  local out
  out=$(curl -fs --max-time "${RPC_TIMEOUT:-10}" -X POST "${RPC_URL}" \
        -H 'content-type: application/json' -d "$1" 2>/dev/null) || return 1
  printf '%s' "$out"
}
rpc_result () { rpc "$1" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p'; }

need_chain () {
  local id; id=$(rpc_result '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}') || true
  [ -n "$id" ] || { echo "!! 連不上 ${RPC_URL}"; exit 1; }
  CHAIN_ID=$((id))
}

# 讀 ENV_FILE 裡某個變數目前的值（可能不存在）
env_get () { [ -f "$ENV_FILE" ] && sed -n "s/^$1=\(.*\)$/\1/p" "$ENV_FILE" | tail -1 || true; }

# 寫入或就地取代一行。不存在就追加。
env_set () {
  local k=$1 v=$2 tmp
  tmp=$(mktemp)
  if [ -f "$ENV_FILE" ] && grep -q "^${k}=" "$ENV_FILE"; then
    # 用 awk 而不是 sed -i：BSD 與 GNU 的 -i 參數不一樣，而私鑰裡的字元
    # 拿去做 sed 的替換字串也不安全。
    awk -v k="$k" -v v="$v" -F= 'BEGIN{OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    [ -f "$ENV_FILE" ] && cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

ANVIL_PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# 「這個值算不算已經設好了」。空的、註解掉的、或還是 anvil 的公開金鑰，都不算。
usable () { [ -n "$1" ] && [ "$1" != "$ANVIL_PK0" ] && case "$1" in 0x*) return 0;; *) return 1;; esac; }

addr_of () { cast wallet address --private-key "$1" 2>/dev/null; }

# ── keys ───────────────────────────────────────────────────────────
cmd_keys () {
  mkdir -p "$(dirname "$ENV_FILE")"
  if [ ! -f "$ENV_FILE" ]; then
    echo ">> 從 web/.env.example 建立 $(basename "$ENV_FILE")"
    cp "$ROOT/web/.env.example" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  # AUTH_SECRET 也在這裡一起生成：它同時是 CAFECA 登入 nonce 的 HMAC 金鑰，
  # production 沒設會直接起不來，而範例值等於沒有保護。
  local cur
  cur=$(env_get AUTH_SECRET)
  case "$cur" in
    ""|please-generate*) env_set AUTH_SECRET "$(openssl rand -base64 32)"; echo "   AUTH_SECRET     已產生";;
    *) echo "   AUTH_SECRET     已存在，保留";;
  esac

  for k in $KEY_NAMES; do
    cur=$(env_get "$k")
    if usable "$cur"; then
      printf '   %-22s 已存在，保留  %s\n' "$k" "$(addr_of "$cur")"
      continue
    fi
    # cast wallet new 會把私鑰印在 stdout。整段吃進變數，只把地址印出來。
    local out pk
    out=$(cast wallet new)
    pk=$(printf '%s' "$out" | sed -n 's/^Private key: *//p')
    [ -n "$pk" ] || { echo "!! cast wallet new 的輸出看不懂，中止"; exit 1; }
    env_set "$k" "$pk"
    printf '   %-22s 已產生        %s\n' "$k" "$(addr_of "$pk")"
    unset out pk
  done
  echo ">> 服務金鑰寫在 ${ENV_FILE}（權限 600，已在 .gitignore）。私鑰不會印出來。"
  echo
  cmd_gov_keys
}

# ── 治理 Safe 的 owner ──────────────────────────────────────────────
#
# 國家 Safe 2-of-3、營運 Safe 1-of-2。部署腳本吃的是**地址清單**
# （NATIONAL_OWNERS / OPERATOR_OWNERS），私鑰只有之後用 govern.sh 簽字時才會用到。
#
# 預設值是 anvil 的帳戶 5~9，而那些金鑰印在 anvil 的啟動畫面上——所以在公開鏈上
# 部署腳本會直接 revert（PublicKeyOnPublicChain）。那個檢查是對的：用它們部署
# 等於把治理權公開送出去。
#
# ⚠️ **這裡產生的五把金鑰全部落在同一台機器上。**
#    對 Phase 0 展示可以，對真正的治理不行——2-of-3 的意義在於三把金鑰由三個
#    不同的人、在三台不同的裝置上保管。正式部署時應該由各持有人自己產生，
#    只把**地址**交出來，設成 NATIONAL_OWNERS / OPERATOR_OWNERS 就好，
#    這支腳本會直接沿用、不會另外產生。
GOV_KEYS="NATIONAL_OWNER_1_PK NATIONAL_OWNER_2_PK NATIONAL_OWNER_3_PK OPERATOR_OWNER_1_PK OPERATOR_OWNER_2_PK"

gov_get () { [ -f "$GOV_FILE" ] && sed -n "s/^$1=\(.*\)$/\1/p" "$GOV_FILE" | tail -1 || true; }
gov_set () {
  local k=$1 v=$2 tmp; tmp=$(mktemp)
  if [ -f "$GOV_FILE" ] && grep -q "^${k}=" "$GOV_FILE"; then
    awk -v k="$k" -v v="$v" -F= 'BEGIN{OFS="="} $1==k {print k "=" v; next} {print}' "$GOV_FILE" > "$tmp"
  else
    [ -f "$GOV_FILE" ] && cat "$GOV_FILE" > "$tmp"
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
  mv "$tmp" "$GOV_FILE"; chmod 600 "$GOV_FILE"
}

cmd_gov_keys () {
  # 外部已經給了地址清單就照用，不要另外產生——那才是正式的樣子。
  if [ -n "${NATIONAL_OWNERS:-}" ] && [ -n "${OPERATOR_OWNERS:-}" ]; then
    echo ">> 治理 owner 由環境變數提供，不另外產生"
    echo "   NATIONAL_OWNERS  ${NATIONAL_OWNERS}"
    echo "   OPERATOR_OWNERS  ${OPERATOR_OWNERS}"
    return 0
  fi
  [ -f "$GOV_FILE" ] || { : > "$GOV_FILE"; chmod 600 "$GOV_FILE"; }
  echo ">> 治理 Safe 的 owner（國家 2-of-3、營運 1-of-2）"
  local k cur out pk
  for k in $GOV_KEYS; do
    cur=$(gov_get "$k")
    if usable "$cur"; then
      printf '   %-22s 已存在，保留  %s\n' "$k" "$(addr_of "$cur")"
      continue
    fi
    out=$(cast wallet new)
    pk=$(printf '%s' "$out" | sed -n 's/^Private key: *//p')
    [ -n "$pk" ] || { echo "!! cast wallet new 的輸出看不懂，中止"; exit 1; }
    gov_set "$k" "$pk"
    printf '   %-22s 已產生        %s\n' "$k" "$(addr_of "$pk")"
    unset out pk
  done
  echo ">> 治理金鑰寫在 ${GOV_FILE}（權限 600，網站**不會**讀它）"
  echo "   ⚠️ 五把都在這一台機器上。2-of-3 的意義是三個人三台裝置——"
  echo "      正式部署請由各持有人自己產生，只把地址設成 NATIONAL_OWNERS / OPERATOR_OWNERS。"
}

# 把治理金鑰換算成部署腳本要的地址清單
gov_owner_lists () {
  if [ -n "${NATIONAL_OWNERS:-}" ] && [ -n "${OPERATOR_OWNERS:-}" ]; then return 0; fi
  local n1 n2 n3 o1 o2
  n1=$(addr_of "$(gov_get NATIONAL_OWNER_1_PK)"); n2=$(addr_of "$(gov_get NATIONAL_OWNER_2_PK)"); n3=$(addr_of "$(gov_get NATIONAL_OWNER_3_PK)")
  o1=$(addr_of "$(gov_get OPERATOR_OWNER_1_PK)"); o2=$(addr_of "$(gov_get OPERATOR_OWNER_2_PK)")
  [ -n "$n1" ] && [ -n "$n2" ] && [ -n "$n3" ] && [ -n "$o1" ] && [ -n "$o2" ] \
    || { echo "!! 治理金鑰還沒產生，先跑 bash script/bootstrap.sh keys"; exit 1; }
  export NATIONAL_OWNERS="$n1,$n2,$n3"
  export OPERATOR_OWNERS="$o1,$o2"
}

# ── fund ───────────────────────────────────────────────────────────
#
# 「要多少」不是猜的，是 gas 預算 × 這條鏈現在的 gasPrice × 安全倍數。
# 三個輸入都印出來，你可以自己算一次，也可以用環境變數調。
wei_needed () { # $1 = gas budget
  local gp; gp=$(rpc_result '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}')
  [ -n "$gp" ] || gp=0x3b9aca00   # 1 gwei，讀不到時的保守值
  # bash 的整數是 64-bit，gas × gasPrice × 倍數 還放得下（1e8 × 1e10 × 2 ≈ 2e18）。
  # 但餘額可能超過 9.2e18 而溢位，所以**比較**那一步用 awk 的浮點數做（見 enough）。
  echo $(( $1 * $((gp)) * SAFETY ))
}

# 表格用。18 位小數在這裡只是雜訊，留 6 位就看得出夠不夠，欄位也對得齊。
fmt_eth () {
  local e; e=$(cast from-wei "$1" 2>/dev/null) || { echo "$1 wei"; return; }
  awk -v v="$e" 'BEGIN{printf "%.6f", v+0}'
}

balance_wei () {
  local b
  b=$(rpc_result "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$1\",\"latest\"]}")
  [ -n "$b" ] || b=0x0
  # 十六進位轉十進位用 cast：可能超過 64-bit，不能用 $(( ))
  cast to-dec "$b" 2>/dev/null || echo 0
}

# 十進位大數比較。餘額可能有 20 位數，超過 bash 的 64-bit，所以用 awk 的浮點。
# 浮點在這裡夠用：我們問的是「夠不夠」，不是「差幾 wei」。
enough () { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 >= b+0)}'; }

cmd_fund () {
  need_chain
  local short=0
  echo ">> 目標鏈 ${RPC_URL}（chainId ${CHAIN_ID}）"
  echo "   撥款額 = gas 預算 × 目前 gasPrice × ${SAFETY} 倍"
  echo
  printf '   %-20s %-44s %12s %14s\n' "金鑰" "地址" "需要" "現有"
  for k in $KEY_NAMES; do
    local pk gas addr need bal mark
    pk=$(env_get "$k")
    usable "$pk" || { printf '   %-22s ⚠️ 還沒產生，先跑 bootstrap.sh keys\n' "$k"; short=1; continue; }
    addr=$(addr_of "$pk")
    gas=$(key_gas "$k")
    bal=$(balance_wei "$addr")
    if [ "$gas" = "0" ]; then
      printf '   %-20s %-44s %12s %14s\n' "$k" "$addr" "—" "$(fmt_eth "$bal")"
      continue
    fi
    need=$(wei_needed "$gas")
    if enough "$bal" "$need"; then mark="✓"; else mark="✗"; short=1; fi
    printf ' %s %-20s %-44s %12s %14s\n' "$mark" "$k" "$addr" "$(fmt_eth "$need")" "$(fmt_eth "$bal")"
  done
  echo
  for k in $KEY_NAMES; do
    [ "$(key_gas "$k")" = "0" ] && printf '   %s 不需要餘額：%s\n' "$k" "$(key_role "$k")"
  done
  echo "   治理 Safe 的 owner 也不需要餘額：簽章是鏈下的，execTransaction 的 gas 由 SENDER_PK 付"
  if [ "$short" = "1" ]; then
    echo
    echo ">> 還沒夠。撥款到上面標 ✗ 的地址，然後再跑一次："
    echo "   bash script/bootstrap.sh fund"
    return 1
  fi
  echo ">> 餘額都夠了，可以部署：bash script/bootstrap.sh deploy"
}

# ── deploy ─────────────────────────────────────────────────────────
cmd_deploy () {
  need_chain
  cmd_fund >/dev/null || { echo "!! 餘額不足，先跑 bash script/bootstrap.sh fund 看差多少"; exit 1; }

  local pk; pk=$(env_get DEPLOYER_PK)
  usable "$pk" || { echo "!! DEPLOYER_PK 還沒產生"; exit 1; }

  # COMMITTER 預設等於 OPERATOR（也就是 deployer），但送出承諾的腳本用的是
  # COMMITTER_PK ?? RELAYER_PK。兩邊對不上的話，第一次 bank:commit 必定
  # AccessControl revert——而那個錯誤看不出是這裡設錯。所以預設就把
  # COMMITTER 指到 relayer 的地址。
  local relayer_addr; relayer_addr=$(addr_of "$(env_get RELAYER_PK)")
  export COMMITTER=${COMMITTER:-$relayer_addr}
  export DEPLOYER_PK=$pk
  export RPC_URL

  # 治理 owner。沒有這一步，公開鏈上會撞到 PublicKeyOnPublicChain——
  # 部署腳本拒絕用 anvil 的預設帳戶當國家 Safe 的持有人，而那是對的。
  gov_owner_lists
  export NATIONAL_THRESHOLD=${NATIONAL_THRESHOLD:-2}
  export OPERATOR_THRESHOLD=${OPERATOR_THRESHOLD:-1}

  local script=script/DeployV4.s.sol
  # 沒有 EIP-1153 的鏈部署不了 v4，改用核心那一支。
  local probe
  probe=$(rpc_result '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"data":"0x600160005D60005C60005260206000F3"},"latest"]}') || true
  case "$probe" in *1) ;; *) script=script/Deploy.s.sol; echo ">> 這條鏈沒有 EIP-1153，改用 ${script}（少 v4 展示模組，主市場不受影響）";; esac

  # 部署是一串幾十筆交易。中途按 Ctrl-C 或連線斷掉，鏈上會留下做到一半的狀態，
  # 而**下一次重跑會撞上 "nonce too low" / "replacement transaction underpriced"**——
  # 那個錯誤完全看不出是上一次中斷造成的。本機鏈重開就好；外部鏈得先確認
  # broadcast/ 底下那一份 run-latest.json 送到哪裡，再決定是續傳還是換一把 deployer。
  echo ">> 部署 ${script} → chainId ${CHAIN_ID}"
  echo "   這會送出幾十筆交易，需要幾分鐘。**中途不要中斷**——中斷之後重跑會看到"
  echo "   nonce 相關的錯誤，而那個訊息看不出原因。"
  echo "   COMMITTER = ${COMMITTER}（relayer，這樣 bank:commit 才送得出去）"
  echo "   NATIONAL_OWNERS = ${NATIONAL_OWNERS}（${NATIONAL_THRESHOLD}-of-3）"
  echo "   OPERATOR_OWNERS = ${OPERATOR_OWNERS}（${OPERATOR_THRESHOLD}-of-2）"
  [ -n "${SETTLEMENT_TOKEN:-}" ] \
    && echo "   SETTLEMENT_TOKEN = ${SETTLEMENT_TOKEN}（不會自己發 MockTWD）" \
    || echo "   ⚠️ 沒有 SETTLEMENT_TOKEN，會部署 MockTWD。外部鏈上通常該指定既有的結算幣。"

  forge script "$script" --rpc-url "$RPC_URL" --broadcast | tail -40

  local dep="$ROOT/deployments/${CHAIN_ID}.json"
  [ -f "$dep" ] || { echo "!! 部署檔沒有產生：${dep}"; exit 1; }

  echo
  echo ">> 更新 $(basename "$ENV_FILE")"
  env_set RPC_URL "$RPC_URL"
  env_set CHAIN_ID "$CHAIN_ID"
  [ -n "${SETTLEMENT_TOKEN:-}" ] && env_set SETTLEMENT_TOKEN "$SETTLEMENT_TOKEN"
  echo "   RPC_URL / CHAIN_ID 已寫入"

  echo
  echo ">> 部署合約地址（deployments/${CHAIN_ID}.json）"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$dep" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k, v in d.items():
    if isinstance(v, str) and v.startswith("0x") and len(v) == 42:
        print(f"   {k:24} {v}")
PY
  else
    cat "$dep"
  fi
  echo
  echo ">> 還要做的兩件事："
  echo "   1. web/.env.local 的 SITE_ORIGIN 要與瀏覽器網址列逐字相同（含 scheme 與 port）"
  echo "   2. 登入一次，把 /account 上的地址填進 ADMIN_ADDRESSES，然後重啟"
  echo "   3. ./script/govern.sh status —— 每一格都該是 true，admin 指向 Timelock、sov 指向國家 Safe"
  echo "      之後要動治理時：govern.sh 的簽章金鑰在 ${GOV_FILE}，送出 execTransaction 需要 SENDER_PK（任何有餘額的帳戶）"
}

# ── status ─────────────────────────────────────────────────────────
cmd_status () {
  need_chain
  echo "鏈       ${RPC_URL}（chainId ${CHAIN_ID}）"
  local dep="$ROOT/deployments/${CHAIN_ID}.json"
  [ -f "$dep" ] && echo "部署檔   deployments/${CHAIN_ID}.json" || echo "部署檔   ⚠️ 還沒部署到這條鏈"
  echo
  cmd_fund || true
}

case "${1:-all}" in
  keys)   cmd_keys;;
  fund)   cmd_fund;;
  deploy) cmd_deploy;;
  status) cmd_status;;
  all)    cmd_keys; echo; cmd_fund && { echo; cmd_deploy; };;
  *)      sed -n '2,30p' "$0"; exit 1;;
esac
