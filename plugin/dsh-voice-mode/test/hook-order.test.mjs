/**
 * Hook 顺序与条件调用 AST 守卫（2026-11-20，React #310 根治升级版）：
 *
 * 覆盖 Rules of Hooks 的全部常见违规形态（不再只查顶层 if-return 后的几个内置 hook）：
 *   1. 在任何提前 return（含嵌套 if/try/switch 内的 return）之后调用任何 hook（/^use[A-Z]/ 或 React.use*）；
 *   2. 在条件语句（if/else/switch）、循环（for/while/do）、try/catch/finally、三元表达式 (? :)、
 *      逻辑短路（&& / || / ??）内部调用任何 hook；
 *   3. 跨函数声明 / 箭头函数 / 函数表达式均校验，且严格按函数作用域边界隔离（不把内层嵌套组件的 hook 误算给外层）；
 *   4. 内置自测：构造 6 类违规代码片段逐条断言必检出，防止守卫本身退化为假绿。
 *
 * 运行：node test/hook-order.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = fileURLToPath(new URL('.', import.meta.url))
const srcDir = join(here, '..', 'src')
const files = readdirSync(srcDir).filter((f) => /\.tsx?$/.test(f))

const HOOK_NAME = /^use[A-Z][A-Za-z0-9_]*$/

function isFunctionBoundary(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function getHookCallName(node) {
  if (!ts.isCallExpression(node)) return null
  const expr = node.expression
  if (ts.isIdentifier(expr) && HOOK_NAME.test(expr.text)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && HOOK_NAME.test(expr.name.text)) {
    const base = expr.expression
    // 识别 React.useXxx / ReactNamespace.useXxx 及 optional chaining (useXxx?.())
    if (ts.isIdentifier(base) && (base.text === 'React' || HOOK_NAME.test(expr.name.text))) {
      return `${base.text}.${expr.name.text}`
    }
  }
  return null
}

/**
 * 扫描单个函数体内的 Rules of Hooks 违规：
 * - branchDepth > 0 表示位于 if/else/switch/loop/try/三元/短路右侧等条件分支中；
 * - mayHaveReturned 表示之前路径可能已经 return。
 * 遇到嵌套函数时停止下钻（嵌套函数会在外层 walk 中作为独立作用域被检查）。
 */
function checkFunctionBody(sf, file, fnName, body, offenders) {
  let mayHaveReturned = false

  const report = (node, hookName, reason) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    const snippet = node.getText(sf).replace(/\s+/g, ' ').slice(0, 80)
    offenders.push(`${file}:${line} ${fnName} [${reason}] ${hookName} — ${snippet}`)
  }

  function visitExpr(node, conditional) {
    if (!node || isFunctionBoundary(node)) return

    const hookName = getHookCallName(node)
    if (hookName) {
      if (conditional) report(node, hookName, 'conditional')
      else if (mayHaveReturned) report(node, hookName, 'after-return')
    }

    if (ts.isConditionalExpression(node)) {
      visitExpr(node.condition, conditional)
      visitExpr(node.whenTrue, true)
      visitExpr(node.whenFalse, true)
      return
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        visitExpr(node.left, conditional)
        visitExpr(node.right, true)
        return
      }
    }
    ts.forEachChild(node, (child) => visitExpr(child, conditional))
  }

  function visitStmt(stmt, conditional) {
    if (!stmt || isFunctionBoundary(stmt)) return false

    if (ts.isReturnStatement(stmt)) {
      if (stmt.expression) visitExpr(stmt.expression, conditional)
      return true
    }
    if (ts.isBlock(stmt)) {
      let returned = false
      for (const s of stmt.statements) {
        if (visitStmt(s, conditional)) {
          returned = true
          if (!conditional) mayHaveReturned = true
        }
      }
      return returned
    }
    if (ts.isIfStatement(stmt)) {
      visitExpr(stmt.expression, conditional)
      const rThen = visitStmt(stmt.thenStatement, true)
      const rElse = stmt.elseStatement ? visitStmt(stmt.elseStatement, true) : false
      return rThen || rElse
    }
    if (ts.isSwitchStatement(stmt)) {
      visitExpr(stmt.expression, conditional)
      let anyRet = false
      for (const clause of stmt.caseBlock.clauses) {
        for (const s of clause.statements) {
          if (visitStmt(s, true)) anyRet = true
        }
      }
      return anyRet
    }
    if (
      ts.isForStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt)
    ) {
      if ('initializer' in stmt && stmt.initializer) visitExpr(stmt.initializer, conditional)
      if ('condition' in stmt && stmt.condition) visitExpr(stmt.condition, true)
      if ('incrementor' in stmt && stmt.incrementor) visitExpr(stmt.incrementor, true)
      if ('expression' in stmt && stmt.expression) visitExpr(stmt.expression, conditional)
      return visitStmt(stmt.statement, true)
    }
    if (ts.isTryStatement(stmt)) {
      const rTry = visitStmt(stmt.tryBlock, true)
      const rCatch = stmt.catchClause ? visitStmt(stmt.catchClause.block, true) : false
      const rFin = stmt.finallyBlock ? visitStmt(stmt.finallyBlock, true) : false
      return rTry || rCatch || rFin
    }
    if (ts.isLabeledStatement(stmt)) {
      return visitStmt(stmt.statement, conditional)
    }
    // 普通语句（VariableStatement / ExpressionStatement / ThrowStatement 等）
    visitExpr(stmt, conditional)
    return false
  }

  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (visitStmt(stmt, false)) mayHaveReturned = true
    }
  } else {
    visitExpr(body, false)
  }
}

