#!/usr/bin/env bash
# 一键多版本全量验证（全部脚本化、可复现），默认覆盖支持区间两端 + 最新预览通道：
#   1) 锚点存在性检查（check-anchors.mjs，9 版：0.1.1 / 0.1.2 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.1 / 0.1.7-alpha.2 / 0.1.7-rc.1）
#   2) 九版本 typecheck（typecheck-dual.sh，各跑 host/client tsc）
#   3) runtime 冒烟 0.1.1（smoke-runtime.sh：boot + host 三端点 + client mic/console）
#   4) runtime 冒烟 0.1.5-rc.2（同上，本机 dsh 服务的核心）
#   5) runtime 冒烟 0.1.6-alpha.2（同上，alpha 通道隔离核心）
#   6) runtime 冒烟 0.1.5-rc.3（同上）
#   7) runtime 冒烟 0.1.7-alpha.2（同上，alpha 通道隔离核心）
#   8) runtime 冒烟 0.1.7-rc.1（同上，最新 next 通道隔离核心）
#
# 用法：bash scripts/verify-dual.sh [0.1.1核心bin.js] [0.1.5核心bin.js] [0.1.6核心bin.js] [0.1.5-rc.3核心bin.js] [0.1.7核心bin.js] [0.1.7-rc.1核心bin.js]
#   默认 0.1.1 用 /tmp/dshcore/dsh-0-1-1-rc-2/...；0.1.5 用全局安装（随本机 dsh 演进）；
#   0.1.6-alpha.2 / 0.1.5-rc.3 / 0.1.7-alpha.2 / 0.1.7-rc.1 用 /tmp/dshcore/dsh-<ver>/...
#   隔离核心获取：`bash scripts/ensure-core.sh <ver>`（自动选 pnpm/npm，见 TEST-SYSTEM.md）
#   （旧路径 /tmp/dsh011-core、/tmp/dsh012-core、/tmp/dsh015-core、/tmp/dsh015-rc2-core、
#   /tmp/dsh016a2-core 已退役，统一收敛到 /tmp/dshcore/dsh-<ver> 布局，见 compat-contract §11.4）
#   可显式传参验证（位置参数依次覆盖 6 个默认核心）。
set -euo pipefail
cd "$(dirname "$0")/.."

CORE_011="${1:-/tmp/dshcore/dsh-0-1-1-rc-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_015="${2:-/www/server/nodejs/v22.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_016="${3:-/tmp/dshcore/dsh-0-1-6-alpha-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_015R3="${4:-/tmp/dshcore/dsh-0-1-5-rc-3/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_017="${5:-/tmp/dshcore/dsh-0-1-7-alpha-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_017RC1="${6:-/tmp/dshcore/dsh-0-1-7-rc-1/node_modules/@deepseek-ai/dsh/lib/bin.js}"

echo "======== 1/8 锚点检查（0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.1 / 0.1.7-alpha.2 / 0.1.7-rc.1）========"
# 注意：版本号必须写字面量（check-dsh-version.sh 用 awk 从本文件提取字面版本做覆盖比对，变量会被漏掉）。
node scripts/check-anchors.mjs 0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.5-rc.3 0.1.6-alpha.2 0.1.7-alpha.1 0.1.7-alpha.2 0.1.7-rc.1

echo "======== 2/8 九版本 typecheck ========"
bash scripts/typecheck-dual.sh 0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.5-rc.3 0.1.6-alpha.2 0.1.7-alpha.1 0.1.7-alpha.2 0.1.7-rc.1

echo "======== 3/8 runtime 冒烟 0.1.1 ========"
bash scripts/smoke-runtime.sh "$CORE_011" 3135

echo "======== 4/8 runtime 冒烟 0.1.5 ========"
bash scripts/smoke-runtime.sh "$CORE_015" 3136

echo "======== 5/8 runtime 冒烟 0.1.6-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_016" 3137

echo "======== 6/8 runtime 冒烟 0.1.5-rc.3 ========"
bash scripts/smoke-runtime.sh "$CORE_015R3" 3138

echo "======== 7/8 runtime 冒烟 0.1.7-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_017" 3139

echo "======== 8/8 runtime 冒烟 0.1.7-rc.1 ========"
bash scripts/smoke-runtime.sh "$CORE_017RC1" 3140

echo ""
echo "✓✓✓ 全量验证通过：9 版锚点 + 9 版 typecheck + 6 核心 runtime 冒烟（host + client mic/console）"
echo "提示：真流程回归（create→toggle→prompt→SSE 音频帧 + 真 LLM）在各隔离核心上跑——"
echo "      bash scripts/full-e2e.sh /tmp/dshcore/dsh-<ver>/node_modules/@deepseek-ai/dsh/lib/bin.js <port>"
