#!/usr/bin/env bash
# 從空白到可以營運：**建金鑰 → 撥款 → 驗餘額 → 部署 → 寫回設定檔**。
#
#   bash script/bootstrap.sh          # 三步走完（fund 會等你撥款）
#   bash script/bootstrap.sh keys     # 只建金鑰
#   bash script/bootstrap.sh fund     # 印出各要多少，等到夠為止
#   bash script/bootstrap.sh deploy   # 驗餘額 → 部署 → 更新 web/.env.local
#   bash script/bootstrap.sh status   # 五把金鑰現在各有多少、部署了沒、角色對不對
#   bash script/bootstrap.sh roles    # 只做角色檢查：鏈上授權清單對照 web/.env.local 的金鑰
#
# ## 部署的是哪一套
#
# 預設部署**設計 v4 的帳本合約**（script/DeployLedger.s.sol）：鏈上只有 Ledger（每小時的承諾鏈、
# 授權金鑰清單與門檻、記帳 TWD、營運 Safe 的入出金確認）與治理（國家 Safe、營運 Safe、Timelock）。
# 登錄簿、身分、市場、憑證都是鏈下帳本裡的簽章事件。
#
# ## 金鑰在**你的機器上產生**，不會經過任何人
#
# 在本機以 openssl 產生（不經過任何指令的輸出），直接寫進 `web/.env.local`（權限 600，已在 .gitignore）。
# 腳本**只印地址，不印私鑰**——私鑰印到終端機就會進 scrollback，進排程就會進 log。
# 已經有值的金鑰一律保留不覆寫：覆寫一把還在用的 relayer 金鑰，等於把鏈上那些
# 角色綁定全部丟掉。
#
# 環境變數：
#   RPC_URL                   目標鏈（與 web/.env.local 同名同義）
#   ENV_FILE=web/.env.local   金鑰與設定寫到哪
#   DEPLOY_GAS                部署的 gas 預算（實測約 1,340 萬）
#   SAFETY=2                  估出來的金額再乘上的倍數
#   COMMIT_GAS / COMMIT_DAYS  帳本版：一期承諾的 gas 上限（實測最多約 27 萬）× 每小時一期 × 幾天
#   CAFECA_KEYRING            帳本版：CAFECA 的 KeyringValidator（查核使用者 WebAuthn 簽章用）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
ENV_FILE=${ENV_FILE:-$ROOT/web/.env.local}
# 目標鏈：shell 的 RPC_URL → web/.env.local 的 RPC_URL → 本機 anvil。
# 只看 shell 的話，已經設好外部鏈的機器直接跑 `bootstrap.sh deploy` 會跑去連本機，錯誤看起來像節點掛了。
if [ -z "${RPC_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  RPC_URL=$(sed -n 's/^RPC_URL=\(.*\)$/\1/p' "$ENV_FILE" | tail -1 | tr -d '"'"'"'\r')
  [ -n "$RPC_URL" ] && echo ">> RPC_URL 取自 $(basename "$ENV_FILE")：${RPC_URL}"
fi
RPC_URL=${RPC_URL:-http://127.0.0.1:28545}
# 治理金鑰**不放在 web/.env.local**。那個檔案是網站執行期讀的——
# 讓網站伺服器持有國家 Safe 的 owner 金鑰，等於把主權／營運分權整個抵銷掉：
# 攻進網站的人就拿到了凍結任何人、撤換營運方、升級合約的能力。
# 所以另外一個檔案，網站永遠不會讀它。
GOV_FILE=${GOV_FILE:-$ROOT/.governance.env}
# 帳本版的部署實測約 1,340 萬 gas（Safe 基礎設施＋Timelock＋Ledger＋授權清單）；舊版幾十筆合約要 6,000 萬
DEPLOY_GAS=${DEPLOY_GAS:-20000000}
COMMIT_GAS=${COMMIT_GAS:-270000}
COMMIT_DAYS=${COMMIT_DAYS:-30}
SAFETY=${SAFETY:-2}
# 模擬人物的帳戶不送鏈上交易，只簽帳本事件；只有入金是鏈上交易，gas 由 DEPLOYER_PK 代付。
# 要把那幾筆算進撥款額就設 SIM_ACCOUNTS（npm run mm 的人物數）。
SIM_ACCOUNTS=${SIM_ACCOUNTS:-0}
SIM_GAS_TOPUP=${SIM_GAS_TOPUP:-1000000000000000}   # 1e15 wei／人物
export PATH="$HOME/.foundry/bin:$PATH"

command -v cast >/dev/null 2>&1 || { echo "找不到 cast，請先安裝 Foundry（bash setup.sh）"; exit 1; }

# ── 五把金鑰 ────────────────────────────────────────────────────────
#
# 名稱｜用途｜要不要餘額。最後一欄不是抄來的，是照著程式碼查的：
#
#   DEPLOYER_PK          部署帳本合約與治理；做市與模擬人物的撥款、gas 也從它出      要
#   RELAYER_PK           每小時提交承諾（COMMITTER）、簽收單回執（RECEIPT_SIGNER）    要
#   DOCUMENT_SIGNER_PK   只簽帳本的憑證文件雜湊事件                                   不要
#   IDENTITY_VERIFIER_PK 只簽帳本的身分事件                                           不要
#   CARBON_VERIFIER_PK   只簽帳本的核發事件、月度查核                                 不要
KEY_NAMES="DEPLOYER_PK RELAYER_PK DOCUMENT_SIGNER_PK IDENTITY_VERIFIER_PK CARBON_VERIFIER_PK"
# gas 預算；0 = 這把不送交易，不需要餘額
key_gas () {
  case "$1" in
    DEPLOYER_PK) echo "$DEPLOY_GAS";;
    RELAYER_PK) echo $(( COMMIT_GAS * 24 * COMMIT_DAYS ));;
    *) echo 0;;
  esac
}
key_role () {
  case "$1" in
    DEPLOYER_PK) echo "部署帳本合約與治理（部署完即放棄全部權限）";;
    RELAYER_PK) echo "每小時提交承諾（COMMITTER）、簽收單回執（RECEIPT_SIGNER）";;
    DOCUMENT_SIGNER_PK) echo "簽帳本的憑證文件雜湊事件（不送交易）";;
    IDENTITY_VERIFIER_PK) echo "簽帳本的身分事件（不送交易）";;
    CARBON_VERIFIER_PK) echo "簽帳本的核發事件、月度查核（不送交易）";;
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
# 0x + 64 個十六進位字元才算。只看「0x 開頭」的話，README 的佔位字「0x…」也會過關。
usable () {
  [ -n "$1" ] && [ "$1" != "$ANVIL_PK0" ] || return 1
  printf '%s' "$1" | grep -Eq '^0x[0-9a-fA-F]{64}$'
}

