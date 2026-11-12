#!/usr/bin/env bash
# 多版本验证：支持区间两端 + 每条小版本线最新已验证版 + 当前 latest/next，去重。
# 默认 9 版锚点、9 版 host/client typecheck、8 个核心 runtime（host + client）。
# 固定已补验的版本快照，不在运行时把未验证的 dist-tag 自动纳入支持承诺。
# 用法（插件目录）：
#   bash scripts/verify-dual.sh                    # 收敛集
#   bash scripts/verify-dual.sh --full             # 历史全集：24 版 / 21 核心
#   bash scripts/verify-dual.sh 0.1.5-rc.2 [...]    # 显式版本，含历史版本；重复项去重
#   bash scripts/verify-dual.sh --list [--full]    # 只列版本，供 CI / 巡检读取
# 核心预先用 bash scripts/ensure-core.sh <版本> 准备；默认在 /tmp/dshcore。
# DSHVM_CORE_ROOT 可覆盖隔离核心根目录，子目录仍为 dsh-<版本中点换横线>。
# 旧的核心路径位置参数改为版本号；单核心自定义路径用 smoke-runtime.sh <bin.js> <port>。
# DSHVM_SMOKE_PORT 可指定起始端口（默认 3135），各核心串行运行、端口依次递增。
# 每版验证深度不变：历史仅做锚点/类型的 0.1.2-rc.1、0.1.5-rc.1、0.1.7-alpha.1
# 不冒充有 runtime 结果；其它版本调用原 smoke-runtime.sh，保留全部 host/client 检查。
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULT_VERSIONS=(0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.3 0.1.6-alpha.2 0.1.7-rc.2 0.2.0-rc.2 0.2.1-rc.5 0.2.2-rc.1 0.2.2-rc.2)
FULL_VERSIONS=(0.1.1-rc.2 0.1.2-rc.1 0.1.5-rc.1 0.1.5-rc.2 0.1.5-rc.3 0.1.6-alpha.2 0.1.7-alpha.1 0.1.7-alpha.2 0.1.7-rc.1 0.1.7-rc.2 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.1 0.2.1-alpha.2 0.2.1-alpha.3 0.2.1-alpha.5 0.2.1-rc.2 0.2.1-rc.3 0.2.1-rc.4 0.2.1-rc.5 0.2.2-alpha.2 0.2.2-alpha.3 0.2.2-rc.1 0.2.2-rc.2)

full=0
list=0
VERSIONS=()
for arg in "$@"; do
  case "$arg" in
    --full) full=1 ;;
    --list) list=1 ;;
    [0-9]*.[0-9]*.[0-9]*) VERSIONS+=("$arg") ;;
    *) echo "未知参数: ${arg}（使用 --full、--list 或版本号）" >&2; exit 2 ;;
  esac
done
if [ "$full" -eq 1 ]; then
  [ "${#VERSIONS[@]}" -eq 0 ] || { echo '--full 不能与显式版本混用' >&2; exit 2; }
  VERSIONS=("${FULL_VERSIONS[@]}")
elif [ "${#VERSIONS[@]}" -eq 0 ]; then
  VERSIONS=("${DEFAULT_VERSIONS[@]}")
fi
# bash 3.2 兼容，不依赖关联数组；--list 和实际执行使用同一个去重结果。
UNIQUE=()
for v in "${VERSIONS[@]}"; do
  case " ${UNIQUE[*]:-} " in *" $v "*) ;; *) UNIQUE+=("$v") ;; esac
done
VERSIONS=("${UNIQUE[@]}")
if [ "$list" -eq 1 ]; then
  printf '%s\n' "${VERSIONS[@]}"
  exit 0
fi

echo "======== 锚点检查（${#VERSIONS[@]} 版）========"
node scripts/check-anchors.mjs "${VERSIONS[@]}"
echo "======== host/client typecheck（${#VERSIONS[@]} 版）========"
bash scripts/typecheck-dual.sh "${VERSIONS[@]}"

cores=0
port="${DSHVM_SMOKE_PORT:-3135}"
for v in "${VERSIONS[@]}"; do
  case "$v" in
    0.1.2-rc.1|0.1.5-rc.1|0.1.7-alpha.1)
      echo "历史验证边界：$v 仅锚点/typecheck，runtime 未纳入本台架"
      continue ;;
  esac
  core="${DSHVM_CORE_ROOT:-/tmp/dshcore}/dsh-${v//./-}/node_modules/@deepseek-ai/dsh/lib/bin.js"
  echo "======== runtime 冒烟 $v ========"
  if [ "$v" = 0.1.1-rc.2 ]; then
    DSH_TEST_SKIP_HMR_WATCH=1 bash scripts/smoke-runtime.sh "$core" "$port"
  else
    bash scripts/smoke-runtime.sh "$core" "$port"
  fi
  cores=$((cores + 1))
  port=$((port + 1))
done

echo "✓ 验证通过：${#VERSIONS[@]} 版锚点 + ${#VERSIONS[@]} 版双 typecheck + $cores 核心 runtime"
echo '真 LLM 流程另用 bash scripts/full-e2e.sh <隔离核心bin.js> <port> 验证。'
