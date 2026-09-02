#!/usr/bin/env bash
# runtime 冒烟（防回归 I-3）：在隔离 DSH_HOME 上 boot 指定 dsh 核心 + voice-mode，
# 验证 host 端点（/voice-mode、/voice-mode/config、/voice-mode/models/status），
# 并在 playwright-core 可用时用 headless chromium 验证客户端 mic 按钮 + console 0 error。
#
# 用法：bash scripts/smoke-runtime.sh <dsh-core-bin.js> [port]
#   dsh-core-bin.js：目标 dsh 的 lib/bin.js 绝对路径（0.1.1 与 0.1.2 各自准备一份）。
#   port：默认 3120（避免与线上 3018 冲突）。
set -euo pipefail

BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PORT="${2:-3120}"
[ -f "$BIN" ] || { echo "✗ dsh 核心不存在: $BIN"; exit 2; }

# 链接路径必须是原生格式：Git Bash/MSYS 下 $PWD 是 /c/... 形式，pnpm 在 Windows 上
# 解析不了，会静默装不上，最终 boot 报 "cannot resolve profile bundle"。cygpath -m
# 输出 C:/... 混合格式，Windows 与 POSIX 侧都能用。
LINK_SRC="$PWD"
if command -v cygpath >/dev/null 2>&1; then LINK_SRC="$(cygpath -m "$PWD")"; fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dsh-smoke-XXXXXX")
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
  "dependencies": { "dsh-voice-mode": "link:$LINK_SRC" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-voice-mode"] } }
}
EOF
echo '[]' > "$DSH_HOME/profiles/web/cordis.patch.yml"

# 预置 settings：跳过首次引导弹窗。比在 UI 上按文本点按钮可靠得多——界面语言跟随浏览器，
# 文本匹配天然脆弱（实测中文环境下英文正则全不命中，引导关不掉）。
# smoke-client 里的点击逻辑保留为兜底（本键名若在未来版本改变，仍能走 UI 关）。
cat > "$DSH_HOME/settings.yaml" <<'YAML'
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
permission:
  defaultPreset: danger-full-access
YAML

# 预置一个工作区：mic 按钮所在的输入区要选定工作区后才渲染，而「选择工作区」走的是
# 系统目录选择器，headless 里点不了。直接写 storages/workspace.json 绕过整个交互。
mkdir -p "$DSH_HOME/storages" "$WORK/ws"
WS_DIR="$WORK/ws"
if command -v cygpath >/dev/null 2>&1; then WS_DIR="$(cygpath -m "$WORK/ws")"; fi  # -m 出正斜杠，JSON 无需转义，Windows 也接受
WS_ID="00000000-0000-4000-8000-00000000smoke"
WS_ID="${WS_ID:0:36}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$DSH_HOME/storages/workspace.json" <<EOF
{
  "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "workspaceIds": ["$WS_ID"], "archivedSessionIds": [] },
  "tables": {
    "workspaces": {
      "$WS_ID": {
        "path": "$WS_DIR",
        "title": "smoke",
        "sessionIds": [],
        "createdAt": "$NOW",
        "updatedAt": "$NOW"
      }
    }
  }
}
EOF
(cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile >"$WORK/pnpm.log" 2>&1) || {
  echo "✗ profile pnpm install 失败"; tail -20 "$WORK/pnpm.log"; exit 1
}
# 装完立即校验链接真的建起来了——pnpm 对无法解析的 link 会静默跳过（退出码仍为 0），
# 不校验的话要到 boot 阶段才以 "cannot resolve profile bundle" 暴露，排障成本高。
if [ ! -e "$DSH_HOME/profiles/web/node_modules/dsh-voice-mode/package.json" ]; then
  echo "✗ dsh-voice-mode 未链接进隔离 profile（link:$LINK_SRC 解析失败）"
  tail -20 "$WORK/pnpm.log"; exit 1
fi

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

# 客户端冒烟（mic 按钮 + console 0 error）：需要 playwright-core + chromium
if node -e "require.resolve('playwright-core')" >/dev/null 2>&1; then
  echo "== 客户端冒烟（headless chromium）=="
  if node scripts/smoke-client.mjs "$URL"; then
    : # 通过
  else
    fail=1
  fi
else
  echo "   （跳过客户端冒烟：playwright-core 未安装）"
fi

[ "$fail" -eq 0 ] && echo "✓ runtime 冒烟通过（host + client，dsh 核心: $BIN）" || { echo "✗ runtime 冒烟有失败项"; exit 1; }