# 地址只取輸出裡的 0x 加 40 碼：不同版本的 cast 有的印到 stdout、有的印到 stderr，有的多一行說明。
addr_of () { cast wallet address --private-key "$1" 2>&1 | grep -Eo '0x[0-9a-fA-F]{40}' | head -1; }

# 產生一把私鑰，只回私鑰本身（呼叫端吃進變數，不印出來）。
#
# 以前用 `out=$(cast wallet new)` 再從輸出裡挑「Private key:」那一行。某些版本的 cast 把那段印到
# **終端機**而不是 stdout——於是變數是空的、腳本中止，而私鑰已經整段顯示在螢幕上（踩過）。
# 產生私鑰不需要 cast：32 bytes 的密碼學亂數就是私鑰，只要落在 secp256k1 的有效範圍（1 ≤ k < n）；
# 推得出地址就代表有效（落在範圍外的機率約 2^-128，真的碰到就換一把）。
new_pk () {
  local pk i
  for i in 1 2 3; do
    pk="0x$(openssl rand -hex 32)"
    printf '%s' "$pk" | grep -Eq '^0x[0-9a-f]{64}$' || continue
    [ -n "$(addr_of "$pk")" ] && { printf '%s' "$pk"; return 0; }
  done
  return 1
}

# 本機開發鏈（anvil / hardhat 的慣例 chainId）。need_chain 之後才有 CHAIN_ID。
is_local () { [ "${CHAIN_ID:-}" = "31337" ] || [ "${CHAIN_ID:-}" = "1337" ]; }

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
  # DATA_KEY：個人資料（身分證號、統編、姓名、收款帳號與戶名）的加密金鑰。外部鏈上沒有它，網站拒收那些資料。
  # 已經有就絕不覆寫——換掉等於讓既有的密文全部讀不回來（要換用 DATA_KEY_PREVIOUS ＋ npm run data:protect -- --rekey）。
  cur=$(env_get DATA_KEY)
  if [ -z "$cur" ]; then
    env_set DATA_KEY "$(openssl rand -base64 32)"
    echo "   DATA_KEY        已產生（另外備份，不要和 web/data 的備份放在一起；遺失就讀不回加密的個人資料）"
  else
    echo "   DATA_KEY        已存在，保留"
  fi

  for k in $KEY_NAMES; do
    cur=$(env_get "$k")
    if usable "$cur"; then
      printf '   %-22s 已存在，保留  %s\n' "$k" "$(addr_of "$cur")"
      continue
    fi
    # 私鑰只進變數與檔案，不印出來；畫面上只有地址
    local pk
    pk=$(new_pk) || { echo "!! 產生 $k 失敗（openssl rand 或 cast wallet address 不能用），中止"; exit 1; }
    env_set "$k" "$pk"
    printf '   %-22s 已產生        %s\n' "$k" "$(addr_of "$pk")"
    unset pk
  done
  echo ">> 服務金鑰寫在 ${ENV_FILE}（權限 600，已在 .gitignore）。私鑰不會印出來。"
  echo
  cmd_gov_keys
}

