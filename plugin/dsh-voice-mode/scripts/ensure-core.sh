#!/usr/bin/env bash
# dsh 隔离核心获取（版本感知的安装器选择）
#
# 背景：旧版本 dsh 的 loader 要求 npm 式扁平 node_modules；pnpm 隔离布局
# （.pnpm 虚拟存储）下其插件名解析失败（0.1.3-alpha.2 实证：包在 store 内存在
# 且已链接，但 loader 报 could not be resolved；裸 profile 对照同样死亡；
# 同一版本改用 npm install 后 boot 成功 200 + 真流程 PASS）。
# 新版本（0.1.5+）两种布局均可，默认 pnpm（快、省空间）。
#
# 用法：bash scripts/ensure-core.sh <dsh版本> [目标目录]
#   例：bash scripts/ensure-core.sh 0.1.7-alpha.2
#       bash scripts/ensure-core.sh 0.1.1-rc.2 /tmp/dshcore-npm/dsh-0-1-1-rc-2
# 输出：成功时打印 bin.js 绝对路径（可直接喂给 full-e2e.sh / smoke-runtime.sh）。
# 退出码：0=就绪（已存在则直接复用，不重装）；1=安装失败。
set -euo pipefail

VER="${1:?usage: $0 <dsh版本> [目标目录]}"
SAFE="${VER//./-}"
DEFAULT_BASE="/tmp/dshcore"

# 安装器选择表（证据驱动，新增旧版本时按实证追加；R22 修正）：
#   npm-flat（仅此一例）：0.1.3-alpha.2——pnpm 树 loader 解析失败，npm 扁平树 boot 成功（R10/R11 实证）。
#   pnpm + HMR-skip fixture 补丁：0.1.1-*、0.1.0-*（R15/R17 实证 PASS；补丁打在该树
#     profile-boot-*.js，DSH_TEST_SKIP_HMR_WATCH=1 生效；先 stat 查 inode 是否与他树共享）。
#   npm-flat：0.0.1-*（rc.5 实证；pnpm 树死于自身 subprocess-local 解析）。
#   pnpm：其余（0.1.2+、0.1.5+、0.1.6+、0.1.7+ 均已实证可用）。
# 注意：npm 装旧树极慢（10 分钟零进展常见）且后台易死；能走 pnpm 的一律走 pnpm。
case "$VER" in
  0.1.3-*|0.0.1-*)
    INSTALLER="npm"
    BASE="/tmp/dshcore-npm"
    ;;
  *)
    INSTALLER="pnpm"
    BASE="$DEFAULT_BASE"
    ;;
esac

DIR="${2:-$BASE/dsh-$SAFE}"
BIN="$DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"

if [ -f "$BIN" ]; then
  INSTALLED_VER=$(node -e "console.log(require('$DIR/node_modules/@deepseek-ai/dsh/package.json').version)" 2>/dev/null || echo "?")
  if [ "$INSTALLED_VER" = "$VER" ]; then
    echo "$BIN"
    exit 0
  fi
  echo "(!) $DIR 存在但版本为 $INSTALLED_VER（要 $VER），重建..." >&2
  rm -rf "$DIR"
fi

mkdir -p "$DIR"
if [ "$INSTALLER" = "npm" ]; then
  (cd "$DIR" && npm init -y >/dev/null 2>&1 && \
    NODE_OPTIONS=--max-old-space-size=4096 npm install "@deepseek-ai/dsh@$VER" --no-audit --no-fund) || {
    echo "✗ npm 安装失败 @ $VER"; exit 1
  }
else
  (cd "$DIR" && pnpm init -y >/dev/null 2>&1 && \
    NODE_OPTIONS=--max-old-space-size=4096 pnpm add "@deepseek-ai/dsh@$VER") || {
    echo "✗ pnpm 安装失败 @ $VER"; exit 1
  }
fi

[ -f "$BIN" ] || { echo "✗ 安装后仍找不到 $BIN"; exit 1; }
echo "$BIN"
