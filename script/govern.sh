#!/usr/bin/env bash
# CO2Exchange 治理操作工具（cast 包裝）。所有命令只讀鏈上狀態或送出「已簽好的」Safe 交易；私鑰只在簽章步驟用到。
#
#   RPC_URL      預設 http://127.0.0.1:8545
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
# 典型流程（緊急凍結）：
#   read T D < <(govern.sh build freeze 0xABC… true)
#   H=$(govern.sh safe national hash $T $D)        # 給每位簽章者
#   S1=$(govern.sh sign $H --private-key …)         # 各自簽，回傳 65-byte 簽章
#   govern.sh safe national exec $T $D 0xOwner1:$S1 0xOwner2:$S2
set -euo pipefail

RPC_URL=${RPC_URL:-http://127.0.0.1:8545}
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
DEPLOYMENT=${DEPLOYMENT:-"$(dirname "$0")/../deployments/${CHAIN_ID}.json"}
[ -f "$DEPLOYMENT" ] || { echo "找不到部署檔 $DEPLOYMENT" >&2; exit 1; }
addr() { jq -r ".$1" "$DEPLOYMENT"; }

KYC=$(addr kycRegistry); CREDIT=$(addr carbonCredit1155); REGISTRY=$(addr carbonRegistry); CERT=$(addr retirementCertificate)
LISTING=$(addr listing); POOL=$(addr carbonPool); CCT=$(addr cct); HOOK=$(addr hook); ROUTER=$(addr router); PM=$(addr poolManager)
NATIONAL=$(addr nationalSafe); OPERATOR=$(addr operatorSafe); TIMELOCK=$(addr timelock)
ROLE_ADMIN=0x0000000000000000000000000000000000000000000000000000000000000000
ROLE_SOV=$(cast keccak "SOVEREIGN_ROLE"); ROLE_OP=$(cast keccak "OPERATOR_ROLE")
ROLE_IDV=$(cast keccak "IDENTITY_VERIFIER_ROLE"); ROLE_VERIFIER=$(cast keccak "VERIFIER_ROLE")
ROLE_PROPOSER=$(cast keccak "PROPOSER_ROLE"); ROLE_EXECUTOR=$(cast keccak "EXECUTOR_ROLE"); ROLE_CANCELLER=$(cast keccak "CANCELLER_ROLE")
ZERO_B32=0x0000000000000000000000000000000000000000000000000000000000000000

call() { cast call --rpc-url "$RPC_URL" "$@"; }
contract_by_name() {
  case "$1" in
    kyc) echo "$KYC";; credit) echo "$CREDIT";; registry) echo "$REGISTRY";; cert) echo "$CERT";;
    listing) echo "$LISTING";; pool) echo "$POOL";; cct) echo "$CCT";; hook) echo "$HOOK";; timelock) echo "$TIMELOCK";;
    *) echo "未知合約名稱 $1（kyc|credit|registry|cert|listing|pool|cct|hook|timelock）" >&2; exit 1;;
  esac
}

# ───────────────────────── build：預設操作 → TARGET DATA ─────────────────────────
cmd_build() {
  local p=$1; shift
  case "$p" in
    freeze)            echo "$KYC $(cast calldata 'setFrozen(address,bool)' "$1" "$2")";;
    freeze-batch)      echo "$CREDIT $(cast calldata 'setBatchFrozen(uint256,bool)' "$1" "$2")";;
    pause)             echo "$(contract_by_name "$1") $(cast calldata 'pause()')";;
    unpause)           echo "$(contract_by_name "$1") $(cast calldata 'unpause()')";;
    kill-swaps)        echo "$HOOK $(cast calldata 'setTrustedRouter(address)' 0x0000000000000000000000000000000000000000)";;
    restore-swaps)     echo "$HOOK $(cast calldata 'setTrustedRouter(address)' "$ROUTER")";;
    grant-role)        echo "$(contract_by_name "$1") $(cast calldata 'grantRole(bytes32,address)' "$(role_by_name "$2")" "$3")";;
    revoke-role)       echo "$(contract_by_name "$1") $(cast calldata 'revokeRole(bytes32,address)' "$(role_by_name "$2")" "$3")";;
    approve-verifier)  echo "$REGISTRY $(cast calldata 'approveVerifier(address)' "$1")";;
    revoke-verifier)   echo "$REGISTRY $(cast calldata 'revokeVerifier(address)' "$1")";;
    set-project-active) echo "$REGISTRY $(cast calldata 'setProjectActive(uint256,bool)' "$1" "$2")";;
    individual-transfer) echo "$KYC $(cast calldata 'setIndividualTransferEnabled(bool)' "$1")";;
    set-fee)           echo "$(contract_by_name "$1") $(cast calldata 'setFee(uint256,address)' "$2" "$3")";;
    upgrade)           echo "$(contract_by_name "$1") $(cast calldata 'upgradeToAndCall(address,bytes)' "$2" 0x)";;
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
    admin) echo "$ROLE_ADMIN";; sovereign) echo "$ROLE_SOV";; operator) echo "$ROLE_OP";;
    identity-verifier) echo "$ROLE_IDV";; verifier) echo "$ROLE_VERIFIER";;
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
  echo "chainId=$CHAIN_ID  nationalSafe=$NATIONAL ($(call "$NATIONAL" 'getThreshold()(uint256)')-of-$(call "$NATIONAL" 'getOwners()(address[])' | tr ',' '\n' | wc -l))  operatorSafe=$OPERATOR  timelock=$TIMELOCK (delay $(call "$TIMELOCK" 'getMinDelay()(uint256)' | awk '{print $1}')s)"
  printf "%-10s %-14s %-14s %-14s\n" contract admin=timelock sov=national op=operator
  for c in kyc cert listing pool hook; do a=$(contract_by_name $c); printf "%-10s %-14s %-14s %-14s\n" $c "$(has $a $ROLE_ADMIN $TIMELOCK)" "$(has $a $ROLE_SOV $NATIONAL)" "$(has $a $ROLE_OP $OPERATOR)"; done
  for c in credit registry; do a=$(contract_by_name $c); printf "%-10s %-14s %-14s %-14s\n" $c "$(has $a $ROLE_ADMIN $TIMELOCK)" "$(has $a $ROLE_SOV $NATIONAL)" -; done
  printf "%-10s %-14s\n" cct "$(has $CCT $ROLE_ADMIN $TIMELOCK)"
  echo "poolManager.owner=$(call "$PM" 'owner()(address)')  listing.paused=$(call "$LISTING" 'paused()(bool)')  pool.paused=$(call "$POOL" 'paused()(bool)')  hook.trustedRouter=$(call "$HOOK" 'trustedRouter()(address)')"
  echo "timelock proposer=national:$(has $TIMELOCK $ROLE_PROPOSER $NATIONAL) executor=national:$(has $TIMELOCK $ROLE_EXECUTOR $NATIONAL) canceller=national:$(has $TIMELOCK $ROLE_CANCELLER $NATIONAL)"
}

case "${1:-}" in
  status) cmd_status;;
  build) shift; cmd_build "$@";;
  timelock) shift; cmd_timelock "$@";;
  safe) shift; cmd_safe "$@";;
  sign) shift; cmd_sign "$@";;
  addresses) cat "$DEPLOYMENT";;
  *) sed -n '2,20p' "$0"; exit 1;;
esac
