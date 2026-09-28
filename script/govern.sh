#!/usr/bin/env bash
# CO2Exchange 治理操作工具（cast 包裝）。所有命令只讀鏈上狀態或送出「已簽好的」Safe 交易；私鑰只在簽章步驟用到。
#
#   RPC_URL      預設 http://127.0.0.1:28545
#   DEPLOYMENT   預設 deployments/<chainId>.json
#   SENDER_PK    送出 execTransaction 的付 gas 帳戶（任何有餘額的帳戶皆可，不需是 owner）
#
# 用法：
#   govern.sh status
#   govern.sh build <preset> [args…]                       → 印出 TARGET DATA
#   govern.sh timelock (schedule|execute|id|state) <target> <data> <salt>
#   govern.sh safe (national|operator) hash <target> <data>
#   govern.sh safe (national|operator) exec <target> <data> <addr:sig> [<addr:sig>…]
#   govern.sh sign <hash> --private-key <pk> | --ledger | --trezor
#
# 帳本合約的治理（設計 v4）：
#   國家 Safe（SOVEREIGN_ROLE）：授權金鑰清單與門檻——即時生效，重播以事件所在的區塊為起點
#   營運 Safe（OPERATOR_ROLE）：一般提領的開關、承諾提交者（COMMITTER_ROLE）
#   Timelock（DEFAULT_ADMIN_ROLE，國家 Safe 提案與執行）：主權與營運角色本身的更換
#
#   govern.sh build grant-authority <角色> <地址>   角色：SOVEREIGN OPERATOR IDENTITY_VERIFIER CARBON_VERIFIER DOCUMENT_SIGNER AUDITOR RECEIPT_SIGNER
#   govern.sh build revoke-authority <角色> <地址>
#   govern.sh build threshold <角色> <k>
#   govern.sh build withdrawals <true|false>
#   govern.sh build committer-grant|committer-revoke <地址>
#   govern.sh build grant-role|revoke-role <sovereign|operator|admin> <地址>   → 交給 timelock schedule/execute
#   govern.sh build safe-add-owner|safe-remove-owner|safe-swap-owner|safe-threshold|safe-owners …
#
# ⚠️ Safe 持有人異動時，帳本的 SOVEREIGN／OPERATOR 授權清單要跟著改（grant/revoke-authority），
#    否則新持有人簽不了帳本事件、舊持有人仍然簽得了。
#
# 典型流程（撤銷一把查驗機構金鑰）：
#   read T D < <(govern.sh build revoke-authority CARBON_VERIFIER 0xABC…)
#   H=$(govern.sh safe national hash $T $D)        # 給每位簽章者
#   S1=$(govern.sh sign $H --private-key …)         # 各自簽，回傳 65-byte 簽章
#   govern.sh safe national exec $T $D 0xOwner1:$S1 0xOwner2:$S2
set -euo pipefail

RPC_URL=${RPC_URL:-http://127.0.0.1:28545}
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
DEPLOYMENT=${DEPLOYMENT:-"$(dirname "$0")/../deployments/${CHAIN_ID}.json"}
[ -f "$DEPLOYMENT" ] || { echo "找不到部署檔 $DEPLOYMENT" >&2; exit 1; }
addr() { jq -r ".$1" "$DEPLOYMENT"; }

LEDGER=$(addr ledger)
NATIONAL=$(addr nationalSafe); OPERATOR=$(addr operatorSafe); TIMELOCK=$(addr timelock)
[ "$(jq -r '.ledgerVersion' "$DEPLOYMENT")" = "2" ] || { echo "$DEPLOYMENT 不是帳本部署（script/DeployLedger.s.sol）" >&2; exit 1; }
ROLE_ADMIN=0x0000000000000000000000000000000000000000000000000000000000000000
ROLE_SOV=$(cast keccak "SOVEREIGN_ROLE"); ROLE_OP=$(cast keccak "OPERATOR_ROLE"); ROLE_COMMITTER=$(cast keccak "COMMITTER_ROLE")
ROLE_PROPOSER=$(cast keccak "PROPOSER_ROLE"); ROLE_EXECUTOR=$(cast keccak "EXECUTOR_ROLE"); ROLE_CANCELLER=$(cast keccak "CANCELLER_ROLE")
ZERO_B32=0x0000000000000000000000000000000000000000000000000000000000000000
AUTH_ROLES="SOVEREIGN OPERATOR IDENTITY_VERIFIER CARBON_VERIFIER DOCUMENT_SIGNER AUDITOR RECEIPT_SIGNER"

call() { cast call --rpc-url "$RPC_URL" "$@"; }
auth_role() {
  case " $AUTH_ROLES " in *" $1 "*) cast keccak "$1";; *) echo "未知的帳本角色 $1（$AUTH_ROLES）" >&2; exit 1;; esac
}

