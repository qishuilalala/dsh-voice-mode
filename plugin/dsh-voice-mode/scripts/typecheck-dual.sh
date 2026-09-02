#!/usr/bin/env bash
# 双版本 typecheck（防回归 I-1）。
# 对 0.1.1-rc.2 与 0.1.2-alpha.4 两套 @deepseek-ai 类型各跑一遍 tsc，确保 voice-mode
# 源码在旧版与新版的类型面上都能通过——防止未来改动误用某版本独有 API 而静默破坏兼容。
#
# 用法：bash scripts/typecheck-dual.sh [版本线...]
#   默认检查 0.1.1-rc.2 0.1.2-alpha.4
#
# 原理：client.tsx/settings-form.tsx 不 import dsh-client 类型（走 ctx 运行时服务），
# 仅 host 侧 index.ts 依赖 5 个类型包（cordis + dsh-host-webserver/llm/settings/system-prompt）。
# 本脚本临时把 devDependencies 切到目标版本线，跑 tsc，最后恢复。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  VERSIONS=(0.1.1-rc.2 0.1.2-alpha.4)
else
  VERSIONS=("$@")
fi

# 版本线 → cordis 版本（0.1.1 用 4.0.1，0.1.2 用 4.0.2；未知默认 4.0.1）
cordis_ver_for() {
  case "$1" in
    0.1.2-alpha.*) echo 4.0.2 ;;
    *) echo 4.0.1 ;;
  esac
}

DEVPKGS=(dsh-host-webserver dsh-llm dsh-settings dsh-system-prompt)

cp package.json package.json.dual-bak
restore() {
  mv package.json.dual-bak package.json
  pnpm install --no-frozen-lockfile >/dev/null 2>&1 || true
}
trap restore EXIT

overall=0
for v in "${VERSIONS[@]}"; do
  cordis_ver="$(cordis_ver_for "$v")"
  echo "======================================================"
  echo "=== typecheck against @deepseek-ai/dsh-* @ $v (cordis $cordis_ver) ==="
  echo "======================================================"

  # 一次 add 齐 5 个类型包（pnpm add 会写 package.json + lockfile，退出时 restore 兜底）
  args=()
  for p in "${DEVPKGS[@]}"; do args+=("@deepseek-ai/$p@$v"); done
  args+=("@deepseek-ai/cordis@$cordis_ver")
  pnpm add -D "${args[@]}" >/dev/null 2>&1 || {
    echo "✗ pnpm add 失败 @ $v"; overall=1; continue
  }

  echo "--- host tsconfig.json ---"
  node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit && echo "  ✓ host ok" || { echo "  ✗ host FAIL"; overall=1; }

  echo "--- client tsconfig.client.json ---"
  node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit && echo "  ✓ client ok" || { echo "  ✗ client FAIL"; overall=1; }
done

if [ "$overall" -ne 0 ]; then
  echo "✗ 双版本 typecheck 有失败项"
  exit 1
fi
echo "✓ 双版本 typecheck 全部通过"
