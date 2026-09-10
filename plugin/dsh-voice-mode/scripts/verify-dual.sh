#!/usr/bin/env bash
# 一键多版本全量验证（全部脚本化、可复现），默认覆盖支持区间两端（0.1.1 与 0.1.5）：
#   1) 锚点存在性检查（check-anchors.mjs，两端 + 可按需加中间线）
#   2) 双版本 typecheck（typecheck-dual.sh，两端各跑 host/client tsc）
#   3) runtime 冒烟 0.1.1（smoke-runtime.sh：boot + host 三端点 + client mic/console）
#   4) runtime 冒烟 0.1.5（同上）
#
# 用法：bash scripts/verify-dual.sh [0.1.1核心bin.js] [0.1.5核心bin.js]
#   默认 0.1.1 用 /tmp/dsh011-core/...；0.1.5 用全局安装（随本机 dsh 演进）。
#   中间线核心（如 0.1.2-rc.1）备于 /tmp/dsh012-core（由 0.1.2 回滚 tar 解出），可显式传参验证：
#     bash scripts/verify-dual.sh /tmp/dsh011-core/... /tmp/dsh012-core/@deepseek-ai/dsh/lib/bin.js
#   核心获取（smoke 前置）：`NODE_OPTIONS=--max-old-space-size=4096 pnpm add @deepseek-ai/dsh@<版本>`
set -euo pipefail
cd "$(dirname "$0")/.."

CORE_011="${1:-/tmp/dsh011-core/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_015="${2:-/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js}"

echo "======== 1/4 锚点检查（0.1.1 + 0.1.5）========"
node scripts/check-anchors.mjs 0.1.1-rc.2 0.1.5-rc.1

echo "======== 2/4 双版本 typecheck ========"
bash scripts/typecheck-dual.sh 0.1.1-rc.2 0.1.5-rc.1

echo "======== 3/4 runtime 冒烟 0.1.1 ========"
bash scripts/smoke-runtime.sh "$CORE_011" 3135

echo "======== 4/4 runtime 冒烟 0.1.5 ========"
bash scripts/smoke-runtime.sh "$CORE_015" 3136

echo ""
echo "✓✓✓ 全量验证通过：锚点 + 双版本 typecheck + 双版本 runtime 冒烟（host + client mic/console）"