# ───────────────────────── build：預設操作 → TARGET DATA ─────────────────────────
cmd_build() {
  local p=$1; shift
  case "$p" in
    # 國家 Safe
    grant-authority)   echo "$LEDGER $(cast calldata 'grantAuthority(bytes32,address)' "$(auth_role "$1")" "$2")";;
    revoke-authority)  echo "$LEDGER $(cast calldata 'revokeAuthority(bytes32,address)' "$(auth_role "$1")" "$2")";;
    threshold)         echo "$LEDGER $(cast calldata 'setThreshold(bytes32,uint8)' "$(auth_role "$1")" "$2")";;
    # 營運 Safe
    withdrawals)       echo "$LEDGER $(cast calldata 'setWithdrawalsEnabled(bool)' "$1")";;
    committer-grant)   echo "$LEDGER $(cast calldata 'grantRole(bytes32,address)' "$ROLE_COMMITTER" "$1")";;
    committer-revoke)  echo "$LEDGER $(cast calldata 'revokeRole(bytes32,address)' "$ROLE_COMMITTER" "$1")";;
    # Timelock（主權與營運角色本身）
    grant-role)        echo "$LEDGER $(cast calldata 'grantRole(bytes32,address)' "$(role_by_name "$1")" "$2")";;
    revoke-role)       echo "$LEDGER $(cast calldata 'revokeRole(bytes32,address)' "$(role_by_name "$1")" "$2")";;
    # Safe 自身的 owner 管理（目標 = 該 Safe，由該 Safe 自己簽章執行）
    safe-add-owner)    echo "$(safe_addr "$1") $(cast calldata 'addOwnerWithThreshold(address,uint256)' "$2" "$3")";;
    safe-remove-owner) echo "$(safe_addr "$1") $(cast calldata 'removeOwner(address,address,uint256)' "$(prev_owner "$1" "$2")" "$2" "$3")";;
    safe-swap-owner)   echo "$(safe_addr "$1") $(cast calldata 'swapOwner(address,address,address)' "$(prev_owner "$1" "$2")" "$2" "$3")";;
    safe-threshold)    echo "$(safe_addr "$1") $(cast calldata 'changeThreshold(uint256)' "$2")";;
    safe-owners)       call "$(safe_addr "$1")" 'getOwners()(address[])'; echo "threshold=$(call "$(safe_addr "$1")" 'getThreshold()(uint256)')";;
    *) echo "未知 preset：$p" >&2; exit 1;;
  esac
}
role_by_name() {
  case "$1" in
    admin) echo "$ROLE_ADMIN";; sovereign) echo "$ROLE_SOV";; operator) echo "$ROLE_OP";; committer) echo "$ROLE_COMMITTER";;
    proposer) echo "$ROLE_PROPOSER";; executor) echo "$ROLE_EXECUTOR";; canceller) echo "$ROLE_CANCELLER";;
    *) echo "未知角色 $1" >&2; exit 1;;
  esac
}

# ───────────────────────── timelock ─────────────────────────
cmd_timelock() {
  local sub=$1 target=$2 data=$3 salt=${4:-}
  case "$sub" in
    schedule) local delay; delay=$(call "$TIMELOCK" 'getMinDelay()(uint256)' | awk '{print $1}')
              echo "$TIMELOCK $(cast calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$target" 0 "$data" $ZERO_B32 "$salt" "$delay")";;
    execute)  echo "$TIMELOCK $(cast calldata 'execute(address,uint256,bytes,bytes32,bytes32)' "$target" 0 "$data" $ZERO_B32 "$salt")";;
    id)       call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$target" 0 "$data" $ZERO_B32 "$salt";;
    cancel)   local id; id=$(call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$target" 0 "$data" $ZERO_B32 "$salt")
              echo "$TIMELOCK $(cast calldata 'cancel(bytes32)' "$id")";;
    state)    local id; id=$(call "$TIMELOCK" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$target" 0 "$data" $ZERO_B32 "$salt")
              local st ts; st=$(call "$TIMELOCK" 'getOperationState(bytes32)(uint8)' "$id"); ts=$(call "$TIMELOCK" 'getTimestamp(bytes32)(uint256)' "$id" | awk '{print $1}')
              local names=(Unset Waiting Ready Done)
              echo "id=$id state=${names[$st]} readyAt=$ts ($( [ "$ts" -gt 1 ] && date -u -d @"$ts" 2>/dev/null || echo -))";;
    *) echo "timelock 子命令：schedule|execute|id|cancel|state" >&2; exit 1;;
  esac
}

