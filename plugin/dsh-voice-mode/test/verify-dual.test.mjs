// 验证真实编排脚本的选版、逐版深度及失败传播；子检查用记录调用的桩，避免下载宿主。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = mkdtempSync(join(tmpdir(), 'verify-dual-test-'))
try {
  mkdirSync(join(fixture, 'scripts'))
  copyFileSync(new URL('../scripts/verify-dual.sh', import.meta.url), join(fixture, 'scripts/verify-dual.sh'))
  writeFileSync(join(fixture, 'scripts/check-anchors.mjs'), `
import { appendFileSync } from 'node:fs'
appendFileSync('calls', 'anchors ' + process.argv.slice(2).join(' ') + '\\n')
if (process.env.FAIL_STAGE === 'anchors') process.exit(7)
`)
  for (const [file, stage] of [['typecheck-dual.sh', 'types'], ['smoke-runtime.sh', 'runtime']]) {
    writeFileSync(join(fixture, 'scripts', file), `#!/usr/bin/env bash
printf '%s %s hmr=%s\\n' '${stage}' "$*" "\${DSH_TEST_SKIP_HMR_WATCH:-0}" >> calls
if [ "\${FAIL_STAGE:-}" = '${stage}' ]; then exit 7; fi
`)
  }
  const run = (args = [], extraEnv = {}, expected = 0) => {
    writeFileSync(join(fixture, 'calls'), '')
    const result = spawnSync('bash', ['scripts/verify-dual.sh', ...args], {
      cwd: fixture, encoding: 'utf8', env: { ...process.env, DSH_TEST_SKIP_HMR_WATCH: '', DSHVM_SMOKE_PORT: '3135', FAIL_STAGE: '', ...extraEnv },
    })
    assert.equal(result.status, expected, result.stdout + result.stderr)
    return { output: result.stdout.trim(), calls: readFileSync(join(fixture, 'calls'), 'utf8').trim().split('\n').filter(Boolean) }
  }
  const current = run(['--list']).output.split('\n')
  const full = run(['--list', '--full']).output.split('\n')
  assert.equal(full.length, 24, '历史全集不得丢失')
  assert.equal(current.length, 9)
  const latestPerLine = new Map(full.map(v => [v.split('-')[0], v]))
  assert.deepEqual(new Set(current), new Set([full[0], full.at(-1), ...latestPerLine.values(), '0.2.2-rc.1']), '端点、各线最新与 latest/next 均须保留')
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.deepEqual(ci.match(/run: bash scripts\/typecheck-dual.sh (.+)/)[1].split(' '), current)
  assert.equal(ci.match(/name: Typecheck matrix \((.+)\)/)[1], current.join(' / '))
  const defaults = run()
  assert.equal(defaults.calls[0], 'anchors ' + current.join(' '))
  assert.equal(defaults.calls[1], 'types ' + current.join(' ') + ' hmr=0')
  assert.equal(defaults.calls.filter(c => c.startsWith('runtime ')).length, 8)
  assert.match(defaults.calls[2], /dsh-0-1-1-rc-2.*3135 hmr=1$/)
  assert.equal(run(['--full']).calls.filter(c => c.startsWith('runtime ')).length, 21)
  const historical = run(['0.1.5-rc.2', '0.1.5-rc.2'], { DSHVM_CORE_ROOT: '/tmp/custom cores', DSHVM_SMOKE_PORT: '4200' })
  assert.equal(historical.calls.length, 3, '显式版本去重，保留三层检查')
  assert.match(historical.calls[2], /^runtime \/tmp\/custom cores\/dsh-0-1-5-rc-2\/node_modules\/@deepseek-ai\/dsh\/lib\/bin.js 4200 hmr=0$/)
  assert.equal(run(['--list', '0.9.0-rc.1']).output, '0.9.0-rc.1', '显式版本不能被固定历史列表挡住')
  run(['--full', '0.1.5-rc.2'], {}, 2)
  run(['--typo'], {}, 2)
  for (const [stage, calls] of [['anchors', 1], ['types', 2], ['runtime', 3]]) {
    assert.equal(run([], { FAIL_STAGE: stage }, 7).calls.length, calls, '任一层失败须非零并停止后续层')
  }
  // 执行巡检的只读部分：归档 alpha 不误报，但 latest/next 落到档案或未知版必须失败。
  const workflow = readFileSync(new URL('../../../.github/workflows/dsh-version-check.yml', import.meta.url), 'utf8')
  const shell = workflow.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n')
  const readOnly = shell.slice(0, shell.indexOf('KEYWORD=')) + '\nexit 1\n'
  const scriptsDir = join(fixture, 'plugin/dsh-voice-mode/scripts')
  mkdirSync(scriptsDir, { recursive: true })
  copyFileSync(join(fixture, 'scripts/verify-dual.sh'), join(scriptsDir, 'verify-dual.sh'))
  mkdirSync(join(fixture, 'bin'))
  writeFileSync(join(fixture, 'bin/npm'), `#!/usr/bin/env bash\nprintf '%s\\n' "$MATRIX_TAGS"\n`, { mode: 0o755 })
  for (const [tags, status] of [
    [{ alpha: '0.2.2-alpha.3', latest: '0.2.2-rc.1', next: '0.2.2-rc.2' }, 0],
    [{ latest: '0.2.1-rc.4', next: '0.2.2-rc.2' }, 1],
    [{ latest: '0.2.2-rc.1', next: '0.2.2-rc.3' }, 1],
  ]) {
    const result = spawnSync('bash', ['-c', readOnly], {
      cwd: fixture, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', PATH: join(fixture, 'bin') + ':' + process.env.PATH, MATRIX_TAGS: JSON.stringify(tags) },
    })
    assert.equal(result.status, status, result.stdout + result.stderr)
  }
  console.log('verify-dual：选版、历史复验、CI 一致性、验证深度与失败传播通过')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