export function findHookViolations(code, filename) {
  const sf = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const offenders = []
  const fnLabel = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.text
    if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text
    if (ts.isPropertyAssignment(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text
    return '<anon>'
  }
  const walk = (n) => {
    if (isFunctionBoundary(n) && n.body) {
      checkFunctionBody(sf, filename, fnLabel(n), n.body, offenders)
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return offenders
}

console.log('hook-order（Rules of Hooks AST 全形态守卫）')

// 1. 守卫自测（变异验证：防扫描器假绿）
{
  const badCases = [
    ['if 内条件调用', 'function C(x) { if (x) { useState(0) } return null }'],
    ['early return 后调用 useSyncExternalStore', 'function C(x) { if (x) return null; useSyncExternalStore(a, b); return null }'],
    ['嵌套 early return 后调用自定义 hook', 'function C(a, b) { if (a) { if (b) return null } useLang(); return null }'],
    ['循环内调用 useRef', 'function C(arr) { for (const x of arr) { useRef(x) } return null }'],
    ['三元分支内调用 useMemo', 'const C = (x) => x ? useMemo(() => 1, []) : null'],
    ['逻辑短路内调用 useEffect', 'const C = (x) => { x && useEffect(() => {}, []); return null }'],
  ]
  for (const [label, snippet] of badCases) {
    const found = findHookViolations(snippet, 'synthetic.tsx')
    assert.ok(found.length >= 1, `守卫自测失败：未检出「${label}」`)
  }
  const goodSnippet = `
    function Outer(x) {
      const [a] = useState(0)
      useEffect(() => {}, [])
      if (!x) return null
      const Inner = () => { const [b] = useState(1); return b }
      return Inner
    }
  `
  assert.deepEqual(findHookViolations(goodSnippet, 'valid.tsx'), [], '守卫自测失败：合法代码被误报')
  console.log('  ✓ 守卫自测通过（6 类违规必检出 + 嵌套组件零误报）')
}

// 2. 扫描全仓 src/
const offenders = []
for (const f of files) {
  offenders.push(...findHookViolations(readFileSync(join(srcDir, f), 'utf8'), f))
}

assert.deepEqual(offenders, [], '存在 React Hook 顺序/条件调用违规（React #310 风险）：' + offenders.join(' | '))
console.log('  ✓ ' + files.length + ' 个源文件无 hook 顺序/条件违规')
console.log('\nhook-order：2 项通过')
