#!/usr/bin/env bash
# dsh-voice-mode 口语化提示词 RPC 端到端验证（不经浏览器输入框，避开 Q13 打字退出）
# 流程：创建新会话 -> toggle 进入语音模式 -> 启动 SSE 收集 -> session.prompt 发消息
#       -> 收集/验证：SSE audio 帧 + 会话 request/header system 含语音提示词 + 回复口语化
#
# 跨版本兼容（2026-09-10 起）：
#   - RPC 路径两形回退：≤0.1.2 为点形（/api/session.create），0.1.5 起网关为斜杠形
#     （/api/session/create，方法名证据：dsh-api-session-controller lib 内 'session/create' 等字面量）。
#     rpc() 先点形后斜杠形，响应体恰为 "not found" 即回退。
#   - 鉴权自处理：alpha.4+ 的 /api 围栏需要会话 Cookie。检测到 "unauthorized" 时，
#     从 journalctl 取本次 boot 的启动令牌，换持久 Cookie 后重试（ROOT 运行）。
set -u
BASE="${BASE:-http://127.0.0.1:3018}"
PROMPT="${PROMPT:-请用中文介绍一下你自己，你擅长什么？回答控制在三句话以内。}"
COOKIE_FILE="${COOKIE_FILE:-/tmp/vm-rpc-cookies.$$.txt}"

ensure_auth() { # 围栏拦截时换 Cookie；返回 0 表示已就绪（或本就无需）
  local probe
  probe=$(curl -s --max-time 10 -X POST "$BASE/api/session/list" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"authcheck-$$\",\"method\":\"session/list\",\"payload\":{}}")
  case "$probe" in
    unauthorized) ;;
    *) return 0 ;;
  esac
  local token
  token=$(journalctl -u dsh.service -b --no-pager 2>/dev/null | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2)
  [ -z "$token" ] && { echo "✗ 检测到围栏但取不到启动令牌（需 ROOT 运行）" >&2; return 1; }
  curl -sL -c "$COOKIE_FILE" "$BASE/?token=$token" -o /dev/null
  echo "  (已用启动令牌换取会话 Cookie)"
}

rpc() { # rpc <方法，点形> <payload-json>
  # 回退梯（跨版本）：①点形直排（≤0.1.2）→ ②斜杠形直排（0.1.5 路径）→ ③斜杠+args 直排
  # （0.1.5 remote 信封）→ ④斜杠+args.request（0.1.5 typert 描述符把字段整体嵌进 request）
  local m="$1" body="$2" out
  call() { # call <方法形> <payload>
    curl -s -b "$COOKIE_FILE" --max-time 30 -X POST "$BASE/api/$1" \
      -H 'content-type: application/json' \
      -d "{\"type\":\"client-request\",\"rpcId\":\"rpctest-$$\",\"method\":\"$1\",\"payload\":$2}"
  }
  out=$(call "$m" "$body")
  if [ "$out" = "not found" ]; then
    m="${m//.//}"
    out=$(call "$m" "$body")
  fi
  if printf '%s' "$out" | grep -q "plain-object args field"; then
    out=$(call "$m" "{\"args\":$body}")
  fi
  if printf '%s' "$out" | grep -qE 'missing .{0,2}request'; then
    out=$(call "$m" "{\"args\":{\"request\":$body}}")
  fi
  printf '%s' "$out"
}

ensure_auth || exit 1

# 1. 新会话
CREATE=$(rpc session.create '{"cwd":"/mnt/dsh-voice-mode"}')
echo "CREATE: ${CREATE:0:200}"
SID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); r=d.get('result',{}); print(r.get('sessionId') or r.get('value',{}).get('sessionId') or '')" "$CREATE" 2>/dev/null)
if [ -z "$SID" ]; then
  SID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); r=d.get('result',{}); print((r.get('id') or r.get('value',{}).get('id') or ''))" "$CREATE" 2>/dev/null)
fi
if [ -z "$SID" ]; then
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print('✗ 未取得 sessionId：', json.dumps(d,ensure_ascii=False)[:300])" "$CREATE" >&2
  exit 1
fi
echo "SID=$SID"

# 2. 进入语音模式（toggle 走插件 HTTP 面，不走 rpc()）
TOG=$(curl -s -b "$COOKIE_FILE" --max-time 10 -X POST "$BASE/voice-mode/toggle" \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"on\":true}")
echo "TOGGLE: $TOG"

# 3. SSE 音频收集（后台）
rm -f /tmp/vm-sse.log
curl -N -s -b "$COOKIE_FILE" --max-time 180 "$BASE/voice-mode/stream" > /tmp/vm-sse.log &
SSE_PID=$!

# 4. 发送消息（0.1.5 起 requestId 为必填；≤0.1.2 多余字段会被忽略，双版本通用）
R=$(rpc session.prompt "{\"sessionId\":\"$SID\",\"requestId\":\"rpctest-$$\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"$PROMPT\"}]}")
echo "PROMPT: ${R:0:150}"

# 5. 等回合完成（SSE audio 帧出现且 10s 无新帧；上限 150s）
AUDIO_BEFORE=0
STABLE=0
DEADLINE=$(( $(date +%s) + 150 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 5
  N=$(grep -c '^event: audio' /tmp/vm-sse.log 2>/dev/null)
  if [ "$N" -gt 0 ]; then
    if [ "$N" -eq "$AUDIO_BEFORE" ]; then
      STABLE=$(( STABLE + 1 ))
      [ "$STABLE" -ge 2 ] && break
    else
      AUDIO_BEFORE=$N
      STABLE=0
    fi
  fi
done

# 6. 结果
echo "== 结果 =="
echo "SSE audio 帧数: $(grep -c '^event: audio' /tmp/vm-sse.log 2>/dev/null)"
echo "SSE tts-error: $(grep -c 'tts-error' /tmp/vm-sse.log 2>/dev/null)"
grep '^event: audio' /tmp/vm-sse.log | head -8
# 会话 system 校验
SF="/home/www/.dsh/sessions/--mnt-dsh-voice-mode--/$SID/session.jsonl.zstd"
if [ -f "$SF" ]; then
  zstd -dc "$SF" 2>/dev/null | python3 -c "
import json,sys
for ln in sys.stdin:
    o = json.loads(ln)
    if o.get('type') == 'request/header':
        s = o.get('data',{}).get('header',{}).get('system','')
        print('system 长度:', len(s), '含语音提示词:', '【语音模式】' in s)
        break
"
  zstd -dc "$SF" 2>/dev/null | python3 -c "
import json,sys
text=''
for ln in sys.stdin:
    o = json.loads(ln)
    if o.get('type') == 'text-chunks':
        text += ''.join(o['data']['texts'])
print('回复:', text[:300])
"
fi
kill $SSE_PID 2>/dev/null
echo "SID_FOR_CLEANUP=$SID"
