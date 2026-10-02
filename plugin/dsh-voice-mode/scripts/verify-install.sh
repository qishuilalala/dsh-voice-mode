#!/usr/bin/env bash
# 发布前必跑：把打包产物当「别人」一样全新安装，防止 `link:` 方式测不到的安装期缺陷
# （2026-10-02 教训：msedge-tts 带 `preinstall: npx only-allow pnpm`，pnpm 11 报 ERR_PNPM_IGNORED_BUILDS、
#  npm 被 only-allow 拒绝——发布包无法安装，而本仓库工作区的 allowBuilds 把它掩盖了）。
#
# 用法：bash scripts/verify-install.sh
# 步骤：npm pack → 在空目录里分别用 pnpm（默认严格 build 脚本策略）与 npm 安装该 tgz → 断言：
#   1) 安装退出码 0；2) 运行时依赖里没有 msedge-tts（应已内联）；3) 入口模块 import 成功；4) locale/icon/许可文件随包。
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dshvm-install-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
REG="${REGISTRY:-https://registry.npmjs.org/}"

npm pack --pack-destination "$WORK" --ignore-scripts >/dev/null 2>&1 || npm pack --pack-destination "$WORK" >/dev/null
TGZ="$(ls "$WORK"/dsh-voice-mode-*.tgz | head -1)"
echo "== 打包产物：$(basename "$TGZ")"

check() { # <目录> <安装器名>
  local d="$1" name="$2"
  [ -e "$d/node_modules/msedge-tts" ] && { echo "✗ [$name] 运行时依赖里仍有 msedge-tts（应已内联）"; return 1; }
  for f in lib/index.js lib/msedge-tts.cjs lib/client.js locale/en.json locale/zh.json icon.svg THIRD_PARTY_NOTICES.md; do
    [ -f "$d/node_modules/dsh-voice-mode/$f" ] || { echo "✗ [$name] 包内缺 $f"; return 1; }
  done
  # 入口模块必须能加载；并显式加载内联的 CJS 并取到 MsEdgeTTS（第三方依赖已全部内联，无需额外安装）
  (cd "$d" && node -e "require('./node_modules/dsh-voice-mode/lib/msedge-tts.cjs').MsEdgeTTS || process.exit(4)" && node -e "import('dsh-voice-mode').then(m => { if (!m.apply || !m.Config) process.exit(3) }).catch(e => { console.error(e.message); process.exit(2) })") \
    || { echo "✗ [$name] import('dsh-voice-mode') 失败"; return 1; }
  echo "✓ [$name] 安装 + 入口加载 + 随包文件 OK"
}

fail=0
echo "== pnpm（严格 build 脚本策略，最贴近 dsh 插件管理器）"
mkdir -p "$WORK/pnpm" && (cd "$WORK/pnpm" && echo '{"name":"t","private":true}' > package.json && pnpm add "$TGZ" --registry "$REG" >"$WORK/pnpm.log" 2>&1) \
  && check "$WORK/pnpm" pnpm || { echo "✗ [pnpm] 安装失败："; tail -8 "$WORK/pnpm.log" 2>/dev/null; fail=1; }
echo "== npm"
mkdir -p "$WORK/npm" && (cd "$WORK/npm" && echo '{"name":"t","private":true}' > package.json && npm install "$TGZ" --registry "$REG" --no-audit --no-fund >"$WORK/npm.log" 2>&1) \
  && check "$WORK/npm" npm || { echo "✗ [npm] 安装失败："; tail -8 "$WORK/npm.log" 2>/dev/null; fail=1; }
[ "$fail" -eq 0 ] && echo "✓✓ 全新安装验证通过（pnpm + npm）" || { echo "✗✗ 全新安装验证失败"; exit 1; }
