#!/usr/bin/env bash
# dsh-voice-mode 真流程端到端（全版本兼容验证用）
# 在隔离 DSH_HOME 上 boot 指定 dsh 核心 + link 工作区 dsh-voice-mode，配置 deepseek-official
# provider（env 注入 DEEPSEEK_API_KEY，**值不落盘/不落文档**），依次验证：
#   1) host 三端点（/voice-mode、/voice-mode/config、/voice-mode/models/status）
#   2) 真实 LLM 端到端：create→toggle→prompt→SSE audio 帧 + tts-error=0
# 与 scripts/smoke-runtime.sh 的区别：smoke 仅验 boot + 端点 + mic + console 0；
# full-e2e 在隔离 HOME 配齐 provider + 注入 DEEPSEEK_API_KEY，跑到真 LLM。
#
# 用法：bash scripts/full-e2e.sh <dsh核心bin.js> [端口]
#   默认：端口从 3141 起，每次调用自取；多次调用端口不同（手动指定避免冲突）
#   例：
#     bash scripts/full-e2e.sh /tmp/dsh015-rc2-core/node_modules/@deepseek-ai/dsh/lib/bin.js 3141
#
# 凭据纪律：DEEPSEEK_API_KEY 的值只通过 export 进入 dsh 子进程 env，
# 不 echo、不写日志、不进 commit、不进文档。脚本正文与所有 echo/tee 仅引用变量名。
set -euo pipefail

BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
PORT="${2:-3141}"
PROMPT="${PROMPT:-请用中文简短回复：你好。}"
COOKIE_FILE="$(mktemp /tmp/vm-e2e-cookies-XXXXXX.txt)"
[ -f "$BIN" ] || { echo "✗ dsh 核心不存在: $BIN"; exit 2; }

# --- 端口预检：被占则明确报错（避免 boot 后 curl 连接失败的 confusing 现象）---
if ss -tln 2>/dev/null | grep -qE "127\.0\.0\.1:$PORT([^0-9]|$)"; then
  echo "✗ 端口 $PORT 已被占用（换一个 PORT 重试）"; exit 2
fi

# --- 内存守卫（2026-09-24 OOM 事故教训）：可用内存不足直接拒绝，
# 整机 8GB 上隔离 dsh + 真 LLM 至少留 1.5GB available，否则 event loop 饿死
# 会复现 CLOSE-WAIT 堆积。阈值可经 MEM_MIN_MB 环境变量覆盖。
MEM_MIN_MB="${MEM_MIN_MB:-1500}"
MEM_AVAIL_MB=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 99999)
if [ "$MEM_AVAIL_MB" -lt "$MEM_MIN_MB" ]; then
  echo "✗ 可用内存 ${MEM_AVAIL_MB}MB < ${MEM_MIN_MB}MB，拒绝启动（防 OOM 连带生产 dsh）"
  echo "  等 hindsight-api 等大户回落后重跑，或调低 MEM_MIN_MB（后果自负）"
  exit 2
fi
echo "   内存检查通过：available ${MEM_AVAIL_MB}MB"

# 凭据注入：值只进本进程与 dsh 子进程 env；不写入任何文件 / 日志
if ! grep -q '^DEEPSEEK_API_KEY=' /root/.env 2>/dev/null; then
  echo "✗ /root/.env 缺 DEEPSEEK_API_KEY"; exit 2
fi
export DEEPSEEK_API_KEY="$(grep '^DEEPSEEK_API_KEY=' /root/.env | cut -d= -f2-)"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dsh-vm-e2e-XXXXXX")
DSH_HOME="$WORK/home"
BOOTLOG="$WORK/boot.log"
NODE_PID=""
LOG="$WORK/e2e.log"
exec > >(tee "$LOG") 2>&1

cleanup() {
  # 杀整个进程组（dsh 会派生子进程；只杀 NODE_PID 会残留，残留进程曾导致端口长期被占）。
  # setsid 使 dsh 成为组长，负 PID 即整个组；失败则回退单杀。
  if [ -n "$NODE_PID" ]; then
    kill -- "-$NODE_PID" 2>/dev/null || kill "$NODE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK" "$COOKIE_FILE"
}
trap cleanup EXIT

echo "== full-e2e: dsh 核心=$BIN 端口=$PORT =="
echo "   DSH_HOME=$DSH_HOME"
echo "   日志: $LOG"

