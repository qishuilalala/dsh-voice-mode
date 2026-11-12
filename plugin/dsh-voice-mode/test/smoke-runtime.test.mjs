/**
 * 冒烟资源边界回归：不启动真实 dsh，不联网。
 * 不在 npm test 链内：仅适用于 Linux，并断言 smoke-runtime.sh 的 systemd scope
 * 资源隔离与强制回收合同；当前脚本尚不具备这些实现，macOS 会明确跳过。
 * 本测试以桩替代 systemd-run，不要求真实 systemd 服务；保留断言，待对应实现恢复后验收。
 * 手动运行（插件目录）：node test/smoke-runtime.test.mjs [待验证的 smoke-runtime.sh 路径]
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'linux') {
  console.log('跳过：生产 dsh 的 cgroup 隔离仅适用于 Linux')
  process.exit(0)
}

const script = process.argv[2] || fileURLToPath(new URL('../scripts/smoke-runtime.sh', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'smoke-runtime-test-'))
const bin = join(dir, 'bin')
mkdirSync(bin)
mkdirSync(join(dir, 'tmp'))
writeFileSync(join(dir, 'core.js'), '')
const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
stub('grep', `
if [[ "$*" == *"/proc/self/cgroup"* ]]; then
  [ "$FORCE_DSH_CGROUP" = 1 ]; exit $?
fi
exec /usr/bin/grep "$@"`)
stub('systemd-run', 'printf "%s\\n" "$@" > "$TRACE"; exit 37')
stub('pnpm', 'mkdir -p node_modules/dsh-voice-mode; touch node_modules/dsh-voice-mode/package.json')
stub('node', `
case "$1" in
  -e) exit 1 ;;
  -p) echo 0.2.2-rc.1; exit 0 ;;
esac
echo "$BASHPID" > "$HOST_PID_FILE"
trap '' TERM
echo 'http://127.0.0.1:3155/'
while :; do sleep 1; done`)
stub('curl', `
[[ "$*" == *"--max-time"* ]] || exit 8
if [ "$FAIL_CURL" = 1 ] && [[ "$*" != *'%{http_code}'* ]]; then exit 28; fi
case "$*" in
  *'%{http_code}'*) printf 200 ;;
  *) printf '{"ok":true,"ttsEngine":"edge","asr":true}' ;;
esac`)
const env = {
  ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: join(dir, 'tmp'),
  TRACE: join(dir, 'scope.args'), HOST_PID_FILE: join(dir, 'host.pid'),
}
const run = (extra = {}) => spawnSync('bash', [resolve(script), join(dir, 'core.js'), '3155'], {
  cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
})
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
let hostPid
try {
  const delegated = run({ FORCE_DSH_CGROUP: '1' })
  assert.equal(delegated.status, 37, '必须隔离到 scope，并保留其失败退出码')
  const args = readFileSync(env.TRACE, 'utf8').split('\n')
  for (const arg of ['--scope', 'MemoryHigh=1536M', 'MemoryMax=2G', 'CPUQuota=200%',
    'IOReadBandwidthMax=/ 20M', 'RuntimeMaxSec=300s', 'TimeoutStopSec=5s']) {
    assert.ok(args.includes(arg), `缺少资源边界：${arg}`)
  }
  const normal = run()
  hostPid = Number(readFileSync(env.HOST_PID_FILE, 'utf8'))
  assert.equal(normal.status, 0, normal.stdout + normal.stderr)
  assert.equal(alive(hostPid), false, '忽略 TERM 的宿主也必须被回收')
  const failed = run({ FAIL_CURL: '1' })
  hostPid = Number(readFileSync(env.HOST_PID_FILE, 'utf8'))
  assert.notEqual(failed.status, 0, '请求超时不能报告通过')
  assert.equal(alive(hostPid), false, '失败退出也必须回收宿主')
  console.log('✓ scope 隔离、失败码传递、请求时限、强制回收通过')
} finally {
  if (hostPid && alive(hostPid)) process.kill(hostPid, 'SIGKILL')
  // 旧实现红灯验证失败时也清理夹具宿主。
  try { const pid = Number(readFileSync(env.HOST_PID_FILE, 'utf8')); if (alive(pid)) process.kill(pid, 'SIGKILL') } catch {}
  rmSync(dir, { recursive: true, force: true })
}
