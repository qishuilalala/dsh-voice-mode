#!/bin/bash
# 启动隔离验证实例（官方纪律：独立 home/profile/端口，不碰生产 3018）。
# 用法：test/run-isolated.sh [port]   （默认 3020；Ctrl+C 或 kill 该进程即停）
set -euo pipefail
PORT="${1:-3020}"
HOME_ROOT=/tmp/dsh-vtest-home
PROFILE=vtest
echo "[isolated] home=$HOME_ROOT profile=$PROFILE port=$PORT"
mkdir -p "$HOME_ROOT/profiles"
# profile 首次创建（幂等）：官方 dsh plugin 命令
if [ ! -d "$HOME_ROOT/profiles/$PROFILE" ]; then
  cp -r /home/www/.dsh/profiles/$PROFILE "$HOME_ROOT/profiles/" 2>/dev/null || echo "note: copy profile template first: dsh plugin --profile $PROFILE add <plugin>"
fi
# 工作区种子（schema 必填 createdAt/updatedAt）
mkdir -p "$HOME_ROOT/storages" /tmp/dsh-vtest-work
python3 - "$HOME_ROOT/storages/workspace.json" <<'PY'
import json, sys, os, datetime
p = sys.argv[1]
if os.path.exists(p) and (not os.environ.get('VT_FORCE_SEED')):
    sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump({
  "unit": {"name": "workspace", "version": 2},
  "global": {"initialized": True, "workspaceIds": ["vt-workspace-1"], "archivedSessionIds": []},
  "tables": {"workspaces": {
    "vt-workspace-1": {"path": "/tmp/dsh-vtest-work", "title": "VT 测试工作区",
                       "sessionIds": [], "createdAt": now, "updatedAt": now}}},
}, open(p, "w"), ensure_ascii=False, indent=1)
PY
export DSH_HOME="$HOME_ROOT"
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-dummy-dev-key-9f3a}"
exec dsh --profile "$PROFILE" --host 127.0.0.1 --port "$PORT" --no-open