# ───────────────────────── safe ─────────────────────────
# Safe 的 owners 是單向鏈結串列；removeOwner / swapOwner 需要前一個 owner（第一個的前者是哨兵 0x1）
prev_owner() {
  local safe; safe=$(safe_addr "$1"); local target; target=$(echo "$2" | tr 'A-F' 'a-f')
  local prev=0x0000000000000000000000000000000000000001
  for o in $(call "$safe" 'getOwners()(address[])' | tr -d '[],' ); do
    if [ "$(echo "$o" | tr 'A-F' 'a-f')" = "$target" ]; then echo "$prev"; return; fi
    prev=$o
  done
  echo "$2 不是 owner" >&2; exit 1
}
safe_addr() { case "$1" in national) echo "$NATIONAL";; operator) echo "$OPERATOR";; 0x*) echo "$1";; *) echo "safe：national|operator|<地址>" >&2; exit 1;; esac; }
cmd_safe() {
  local safe; safe=$(safe_addr "$1"); local sub=$2 target=$3 data=$4; shift 4
  local nonce; nonce=$(call "$safe" 'nonce()(uint256)' | awk '{print $1}')
  local Z=0x0000000000000000000000000000000000000000
  case "$sub" in
    hash)
      call "$safe" 'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
        "$target" 0 "$data" 0 0 0 0 $Z $Z "$nonce";;
    exec)
      # 參數 <owner地址:簽章>…；Safe 要求依 owner 地址升冪排列
      local sigs; sigs=$(for p in "$@"; do echo "${p%%:*} ${p##*:}"; done | awk '{print tolower($1), $2}' | sort | awk '{printf "%s", substr($2,3)}')
      cast send --rpc-url "$RPC_URL" --private-key "${SENDER_PK:?需要 SENDER_PK（付 gas 的帳戶）}" "$safe" \
        'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
        "$target" 0 "$data" 0 0 0 0 $Z $Z "0x$sigs" | grep -E "^status|^transactionHash";;
    *) echo "safe 子命令：hash|exec" >&2; exit 1;;
  esac
}

# ───────────────────────── sign ─────────────────────────
cmd_sign() { local hash=$1; shift; cast wallet sign --no-hash "$hash" "$@"; }

# ───────────────────────── status ─────────────────────────
has() { call "$1" 'hasRole(bytes32,address)(bool)' "$2" "$3"; }

cmd_status() {
  echo "chainId=$CHAIN_ID  ledger=$LEDGER"
  echo "nationalSafe=$NATIONAL ($(call "$NATIONAL" 'getThreshold()(uint256)')-of-$(call "$NATIONAL" 'getOwners()(address[])' | tr ',' '\n' | wc -l | tr -d ' '))  operatorSafe=$OPERATOR  timelock=$TIMELOCK (delay $(call "$TIMELOCK" 'getMinDelay()(uint256)' | awk '{print $1}')s)"
  echo "roles  admin=timelock:$(has $LEDGER $ROLE_ADMIN $TIMELOCK)  sovereign=national:$(has $LEDGER $ROLE_SOV $NATIONAL)  operator=operator:$(has $LEDGER $ROLE_OP $OPERATOR)"
  local r t
  printf "thresholds "
  for r in SOVEREIGN OPERATOR AUDITOR; do t=$(call "$LEDGER" 'thresholdOf(bytes32)(uint8)' "$(cast keccak $r)"); printf " %s=%s" "$r" "${t:-0}"; done
  echo
  echo "withdrawalsEnabled=$(call "$LEDGER" 'withdrawalsEnabled()(bool)')  epoch=$(call "$LEDGER" 'epoch()(uint64)')  escapeActive=$(call "$LEDGER" 'escapeActive()(bool)')"
  echo "timelock proposer=national:$(has $TIMELOCK $ROLE_PROPOSER $NATIONAL) executor=national:$(has $TIMELOCK $ROLE_EXECUTOR $NATIONAL) canceller=national:$(has $TIMELOCK $ROLE_CANCELLER $NATIONAL)"
  echo "（授權金鑰清單的完整歷史：cd web && npm run ledger:authority -- list，或後台治理頁）"
}

case "${1:-}" in
  status) cmd_status;;
  build) shift; cmd_build "$@";;
  timelock) shift; cmd_timelock "$@";;
  safe) shift; cmd_safe "$@";;
  sign) shift; cmd_sign "$@";;
  addresses) cat "$DEPLOYMENT";;
  *) sed -n '2,30p' "$0"; exit 1;;
esac
