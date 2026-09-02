#!/usr/bin/env bash
# runtime 冒烟（防回归 I-3）：在隔离 DSH_HOME 上 boot 指定 dsh 核心 + voice-mode，
# 验证 host 端点（/voice-mode、/voice-mode/config、/voice-mode/models/status）。
#
# 用法：bash scripts/smoke-runtime.sh <dsh-core-bin.js> [port]
#   dsh-core-bin.js：目标 dsh 的 lib/bin.js 绝对路径（0.1.1 与 0.1.2 各自准备一份）。
#   port：默认 3120（避免与线上 3018 冲突）。
#
# 边界：本脚本只做「host 冒烟」（纯 curl，无需浏览器）。客户端渲染（mic 按钮 + console 0 error）
# 需 headless 浏览器，由 Playwright 另行验证（见 docs/compat-contract.md §5）——
# alpha 下 client bundle 走合并 URL `/plugins/??<全部包>/client.js&rev=..` 且需 cookie，curl 无法可靠探测。
set -euo pipefail

BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PORT="${2:-3120}"
[ -f "$BIN" ] || { echo "✗ dsh 核心不存在: $BIN"; exit 2; }

WORK=$(mktemp -d /tmp/dsh-smoke-XXXXXX)
DSH_HOME="$WORK/home"
BOOTLOG="$WORK/boot.log"
NODE_PID=""

cleanup() {
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== 初始化隔离 profile（DSH_HOME=$DSH_HOME）=="
mkdir -p "$DSH_HOME/profiles/web"
cat > "$DSH_HOME/profiles/web/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-voice-mode": "link:$PWD" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-voice-mode"] } }
}
EOF
echo '[]' > "$DSH_HOME/profiles/web/cordis.patch.yml"
(cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile >/dev/null 2>&1) || {
  echo "✗ profile pnpm install 失败"; exit 1
}

echo "== boot dsh 核心（port $PORT）=="
DSH_HOME="$DSH_HOME" node "$BIN" web --port "$PORT" --host 127.0.0.1 --no-open >"$BOOTLOG" 2>&1 &
NODE_PID=$!

# 等 URL（最多 60s）
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE "http://127\.0\.0\.1:$PORT[^ ]*" "$BOOTLOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "✗ dsh 启动即退出"; tail -20 "$BOOTLOG"; exit 1
  fi
  sleep 1
done
[ -z "$URL" ] && { echo "✗ 60s 内未等到 URL"; tail -20 "$BOOTLOG"; exit 1; }
echo "   boot 成功: $URL"

fail=0
ORIGIN="http://127.0.0.1:$PORT"
check() {  # name, url, expect_substr
  local body code
  body=$(curl -s -H "Origin:$ORIGIN" "$2" 2>/dev/null)
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Origin:$ORIGIN" "$2" 2>/dev/null)
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q "$3"; then
    echo "   ✓ $1 ($code)"
  else
    echo "   ✗ $1 (code=$code, body=$(printf '%s' "$body" | head -c 120))"
    fail=1
  fi
}

BASE="http://127.0.0.1:$PORT"
check "/voice-mode"           "$BASE/voice-mode"            '"ok":true'
check "/voice-mode/config"    "$BASE/voice-mode/config"     'ttsEngine'
check "/voice-mode/models/status" "$BASE/voice-mode/models/status" 'asr'

[ "$fail" -eq 0 ] && echo "✓ host 冒烟通过（dsh 核心: $BIN）；client 渲染请用 Playwright 验证 mic 按钮 + console 0 error" || { echo "✗ host 冒烟有失败项"; exit 1; }
