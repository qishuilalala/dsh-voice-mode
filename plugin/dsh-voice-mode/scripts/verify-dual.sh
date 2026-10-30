#!/usr/bin/env bash
# 一键多版本全量验证（全部脚本化、可复现），默认覆盖支持区间两端 + 最新预览通道：
#   1) 锚点存在性检查（check-anchors.mjs，21 版：0.1.1 / 0.1.2 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.1 / 0.1.7-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-alpha.2 / 0.2.1-alpha.3 / 0.2.1-alpha.5 / 0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.1-rc.4 / 0.2.1-rc.5 / 0.2.2-alpha.2）
#   2) 二十一版本 typecheck（typecheck-dual.sh，各跑 host/client tsc）
#   3) runtime 冒烟 0.1.1（smoke-runtime.sh：boot + host 三端点 + client mic/console）
#   4) runtime 冒烟 0.1.5-rc.2（同上，本机 dsh 服务的核心）
#   5) runtime 冒烟 0.1.6-alpha.2（同上，alpha 通道隔离核心）
#   6) runtime 冒烟 0.1.5-rc.3（同上）
#   7) runtime 冒烟 0.1.7-alpha.2（同上，alpha 通道隔离核心）
#   8) runtime 冒烟 0.1.7-rc.1（同上，next 通道隔离核心）
#   9) runtime 冒烟 0.1.7-rc.2（同上）
#   10) runtime 冒烟 0.2.0-rc.1（同上）
#   11) runtime 冒烟 0.2.0-rc.2（同上，npm latest 通道隔离核心）
#   12) runtime 冒烟 0.2.1-alpha.1（同上，npm alpha 通道隔离核心）
#   13) runtime 冒烟 0.2.1-alpha.2（同上）
#   14) runtime 冒烟 0.2.1-alpha.3（同上）
#   15) runtime 冒烟 0.2.1-alpha.5（同上，npm alpha 通道隔离核心）
#   16) runtime 冒烟 0.2.1-rc.2（同上，npm next 通道隔离核心）
#   17) runtime 冒烟 0.2.1-rc.3（同上，npm next 通道隔离核心；2026-10-26 复核）
#   18) runtime 冒烟 0.2.1-rc.4（同上，npm next 通道隔离核心；2026-10-28 复核）
#   19) runtime 冒烟 0.2.2-alpha.2（同上，npm alpha 通道隔离核心；2026-10-28 复核）
#   20) runtime 冒烟 0.2.1-rc.5（同上，latest/next 通道；2026-10-30 复核）
#
# 用法：bash scripts/verify-dual.sh [0.1.1核心bin.js] [0.1.5核心bin.js] [0.1.6核心bin.js] [0.1.5-rc.3核心bin.js] [0.1.7核心bin.js] [0.1.7-rc.1核心bin.js] [0.1.7-rc.2核心bin.js] [0.2.0-rc.1核心bin.js] [0.2.0-rc.2核心bin.js] [0.2.1-alpha.1核心bin.js] [0.2.1-alpha.2核心bin.js] [0.2.1-alpha.3核心bin.js] [0.2.1-alpha.5核心bin.js] [0.2.1-rc.2核心bin.js] [0.2.1-rc.3核心bin.js]
#   默认 0.1.1 用 /tmp/dshcore/dsh-0-1-1-rc-2/...；0.1.5 用固定版本隔离核心（不随本机 dsh 演进）；
#   其余隔离核心用 /tmp/dshcore/dsh-<ver>/...
#   隔离核心获取：`bash scripts/ensure-core.sh <ver>`（自动选 pnpm/npm，见 TEST-SYSTEM.md）
#   （旧路径 /tmp/dsh011-core、/tmp/dsh012-core、/tmp/dsh015-core、/tmp/dsh015-rc2-core、
#   /tmp/dsh016a2-core 已退役，统一收敛到 /tmp/dshcore/dsh-<ver> 布局，见 compat-contract §11.4）
#   可显式传参验证（位置参数依次覆盖 9 个默认核心）。
set -euo pipefail
cd "$(dirname "$0")/.."

