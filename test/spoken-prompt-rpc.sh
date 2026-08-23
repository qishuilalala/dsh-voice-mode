#!/usr/bin/env bash
# dsh-voice-mode 口语化提示词 RPC 端到端验证（不经浏览器输入框，避开 Q13 打字退出）
# 流程：session.create 新会话 -> toggle 进入语音模式 -> 启动 SSE 收集 -> session.prompt 发消息
#       -> 收集/验证：SSE audio 帧 + 会话 request/header system 含语音提示词 + 回复口语化
set -u
BASE="${BASE:-http://127.0.0.1:3018}"
PROMPT="${PROMPT:-请用中文介绍一下你自己，你擅长什么？回答控制在三句话以内。}"

rpc() { # rpc <method> <payload-json>
  curl -s --max-time 30 -X POST "$BASE/api/$1" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"rpctest-$$\",\"method\":\"$1\",\"payload\":$2}"
}

# 1. 新会话
CREATE=$(rpc session.create '{"cwd":"/mnt/dsh-voice-mode"}')
echo "CREATE: ${CREATE:0:200}"
SID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); r=d.get('result',{}); print(r.get('sessionId') or r.get('value',{}).get('sessionId') or '')" "$CREATE")
if [ -z "$SID" ]; then
  SID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(json.dumps(d,ensure_ascii=False)[:200])" "$CREATE" >&2; exit 1)
fi
echo "SID=$SID"

# 2. 进入语音模式（toggle 走插件 HTTP 面，不走 rpc()）
TOG=$(curl -s --max-time 10 -X POST "$BASE/voice-mode/toggle" \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"on\":true}")
echo "TOGGLE: $TOG"

# 3. SSE 音频收集（后台）
rm -f /tmp/vm-sse.log
curl -N -s --max-time 180 "$BASE/voice-mode/stream" > /tmp/vm-sse.log &
SSE_PID=$!

# 4. 发送消息
R=$(rpc session.prompt "{\"sessionId\":\"$SID\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"$PROMPT\"}]}")
echo "PROMPT: ${R:0:150}"

# 5. 等回合完成（SSE audio 帧出现且 10s 无新帧；上限 150s）
AUDIO_BEFORE=0
STABLE=0
DEADLINE=$(( $(date +%s) + 150 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 5
  N=$(grep -c '^event: audio' /tmp/vm-sse.log 2>/dev/null || echo 0)
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
echo "SSE audio 帧数: $(grep -c '^event: audio' /tmp/vm-sse.log 2>/dev/null || echo 0)"
echo "SSE tts-error: $(grep -c 'tts-error' /tmp/vm-sse.log 2>/dev/null || echo 0)"
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