# ── 治理 Safe 的 owner ──────────────────────────────────────────────
#
# 國家 Safe 2-of-3、營運 Safe 1-of-2。部署腳本吃的是**地址清單**
# （NATIONAL_OWNERS / OPERATOR_OWNERS），私鑰只有之後用 govern.sh 簽字、或營運 Safe 持有人用
# `npm run fiat` 確認新台幣入出金時才會用到（兩者都只從 .governance.env 讀，網站不讀）。
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
  local k cur pk
  for k in $GOV_KEYS; do
    cur=$(gov_get "$k")
    if usable "$cur"; then
      printf '   %-22s 已存在，保留  %s\n' "$k" "$(addr_of "$cur")"
      continue
    fi
    pk=$(new_pk) || { echo "!! 產生 $k 失敗（openssl rand 或 cast wallet address 不能用），中止"; exit 1; }
    gov_set "$k" "$pk"
    printf '   %-22s 已產生        %s\n' "$k" "$(addr_of "$pk")"
    unset pk
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
  echo "   帳本版：RELAYER_PK 備 ${COMMIT_DAYS} 天 × 24 期承諾 × ${COMMIT_GAS} gas（COMMIT_DAYS / COMMIT_GAS 可調）"
  echo "   做市與模擬人物（npm run mm）：撥款是營運 Safe 的鏈上入金確認（creditDeposit），gas 由 DEPLOYER_PK 出；"
  echo "     不需要持有任何代幣（記帳 TWD 只存在帳本合約裡）。模擬人物要算進撥款額：SIM_ACCOUNTS=30"
  [ "$SIM_ACCOUNTS" = 0 ] || echo "   DEPLOYER_PK 另加 ${SIM_ACCOUNTS} × $(fmt_eth "$SIM_GAS_TOPUP")：模擬市場的人物帳戶由平台代付 gas"
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
    # DEPLOYER_PK 同時是模擬器撥款給人物帳戶的來源（OPERATOR_PK 的第一順位）。
    [ "$k" = "DEPLOYER_PK" ] && need=$(( need + SIM_ACCOUNTS * SIM_GAS_TOPUP ))
    if enough "$bal" "$need"; then mark="✓"; else mark="✗"; short=1; fi
    printf ' %s %-20s %-44s %12s %14s\n' "$mark" "$k" "$addr" "$(fmt_eth "$need")" "$(fmt_eth "$bal")"
  done
  echo
  for k in $KEY_NAMES; do
    [ "$(key_gas "$k")" = "0" ] && printf '   %s 不需要餘額：%s\n' "$k" "$(key_role "$k")"
  done
  echo "   治理 Safe 的 owner 也不需要餘額：簽章是鏈下的，execTransaction 的 gas 由 SENDER_PK 付"
  echo "   一般使用者也不需要：買賣與註銷是簽一筆帳本事件，不送交易（入金與出金由營運 Safe 在鏈上確認，使用者不送交易）"
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

  # 送出承諾的腳本（ledger:commit）用的是 COMMITTER_PK ?? RELAYER_PK。
  # DeployLedger 的 COMMITTER 預設是部署者，兩邊對不上的話第一期承諾必定 AccessControl revert，
  # 所以預設就把 COMMITTER 指到 relayer 的地址。
  local relayer_addr; relayer_addr=$(addr_of "$(env_get RELAYER_PK)")
  export COMMITTER=${COMMITTER:-$relayer_addr}

  # 授權金鑰清單。**這三個不傳，DeployLedger 會預設成部署者**——而網站簽身分、
  # 簽核發、回寫文件雜湊用的是 web/.env.local 裡各自那一把。結果是部署看起來成功，
  # 帳本裡的每一筆身分、核發事件在重播時都被判為未授權。所以在部署前就對齊。
  local k
  for k in IDENTITY_VERIFIER_PK CARBON_VERIFIER_PK DOCUMENT_SIGNER_PK; do
    usable "$(env_get "$k")" || { echo "!! ${k} 還沒產生或格式不對，先跑 bash script/bootstrap.sh keys"; exit 1; }
  done
  export IDENTITY_VERIFIER=${IDENTITY_VERIFIER:-$(addr_of "$(env_get IDENTITY_VERIFIER_PK)")}
  export CARBON_VERIFIER=${CARBON_VERIFIER:-$(addr_of "$(env_get CARBON_VERIFIER_PK)")}
  export DOCUMENT_SIGNER=${DOCUMENT_SIGNER:-$(addr_of "$(env_get DOCUMENT_SIGNER_PK)")}

  local dep_before="$ROOT/deployments/${CHAIN_ID}.json" redeploy=0
  if [ -f "$dep_before" ]; then
    redeploy=1
    echo ">> deployments/${CHAIN_ID}.json 已存在，這次部署會取代它（舊合約留在鏈上，但網站不再指向它們）"
  fi
  export DEPLOYER_PK=$pk
  export RPC_URL

  # 治理 owner。沒有這一步，公開鏈上會撞到 PublicKeyOnPublicChain——
  # 部署腳本拒絕用 anvil 的預設帳戶當國家 Safe 的持有人，而那是對的。
  gov_owner_lists
  export NATIONAL_THRESHOLD=${NATIONAL_THRESHOLD:-2}
  export OPERATOR_THRESHOLD=${OPERATOR_THRESHOLD:-1}

  local script
  script=script/DeployLedger.s.sol
  mkdir -p "$ROOT/deployments"   # 部署紀錄不進版本控制，新 clone 可能沒有這個資料夾；forge 不會自己建
  # 帳本授權清單（簽章模型方案 B）：
  #   · 高頻角色各一把：身分、查驗、文件、收單回執（= relayer，它同時提交承諾）
  #   · 主權、營運登記的是 Safe 持有人的 EOA，門檻與 Safe 相同；查核角色預設就是查驗金鑰、1-of-1
  # 網站**不持有**主權／營運持有人的金鑰：需要這兩個角色的事件（例如費率）在後台建立提案，
  # 由持有人用 npm run ledger:authority 簽署後送出。
  export RECEIPT_SIGNER=${RECEIPT_SIGNER:-$relayer_addr}
  export AUDITORS=${AUDITORS:-$CARBON_VERIFIER}
  # CAFECA 的 KeyringValidator：查核工具據此讀使用者 passkey 的 KeyAdded／KeyRemoved。
  # 順序：shell → web/.env.local → Boltchain 上已知的那一份。
  if [ -z "${CAFECA_KEYRING:-}" ]; then CAFECA_KEYRING=$(env_get CAFECA_KEYRING); fi
  if [ -z "${CAFECA_KEYRING:-}" ] && [ "$CHAIN_ID" = "8018" ]; then CAFECA_KEYRING=0x367a9E8a6E8bA108F4cC4B863d03dD618aD7893b; fi
  if [ -n "${CAFECA_KEYRING:-}" ]; then export CAFECA_KEYRING; fi
  # 規則第 4 版：不接外部結算幣。帳本合約部署時建立自己的記帳 TWD（LedgerTWD：只有帳本合約能持有、
  # 不能轉出），使用者的錢是信託專戶裡的真新台幣，入出金由營運 Safe 在鏈上確認（npm run fiat）。
  if [ -n "${SETTLEMENT_TOKEN:-}" ] || [ -n "$(env_get SETTLEMENT_TOKEN)" ]; then
    echo "   ⚠️ SETTLEMENT_TOKEN 已經不用了（帳本合約自己建立記帳 TWD），忽略它；可以從 $(basename "$ENV_FILE") 刪掉"
  fi

  # 部署是一串幾十筆交易。中途按 Ctrl-C 或連線斷掉，鏈上會留下做到一半的狀態，
  # 而**下一次重跑會撞上 "nonce too low" / "replacement transaction underpriced"**——
  # 那個錯誤完全看不出是上一次中斷造成的。本機鏈重開就好；外部鏈得先確認
  # broadcast/ 底下那一份 run-latest.json 送到哪裡，再決定是續傳還是換一把 deployer。
  echo ">> 部署 ${script} → chainId ${CHAIN_ID}"
  echo "   這會送出幾十筆交易。外部鏈上加了 --slow（一筆確認再送下一筆），"
  echo "   所以要等 筆數 × 出塊時間，可能十幾分鐘。**中途不要中斷。**"
  echo "   COMMITTER / RECEIPT_SIGNER = ${COMMITTER} / ${RECEIPT_SIGNER}（relayer：每小時承諾、收單回執）"
  echo "   IDENTITY_VERIFIER = ${IDENTITY_VERIFIER}（帳本身分事件）"
  echo "   CARBON_VERIFIER   = ${CARBON_VERIFIER}（帳本核發事件）"
  echo "   DOCUMENT_SIGNER   = ${DOCUMENT_SIGNER}（憑證文件雜湊事件）"
  echo "   AUDITORS          = ${AUDITORS}（月度查核，門檻 ${AUDITOR_THRESHOLD:-1}）"
  echo "   主權角色 = 國家 Safe 持有人 ${NATIONAL_OWNERS}（帳本門檻 ${SOVEREIGN_THRESHOLD:-$NATIONAL_THRESHOLD}）"
  echo "   營運角色 = 營運 Safe 持有人 ${OPERATOR_OWNERS}（帳本門檻 ${OPERATOR_AUTH_THRESHOLD:-$OPERATOR_THRESHOLD}）"
  echo "   CAFECA_KEYRING    = ${CAFECA_KEYRING:-（沒有：無法查核 CAFECA passkey 簽章，只收 EOA 簽章）}"
  echo "   新台幣 = 帳本合約自己建立的記帳 TWD；入金與出金由營運 Safe 確認（持有人金鑰在 .governance.env 的 OPERATOR_OWNER_<n>_PK）"

  # 外部鏈預設加 --slow：一筆確認過再送下一筆。
  #
  # 為什麼需要它：forge 預設會把整批交易用連續的 nonce **一次送出去**。geth 會把
  # 未來 nonce 的交易放進佇列等前面那筆到齊，但那是 geth 的行為，不是規範——
  # 比較簡單的節點實作會直接回 `nonce too high` 把整批打掉。Boltchain
  # （boltchain/v0.1.0）就是這樣，而那個錯誤訊息看起來像是我們算錯 nonce，
  # 其實 nonce 是對的（實測 latest == pending，沒有任何卡住的交易）。
  #
  # 代價是慢：幾十筆 × 6 秒出塊。本機鏈不需要，所以只在外部鏈開。
  local extra=""
  is_local || extra="--slow"
  # shellcheck disable=SC2086
  forge script "$script" --rpc-url "$RPC_URL" --broadcast $extra ${FORGE_EXTRA_ARGS:-} | tail -40

  local dep="$ROOT/deployments/${CHAIN_ID}.json"
  [ -f "$dep" ] || { echo "!! 部署檔沒有產生：${dep}"; exit 1; }

  echo
  echo ">> 更新 $(basename "$ENV_FILE")"
  env_set RPC_URL "$RPC_URL"
  env_set CHAIN_ID "$CHAIN_ID"
  if [ -n "${CAFECA_KEYRING:-}" ]; then env_set CAFECA_KEYRING "$CAFECA_KEYRING"; fi
  echo "   RPC_URL / CHAIN_ID 已寫入"

  # 換了一次部署，web/data/ 裡的紀錄屬於舊合約（網站會回 503「紀錄屬於另一次部署」）。
  if [ "$redeploy" = 1 ]; then
    echo ">> 舊部署的 web/data/ 搬到 data.bak-<時間>"
    ( cd "$ROOT/web" && node scripts/data-reset.mjs ) | sed 's/^/   /'
  fi

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
  check_roles "$dep" || echo "!! 角色不對：網站的簽章會被合約拒絕。見上面標 ✗ 的那幾行。"
  echo
  echo ">> 還要做的事："
  echo "   1. web/.env.local 的 SITE_ORIGIN 要與瀏覽器網址列逐字相同（含 scheme 與 port）"
  echo "   2. 登入一次，把 /account 上的地址填進 ADMIN_ADDRESSES，然後重啟"
  echo "   3. 每小時提交一期承諾：bash script/demo-box.sh commit-loop（或排程每小時跑 cd web && npm run ledger:commit）"
  echo "   4. 營運／主權角色的事件（費率等）在後台建立提案，持有人用 npm run ledger:authority -- sign <id> --key-env <變數> 簽署"
  echo "      持有人金鑰在 ${GOV_FILE}，**不要**搬進 web/.env.local"
}