CORE_011="${1:-/tmp/dshcore/dsh-0-1-1-rc-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_015="${2:-/tmp/dshcore/dsh-0-1-5-rc-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_016="${3:-/tmp/dshcore/dsh-0-1-6-alpha-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_015R3="${4:-/tmp/dshcore/dsh-0-1-5-rc-3/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_017="${5:-/tmp/dshcore/dsh-0-1-7-alpha-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_017RC1="${6:-/tmp/dshcore/dsh-0-1-7-rc-1/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_017RC2="${7:-/tmp/dshcore/dsh-0-1-7-rc-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_020RC1="${8:-/tmp/dshcore/dsh-0-2-0-rc-1/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_020RC2="${9:-/tmp/dshcore/dsh-0-2-0-rc-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021A1="${10:-/tmp/dshcore/dsh-0-2-1-alpha-1/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021A2="${11:-/tmp/dshcore/dsh-0-2-1-alpha-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021A3="${12:-/tmp/dshcore/dsh-0-2-1-alpha-3/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021A5="${13:-/tmp/dshcore/dsh-0-2-1-alpha-5/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021RC2="${14:-/tmp/dshcore/dsh-0-2-1-rc-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021RC3="${15:-/tmp/dshcore/dsh-0-2-1-rc-3/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021RC4="${16:-/tmp/dshcore/dsh-0-2-1-rc-4/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_021RC5="${18:-/tmp/dshcore/dsh-0-2-1-rc-5/node_modules/@deepseek-ai/dsh/lib/bin.js}"
CORE_022A2="${17:-/tmp/dshcore/dsh-0-2-2-alpha-2/node_modules/@deepseek-ai/dsh/lib/bin.js}"

echo "======== 1/20 锚点检查（0.1.1-rc.2 / 0.1.2-rc.1 / 0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-alpha.1 / 0.1.7-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-alpha.2 / 0.2.1-alpha.3 / 0.2.1-alpha.5 / 0.2.1-rc.2 / 0.2.1-rc.3 / 0.2.1-rc.4 / 0.2.1-rc.5 / 0.2.2-alpha.2）========"
# 注意：版本号必须写字面量（check-dsh-version.sh 用 awk 从本文件提取字面版本做覆盖比对，变量会被漏掉）。
node scripts/check-anchors.mjs 0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.5-rc.3 0.1.6-alpha.2 0.1.7-alpha.1 0.1.7-alpha.2 0.1.7-rc.1 0.1.7-rc.2 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.1 0.2.1-alpha.2 0.2.1-alpha.3 0.2.1-alpha.5 0.2.1-rc.2 0.2.1-rc.3 0.2.1-rc.4 0.2.1-rc.5 0.2.2-alpha.2

echo "======== 2/20 二十一版本 typecheck ========"
bash scripts/typecheck-dual.sh 0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.5-rc.3 0.1.6-alpha.2 0.1.7-alpha.1 0.1.7-alpha.2 0.1.7-rc.1 0.1.7-rc.2 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.1 0.2.1-alpha.2 0.2.1-alpha.3 0.2.1-alpha.5 0.2.1-rc.2 0.2.1-rc.3 0.2.1-rc.4 0.2.1-rc.5 0.2.2-alpha.2

echo "======== 3/20 runtime 冒烟 0.1.1 ========"
DSH_TEST_SKIP_HMR_WATCH=1 bash scripts/smoke-runtime.sh "$CORE_011" 3135   # 0.1.1 核心需 HMR 跳过夹具（ensure-core.sh 自动打）

echo "======== 4/20 runtime 冒烟 0.1.5 ========"
bash scripts/smoke-runtime.sh "$CORE_015" 3136

echo "======== 5/20 runtime 冒烟 0.1.6-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_016" 3137

echo "======== 6/20 runtime 冒烟 0.1.5-rc.3 ========"
bash scripts/smoke-runtime.sh "$CORE_015R3" 3138

echo "======== 7/20 runtime 冒烟 0.1.7-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_017" 3139

echo "======== 8/20 runtime 冒烟 0.1.7-rc.1 ========"
bash scripts/smoke-runtime.sh "$CORE_017RC1" 3140

echo "======== 9/20 runtime 冒烟 0.1.7-rc.2 ========"
bash scripts/smoke-runtime.sh "$CORE_017RC2" 3141

echo "======== 10/20 runtime 冒烟 0.2.0-rc.1 ========"
bash scripts/smoke-runtime.sh "$CORE_020RC1" 3142

echo "======== 11/20 runtime 冒烟 0.2.0-rc.2 ========"
bash scripts/smoke-runtime.sh "$CORE_020RC2" 3143

echo "======== 12/20 runtime 冒烟 0.2.1-alpha.1 ========"
bash scripts/smoke-runtime.sh "$CORE_021A1" 3144

echo "======== 13/20 runtime 冒烟 0.2.1-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_021A2" 3145

echo "======== 14/20 runtime 冒烟 0.2.1-alpha.3 ========"
bash scripts/smoke-runtime.sh "$CORE_021A3" 3146

echo "======== 15/20 runtime 冒烟 0.2.1-alpha.5 ========"
bash scripts/smoke-runtime.sh "$CORE_021A5" 3147

echo "======== 16/20 runtime 冒烟 0.2.1-rc.2 ========"
bash scripts/smoke-runtime.sh "$CORE_021RC2" 3148

echo "======== 17/20 runtime 冒烟 0.2.1-rc.3 ========"
bash scripts/smoke-runtime.sh "$CORE_021RC3" 3149

echo "======== 18/20 runtime 冒烟 0.2.1-rc.4 ========"
bash scripts/smoke-runtime.sh "$CORE_021RC4" 3150

echo "======== 19/20 runtime 冒烟 0.2.2-alpha.2 ========"
bash scripts/smoke-runtime.sh "$CORE_022A2" 3151

echo "======== 20/20 runtime 冒烟 0.2.1-rc.5 ========"
bash scripts/smoke-runtime.sh "$CORE_021RC5" 3152

echo ""
echo "✓✓✓ 全量验证通过：21 版锚点 + 21 版 typecheck + 18 核心 runtime 冒烟（host + client mic/console）"
echo "提示：真流程回归（create→toggle→prompt→SSE 音频帧 + 真 LLM）在各隔离核心上跑——"
echo "      bash scripts/full-e2e.sh /tmp/dshcore/dsh-<ver>/node_modules/@deepseek-ai/dsh/lib/bin.js <port>"
