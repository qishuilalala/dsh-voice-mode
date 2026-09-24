#!/usr/bin/env bash
# 双版本 typecheck（防回归 I-1）。
# 对 0.1.1-rc.2 与 0.1.5-rc.1 两套 @deepseek-ai 类型各跑一遍 tsc，确保 voice-mode
# 源码在旧版与新版的类型面上都能通过——防止未来改动误用某版本独有 API 而静默破坏兼容。
#
# 用法：bash scripts/typecheck-dual.sh [版本线...]
#   默认检查 0.1.1-rc.2 0.1.5-rc.1（支持区间两端；中间线如 0.1.2-rc.1 可显式传入）
#
# 原理：client.tsx/settings-form.tsx 不 import dsh-client 类型（走 ctx 运行时服务），
# 仅 host 侧 index.ts 依赖 5 个类型包（cordis + dsh-host-webserver/llm/settings/system-prompt）。
# 本脚本临时把 devDependencies 切到目标版本线，跑 tsc，最后恢复。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -eq 0 ]; then
  VERSIONS=(0.1.1-rc.2 0.1.5-rc.1)
else
  VERSIONS=("$@")
fi

# 版本线 → cordis 版本
#   依据：dsh-host-webserver peerDependencies（npm view 实证）：
#     - 0.1.1-rc.2 → ^4.0.1
#     - 0.1.2-rc.1 / 0.1.3-* / 0.1.5-* / 0.1.6-* 起的 0.1.5+ 子包 → ^4.0.2
#     - 0.1.7-alpha.1 → ^4.0.3；0.1.7-alpha.2 → ~4.0.4（已发布最高 4.0.4，2026-09-23 实证）
#   未知版本不再静默回退 4.0.1：原实现在 dsh 上新版本线时，会用错 cordis 类型面
#   静默通过 typecheck，违背仓库兼容纪律。改为：未列入映射表时显式报错，
#   让维护者核对 `npm view @deepseek-ai/dsh-host-webserver@<v> peerDependencies` 后补表。
cordis_ver_for() {
  case "$1" in
    0.1.0-*|0.1.1-*) echo 4.0.1 ;;
    0.0.1-*) echo 4.0.1-rc.4 ;;
    0.1.2-*|0.1.3-*|0.1.4-*|0.1.5-*|0.1.6-*) echo 4.0.2 ;;
    0.1.7-*) echo 4.0.4 ;;
    *)
      echo "✗ cordis_ver_for: 未列出 dsh 版本线 '$1' 的 cordis 映射" >&2
      echo "  请核对 \`npm view @deepseek-ai/dsh-host-webserver@$1 peerDependencies\` 并在 cordis_ver_for() 里补表。" >&2
      return 1
      ;;
  esac
}

DEVPKGS=(dsh-host-webserver dsh-llm dsh-settings dsh-system-prompt)

cp package.json package.json.dual-bak
cp pnpm-lock.yaml pnpm-lock.yaml.dual-bak
restore() {
  mv package.json.dual-bak package.json
  mv pnpm-lock.yaml.dual-bak pnpm-lock.yaml
  pnpm install --no-frozen-lockfile >/dev/null 2>&1 || true
}
trap restore EXIT

overall=0
for v in "${VERSIONS[@]}"; do
  # cordis_ver_for 失败 → 未知版本线：trap 会还原 package.json/pnpm-lock.yaml，
  # 直接整体退出（不要 continue 把后面的版本线当成"已通过"跑了，掩盖缺陷）
  cordis_ver="$(cordis_ver_for "$v")" || exit 1
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