# --- 隔离 profile：dsh-base（自带 dsh-llm-deepseek=deepseek-official）+ dsh-web-app + dsh-voice-mode(link) ---
LINK_SRC="$PWD"
if command -v cygpath >/dev/null 2>&1; then LINK_SRC="$(cygpath -m "$PWD")"; fi

mkdir -p "$DSH_HOME/profiles/web"
cat > "$DSH_HOME/profiles/web/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-voice-mode": "link:$LINK_SRC" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-voice-mode"], "patchReload": "startup" } }
}
EOF
echo '[]' > "$DSH_HOME/profiles/web/cordis.patch.yml"

# --- settings.yaml：deepseek-official provider + agent-default-model + onboarding + permission ---
cat > "$DSH_HOME/settings.yaml" <<'YAML'
llm-deepseek:
  models:
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
      contextWindow: 1000000
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-pro
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
permission:
  defaultPreset: danger-full-access
YAML

# --- 预置工作区（mic/输入区要选定工作区才渲染；走文件绕过选择器交互）---
mkdir -p "$DSH_HOME/storages" "$WORK/ws"
WS_DIR="$WORK/ws"
if command -v cygpath >/dev/null 2>&1; then WS_DIR="$(cygpath -m "$WORK/ws")"; fi
WS_ID="00000000-0000-4000-8000-00000000e2e0"
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
        "title": "e2e",
        "sessionIds": [],
        "createdAt": "$NOW",
        "updatedAt": "$NOW"
      }
    }
  }
}
EOF

# --- 装 profile + 校验 link 真的建起来 ---
(cd "$DSH_HOME/profiles/web" && pnpm install --no-frozen-lockfile >"$WORK/pnpm.log" 2>&1) || {
  echo "✗ profile pnpm install 失败"; tail -20 "$WORK/pnpm.log"; exit 1
}
[ -e "$DSH_HOME/profiles/web/node_modules/dsh-voice-mode/package.json" ] || {
  echo "✗ dsh-voice-mode 未 link 进隔离 profile"; tail -20 "$WORK/pnpm.log"; exit 1
}

# --- boot dsh 核心（setsid 独立进程组，trap 可整体回收） ---
# BOOT_ARGS 可覆盖默认启动参数（旧版本 CLI 形态不同：如 0.0.1 系为 `--profile web`
# 且无 `--no-open`，此时传 BOOT_ARGS="--profile web --port $PORT --host 127.0.0.1"）。
echo "== boot dsh 核心（port $PORT）=="
# shellcheck disable=SC2086
DSH_HOME="$DSH_HOME" setsid node "$BIN" ${BOOT_ARGS:-web --port "$PORT" --host 127.0.0.1 --no-open} >"$BOOTLOG" 2>&1 &
NODE_PID=$!

URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE "http://127\.0\.0\.1:$PORT[^ ]*" "$BOOTLOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "✗ dsh 启动即退出"; tail -30 "$BOOTLOG"; exit 1
  fi
  sleep 1
done
[ -z "$URL" ] && { echo "✗ 60s 内未等到 URL"; tail -30 "$BOOTLOG"; exit 1; }
echo "   boot 成功: $URL"

# --- 就绪等待（URL 出现 ≠ 服务可接受连接；此前偶发 EXIT=7 即此竞态）---
# 轮询 /voice-mode 直到返回 HTTP 码（任何码都算活着，000 才算没好）。
BASE="http://127.0.0.1:$PORT"
READY=""
for _ in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$BASE/voice-mode" 2>/dev/null || echo "000")
  if [ "$CODE" != "000" ]; then READY=1; break; fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "✗ dsh 在就绪等待期退出"; tail -30 "$BOOTLOG"; exit 1
  fi
  sleep 1
done
[ -z "$READY" ] && { echo "✗ 60s 内服务未就绪（URL 已打印但无响应）"; tail -30 "$BOOTLOG"; exit 1; }
echo "   服务就绪: $BASE"

