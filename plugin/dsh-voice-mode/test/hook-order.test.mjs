/**
 * Hook 顺序守卫（2026-11-20，重启后实测 React #310）：
 * 在函数体顶层出现 early return（if (...) return / return）之后，不得再调用 React hooks。
 *
 * 事故：EngineStatusInline 的 actError useState 被加在 `if (!tts) return <></>` 之后，
 * 设置页在 tts 状态从「无」变「有」时 hook 数量变化 → 白屏（React error #310）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')
const files = readdirSync(srcDir).filter((f) => /\.tsx?$/.test(f))
const HOOK = /\buse(State|Effect|Ref|Memo|Callback|Id|Context|Reducer|LayoutEffect)\s*\(/

const isEarlyExit = (stmt) => {
  if (ts.isReturnStatement(stmt)) return true
  if (ts.isIfStatement(stmt)) {
    const then = stmt.thenStatement
    if (ts.isReturnStatement(then)) return true
    if (ts.isBlock(then) && then.statements.some((s) => ts.isReturnStatement(s))) return true
  }
  return false
}

const offenders = []
for (const f of files) {
  const sf = ts.createSourceFile(f, readFileSync(join(srcDir, f), 'utf8'), ts.ScriptTarget.Latest, true)
  const checkBody = (body, name) => {
    let sawExit = false
    for (const stmt of body.statements) {
      if (isEarlyExit(stmt)) { sawExit = true; continue }
      const text = stmt.getText(sf)
      if (sawExit && HOOK.test(text)) {
        const line = sf.getLineAndCharacterOfPosition(stmt.getStart()).line + 1
        offenders.push(f + ':' + line + ' ' + name + ' — ' + text.slice(0, 90))
      }
    }
  }
  const walk = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body && ts.isBlock(n.body)) checkBody(n.body, n.name.text)
    else if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) checkBody(n.body, n.parent.name.text)
    ts.forEachChild(n, walk)
  }
  walk(sf)
}

console.log('hook-order（early return 之后不得调用 hooks）')
assert.deepEqual(offenders, [], '这些函数在 early return 之后调用了 hooks（React #310 风险，设置页会白屏）：' + offenders.join(' | '))
console.log('  ✓ ' + files.length + ' 个源文件无 hook 顺序违规')
console.log('\nhook-order：1 项通过')
