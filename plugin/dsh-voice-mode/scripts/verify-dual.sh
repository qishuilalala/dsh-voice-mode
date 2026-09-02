#!/usr/bin/env bash
# 一键双版本全量验证（全部脚本化、可复现）：
#   1) 锚点存在性检查（check-anchors.mjs，0.1.1 + 0.1.2）
#   2) 双版本 typecheck（typecheck-dual.sh，0.1.1 + 0.1.2 各跑 host/client tsc）
#   3) runtime 冒烟 0.1.1（smoke-runtime.sh：boot + host 三端点 + client mic/console）
#   4) runtime 冒烟 0.1.2（同上）
#
# 用法：bash scripts/verify-dual.sh [0.1.1核心bin.js] [0.1.2核心bin.js]
#   默认 0.1.1 用 /tmp/dsh011-core/...；0.1.2 用全局 /www/server/nodejs/.../dsh/lib/bin.js。
#   核心获取（smoke 前置）：0.1.1 用 `NODE_OPTIONS=--max-old-space-size=4096 pnpm add @deepseek-ai/dsh@0.1.1-rc.2`。
set -euo pipefail
cd "$(dirname "$0")/.."

CORE_011="${1:-/tmp/dsh011-core/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_012="${2:-/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js}"

echo "======== 1/4 锚点检查（0.1.1 + 0.1.2）========"
node scripts/check-anchors.mjs 0.1.1-rc.2 0.1.2-alpha.4

echo "======== 2/4 双版本 typecheck ========"
bash scripts/typecheck-dual.sh 0.1.1-rc.2 0.1.2-alpha.4

echo "======== 3/4 runtime 冒烟 0.1.1 ========"
bash scripts/smoke-runtime.sh "$CORE_011" 3135

echo "======== 4/4 runtime 冒烟 0.1.2 ========"
bash scripts/smoke-runtime.sh "$CORE_012" 3136

echo ""
echo "✓✓✓ 全量验证通过：锚点 + 双版本 typecheck + 双版本 runtime 冒烟（host + client mic/console）"