# --- 围栏换 Cookie（0.1.5+ boot URL 带 token；BASE 已在就绪等待段定义）---
if echo "$URL" | grep -q 'token='; then
  TOK=$(echo "$URL" | grep -oE 'token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
  curl -sL -c "$COOKIE_FILE" "$BASE/?token=$TOK" -o /dev/null
  echo "   (已用启动令牌换 Cookie)"
fi

# --- 三端点断言 ---
fail=0
check() {
  local code body
  body=$(curl -s -b "$COOKIE_FILE" -H "Origin:$BASE" "$2" 2>/dev/null)
  code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_FILE" -H "Origin:$BASE" "$2" 2>/dev/null)
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q "$3"; then
    echo "   ✓ $1 ($code)"
  else
    echo "   ✗ $1 (code=$code, body=$(printf '%s' "$body" | head -c 120))"
    fail=1
  fi
}
echo "== 三端点 =="
check "/voice-mode"           "$BASE/voice-mode"            '"ok":true'
check "/voice-mode/config"    "$BASE/voice-mode/config"     'ttsEngine'
check "/voice-mode/models/status" "$BASE/voice-mode/models/status" 'asr'

# --- 真 LLM 端到端（spoken-prompt-rpc）---
# 注意：spoke-prompt-rpc 内置 ensure_auth 会从 journalctl -u dsh.service 取 token 换 Cookie，
# 这在隔离 DSH_HOME 下会失败且覆盖我们已准备好的 Cookie_FILE。
# 解决：生成临时 patch 副本（用 python 简单可靠地把 ensure_auth 函数体替换为 return 0）。
echo "== 真 LLM 端到端（deepseek-v4-pro）=="
RPC_OUT="$WORK/rpc.log"
RPC_PATCHED="$WORK/spoken-prompt-rpc-patched.sh"
SRC="$(dirname "$0")/../../../test/spoken-prompt-rpc.sh"
python3 - "$SRC" "$RPC_PATCHED" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f: text = f.read()
# 把 ensure_auth() { ... 第一个独立 } 整段替换为单行 stub
pat = re.compile(r'^ensure_auth\(\) \{.*?^\}', re.MULTILINE | re.DOTALL)
new = pat.sub('ensure_auth() { return 0; }', text, count=1)
with open(dst, 'w') as f: f.write(new)
PY
chmod +x "$RPC_PATCHED"
PROMPT="$PROMPT" COOKIE_FILE="$COOKIE_FILE" BASE="$BASE" \
  bash "$RPC_PATCHED" >"$RPC_OUT" 2>&1 || true

# spoken-prompt-rpc 内部把 SSE 流写到 /tmp/vm-sse.log（硬编码全局路径），但在 RPC 退出时
# 已经 kill curl，SSE buffer 没 flush，/tmp/vm-sse.log 会变空。所以不能直接读它——
# 而应读 RPC_OUT 里 spoke-prompt-rpc 自己输出的 "SSE audio 帧数: N" / "SSE tts-error: N"。
# 兼容：如果 RPC_OUT 没有那两行（异常路径），fallback 到 /tmp/vm-sse.log。
RPC_SSE="$(grep -oE 'SSE audio 帧数: [0-9]+' "$RPC_OUT" 2>/dev/null | grep -oE '[0-9]+$' | head -1)"
RPC_TTS_ERR="$(grep -oE 'SSE tts-error: [0-9]+' "$RPC_OUT" 2>/dev/null | grep -oE '[0-9]+$' | head -1)"
RPC_SSE="${RPC_SSE:-0}"
RPC_TTS_ERR="${RPC_TTS_ERR:-0}"

# 摘要 RPC 结果行（写到 LOG，便于人类审计）
{
  echo "   --- RPC 摘要 ---"
  grep -E '^(CREATE|SID=|TOGGLE|PROMPT|SSE audio 帧数|SSE tts-error):' "$RPC_OUT" | head -20
  echo "   ----------------"
} 2>/dev/null

[ "$fail" -eq 0 ] && [ "$RPC_SSE" -ge 1 ] && [ "$RPC_TTS_ERR" -eq 0 ] && {
  echo "✓ full-e2e PASS: 三端点 200 + LLM 端到端 ${RPC_SSE} 帧 / ${RPC_TTS_ERR} tts-error"
  exit 0
}

echo "✗ full-e2e FAIL: 三端点 fail=$fail / SSE 帧=$RPC_SSE / tts-error=$RPC_TTS_ERR"
echo "   诊断：boot.log 末尾 →"
tail -20 "$BOOTLOG"
echo "   诊断：RPC 全文 →"
cat "$RPC_OUT"
exit 1
