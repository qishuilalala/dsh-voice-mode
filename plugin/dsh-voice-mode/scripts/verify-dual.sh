#!/usr/bin/env bash
# 一键多版本全量验证（全部脚本化、可复现），默认覆盖支持区间两端 + 最新预览通道：
#   1) 锚点存在性检查（check-anchors.mjs，5 版：0.1.1 / 0.1.2 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.6-alpha.2）
#   2) 五版本 typecheck（typecheck-dual.sh，各跑 host/client tsc）
#   3) runtime 冒烟 0.1.1（smoke-runtime.sh：boot + host 三端点 + client mic/console）
#   4) runtime 冒烟 0.1.5-rc.2（同上，本机 dsh 服务的核心）
#   5) runtime 冒烟 0.1.6-alpha.2（同上，最新 alpha 通道隔离核心）
#
# 用法：bash scripts/verify-dual.sh [0.1.1核心bin.js] [0.1.5核心bin.js] [0.1.6核心bin.js]
#   默认 0.1.1 用 /tmp/dsh011-core/...；0.1.5 用全局安装（随本机 dsh 演进）；
#   0.1.6-alpha.2 用 /tmp/dsh016a2-core/...
#   中间线核心（如 0.1.2-rc.1）备于 /tmp/dsh012-core（由 0.1.2 回滚 tar 解出）；
#   0.1.5-rc.2 核心备于 /tmp/dsh015-rc2-core（升级预检时新建）。
#   可显式传参验证：
#     bash scripts/verify-dual.sh /tmp/dsh011-core/... /tmp/dsh012-core/@deepseek-ai/dsh/lib/bin.js /tmp/dsh016a2-core/node_modules/@deepseek-ai/dsh/lib/bin.js
#   核心获取（smoke 前置）：`NODE_OPTIONS=--max-old-space-size=4096 pnpm add @deepseek-ai/dsh@<版本>`
set -euo pipefail
cd "$(dirname "$0")/.."

CORE_011="${1:-/tmp/dsh011-core/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_015="${2:-/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_016="${3:-/tmp/dsh016a2-core/node_modules/@deepseek-ai/dsh/lib/bin.js}"

echo "======== 1/5 锚点检查（0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.6-alpha.2）========"
node scripts/check-anchors.mjs 0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.6-alpha.2

echo "======== 2/5 五版本 typecheck ========"
bash scripts/typecheck-dual.sh 0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.6-alpha.2

echo "======== 3/5 runtime 冒烟 0.1.1 ========"
bash scripts/smoke-runtime.sh "$CORE_011" 3135

echo "======== 4/5 runtime 冒烟 0.1.5 ========"
bash scripts/smoke-runtime.sh "$CORE_015" 3136

echo "======== 5/5 runtime 冒烟 0.1.6-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_016" 3137

echo ""
echo "✓✓✓ 全量验证通过：5 版锚点 + 5 版 typecheck + 3 核心 runtime 冒烟（host + client mic/console）"
echo "提示：集成回归（create→toggle→prompt→SSE 音频帧）需在全局线上 dsh 上跑——"
echo "      bash test/spoken-prompt-rpc.sh  # 默认 BASE=http://127.0.0.1:3018"
