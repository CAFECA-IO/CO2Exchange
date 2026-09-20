#!/usr/bin/env bash
# 一次把環境弄好：裝 Foundry、把依賴釘到指定 commit、編譯、跑測試。
#
# 兩種情況都適用：
#   從 GitHub clone 下來    → 依賴已經記在 .gitmodules 裡，只要 submodule update
#   從空資料夾長出來        → 沒有 .gitmodules，逐一 submodule add 並釘死版本
#
# 用法：cd <repo> && bash setup.sh
set -euo pipefail

if ! command -v forge >/dev/null 2>&1; then
  echo ">> 安裝 Foundry"
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
fi

if [ ! -d .git ]; then
  echo ">> git init"
  git init -b main
fi

# clone 下來的情況：依賴的 commit 已經記在 superproject 裡，照著取出來就好，
# 不要再 submodule add 一次——那會把已經釘好的版本蓋掉。
if [ -f .gitmodules ] && git config -f .gitmodules --get-regexp '^submodule\..*\.url$' >/dev/null 2>&1; then
  echo ">> 取出依賴（已釘死於 .gitmodules）"
  git submodule update --init --recursive
  echo ">> forge build"
  forge build
  echo ">> forge test"
  forge test
  echo ">> 完成。接下來：anvil --prune-history，見 README「營運手冊 › 啟動」。"
  exit 0
fi

pin_dep () { # path url rev — 釘死到指定 commit，並把該 commit 記進 superproject index
  if [ ! -e "$1/.git" ]; then
    echo ">> 加入 $1"
    git submodule add -f "$2" "$1" >/dev/null
  fi
  echo ">> 釘 $1 @ $3"
  git -C "$1" fetch -q origin "$3"
  git -C "$1" checkout -q "$3"
  git add "$1"
}
pin_dep lib/forge-std                          https://github.com/foundry-rs/forge-std                          bf647bd6046f2f7da30d0c2bf435e5c76a780c1b   # v1.16.2
pin_dep lib/v4-core                            https://github.com/Uniswap/v4-core                               e50237c43811bd9b526eff40f26772152a42daba   # v4.0.0
pin_dep lib/openzeppelin-contracts             https://github.com/OpenZeppelin/openzeppelin-contracts             69c8def5f222ff96f2b5beff05dfba996368aa79   # v5.1.0
pin_dep lib/openzeppelin-contracts-upgradeable https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable fa525310e45f91eb20a6d3baa2644be8e0adba31   # v5.1.0
pin_dep lib/safe-smart-account                 https://github.com/safe-global/safe-smart-account                  bf943f80fec5ac647159d26161446ac5d716a294   # v1.4.1
# v4-core 自己的巢狀依賴（solmate / forge-std）；只在子模組內執行，不會把 v4-core 重設回 main
git -C lib/v4-core submodule update --init --recursive

echo ">> forge build"
forge build
echo ">> forge test"
forge test
echo ">> 完成。接下來：anvil --prune-history，見 README「營運手冊 › 啟動」。"