# ── 角色檢查 ───────────────────────────────────────────────────────
#
# 對照 web/.env.local 的每一把服務金鑰，確認鏈上真的授給了它。
# 部署「成功」不代表接得起來：角色授錯人，合約照樣部署完，錯誤要到第一筆使用者操作才出現。
check_roles () {
  local dep=$1
  command -v python3 >/dev/null 2>&1 || { echo "   （沒有 python3，略過角色檢查）"; return 0; }
  local lv; lv=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('ledgerVersion',0))" "$dep")
  [ "$lv" = "3" ] || { echo "!! $(basename "$dep") 不是目前版本的帳本部署（需要 ledgerVersion 3，script/DeployLedger.s.sol）"; return 1; }
  check_ledger_roles "$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['ledger'])" "$dep")"
}

# 帳本版：授權清單是 Ledger.isAuthority(keccak256(角色名), 地址)，門檻是 thresholdOf。
# 網站自己能簽的只有高頻角色；主權／營運只核對「持有人都在清單上、門檻與 Safe 相同」。
check_ledger_roles () {
  local L=$1 ok=0
  auth_has () { cast call --rpc-url "$RPC_URL" "$L" "isAuthority(bytes32,address)(bool)" "$(cast keccak "$1")" "$2" 2>/dev/null; }
  thr () { local t; t=$(cast call --rpc-url "$RPC_URL" "$L" "thresholdOf(bytes32)(uint8)" "$(cast keccak "$1")" 2>/dev/null); [ "${t:-0}" = 0 ] && echo 1 || echo "$t"; }
  one () { # 標籤 角色 地址
    if [ "$(auth_has "$2" "$3")" = "true" ]; then printf '   ✓ %-30s %-10s %s\n' "$1" "$(thr "$2")-of-n" "$3"
    else printf '   ✗ %-30s %s 不在 %s 清單上\n' "$1" "$3" "$2"; ok=1; fi
  }
  echo ">> 帳本授權清單（Ledger.isAuthority 對照 web/.env.local 的金鑰）"
  one "身分事件"           IDENTITY_VERIFIER "$(addr_of "$(env_get IDENTITY_VERIFIER_PK)")"
  one "核發事件"           CARBON_VERIFIER   "$(addr_of "$(env_get CARBON_VERIFIER_PK)")"
  one "憑證文件雜湊"       DOCUMENT_SIGNER   "$(addr_of "$(env_get DOCUMENT_SIGNER_PK)")"
  one "收單回執"           RECEIPT_SIGNER    "$(addr_of "$(env_get RELAYER_PK)")"
  local relayer; relayer=$(addr_of "$(env_get RELAYER_PK)")
  local crole; crole=$(cast call --rpc-url "$RPC_URL" "$L" "COMMITTER_ROLE()(bytes32)" 2>/dev/null)
  if [ "$(cast call --rpc-url "$RPC_URL" "$L" "hasRole(bytes32,address)(bool)" "$crole" "$relayer" 2>/dev/null)" = "true" ]; then
    printf '   ✓ %-30s %-10s %s\n' "承諾上鏈（ledger:commit）" "" "$relayer"
  else printf '   ✗ %-30s %s 沒有 COMMITTER_ROLE\n' "承諾上鏈（ledger:commit）" "$relayer"; ok=1; fi
  # 多簽角色：列出門檻，並核對治理持有人都在清單上
  local r who
  for r in SOVEREIGN OPERATOR AUDITOR; do printf '   · %-30s 門檻 %s\n' "${r} 角色" "$(thr "$r")"; done
  # gov_owner_lists 在沒有治理金鑰時會 exit；先在子 shell 試一次，免得檢查把整支腳本帶走
  if ( gov_owner_lists >/dev/null 2>&1 ); then
    gov_owner_lists
    for who in ${NATIONAL_OWNERS//,/ }; do [ "$(auth_has SOVEREIGN "$who")" = "true" ] || { printf '   ✗ 國家 Safe 持有人 %s 不在 SOVEREIGN 清單上\n' "$who"; ok=1; }; done
    for who in ${OPERATOR_OWNERS//,/ }; do [ "$(auth_has OPERATOR "$who")" = "true" ] || { printf '   ✗ 營運 Safe 持有人 %s 不在 OPERATOR 清單上\n' "$who"; ok=1; }; done
    [ "$ok" = 0 ] && echo "   ✓ 國家／營運 Safe 的持有人都在 SOVEREIGN／OPERATOR 清單上（網站不持有這些金鑰，事件走提案）"
  fi
  return $ok
}

# ── status ─────────────────────────────────────────────────────────
cmd_status () {
  need_chain
  echo "鏈       ${RPC_URL}（chainId ${CHAIN_ID}）"
  local dep="$ROOT/deployments/${CHAIN_ID}.json"
  [ -f "$dep" ] && echo "部署檔   deployments/${CHAIN_ID}.json" || echo "部署檔   ⚠️ 還沒部署到這條鏈"
  echo
  cmd_fund || true
  if [ -f "$dep" ]; then echo; check_roles "$dep" || true; fi
}

case "${1:-all}" in
  keys)   cmd_keys;;
  fund)   cmd_fund;;
  deploy) cmd_deploy;;
  status) cmd_status;;
  roles)  need_chain; check_roles "$ROOT/deployments/${CHAIN_ID}.json";;
  all)    cmd_keys; echo; cmd_fund && { echo; cmd_deploy; };;
  *)      sed -n '2,30p' "$0"; exit 1;;
esac
