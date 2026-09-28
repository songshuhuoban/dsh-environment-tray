/**
 * 文档保真校验：README 里声明的断言数是否与实测一致。
 *
 * 写文档最容易出的错就是过时的数字。这个脚本把 README 里的
 * `文件名 ... （N）` 解析出来，逐个真跑一遍比对。
 *
 * 注意 README 里的文件名**没有反引号**（它们在 ```bash 代码块里），
 * 而且括号是**全角**的 —— 我因为这个写错了两次正则，所以这条注释留着。
 *
 * 运行：node audit-readme.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const readme = readFileSync('README.md', 'utf8')

// 形如：`node verify-env-model.mjs         # 说明（192）`
const pattern = /^\s*node\s+([a-z0-9-]+\.mjs)\s+#.*?\uFF08(\d+)\uFF09\s*$/gm
const declared = new Map()
for (const m of readme.matchAll(pattern)) declared.set(m[1], Number(m[2]))

console.log(`README 解析到 ${String(declared.size)} 条断言数声明\n`)

let mismatches = 0
let total = 0
// These comparisons run only when the developer's installed DSH reference files
// are available. A clean release runner still exercises every other assertion.
const optionalReferences = new Map([
  ['check-p0.mjs', { count: 3, marker: 'SKIP  找不到第一方参照包' }],
  ['verify-env-model.mjs', { count: 8, marker: 'SKIP  DSH 源码不在预期路径' }],
])

for (const [file, claimed] of [...declared].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!existsSync(file)) {
    console.log(`  MISSING   ${file} —— README 引用了不存在的文件`)
    mismatches += 1
    continue
  }

  let output
  let exitedWithError = false
  try {
    output = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    // 非零退出也算失败，但先把输出拿到手
    exitedWithError = true
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const actual = (output.match(/^(?:PASS|FAIL)/gm) ?? []).length
  const failed = (output.match(/^FAIL/gm) ?? []).length
  const optional = optionalReferences.get(file)
  const skipped = optional && output.includes(optional.marker) ? optional.count : 0
  const accounted = actual + skipped
  total += accounted
  const okCount = claimed === accounted && failed === 0 && !exitedWithError
  if (!okCount) mismatches += 1
  console.log(`  ${okCount ? 'OK      ' : 'MISMATCH'}  ${file.padEnd(32)} README=${String(claimed).padEnd(4)} actual=${String(actual).padEnd(4)} skipped=${String(skipped).padEnd(2)} fail=${String(failed)}${exitedWithError ? ' exit=nonzero' : ''}`)
}

// 总断言数
const totalMatch = /测试套件\uFF08\d+\s*个可运行文件，(\d+)\s*项断言\uFF09/.exec(readme)
console.log()
if (totalMatch === null) {
  console.log('  README 里没有找到"测试套件（N 项断言）"的声明')
  mismatches += 1
} else {
  const claimedTotal = Number(totalMatch[1])
  const okTotal = claimedTotal === total
  if (!okTotal) mismatches += 1
  console.log(`  ${okTotal ? 'OK      ' : 'MISMATCH'}  总断言数                          README=${String(claimedTotal).padEnd(4)} actual=${String(total)}`)
}

// 反向检查：磁盘上的审计脚本是否都写进了 README
const AUDITS = ['audit-coverage.mjs', 'audit-hostile-input.mjs', 'audit-readme.mjs']
for (const name of AUDITS) {
  if (!readme.includes(name) && name !== 'audit-readme.mjs') {
    console.log(`  MISSING   ${name} 未写入 README`)
    mismatches += 1
  }
}

console.log()
console.log(mismatches === 0 ? '✅ README 与实测完全一致' : `❌ ${String(mismatches)} 处不一致`)
process.exitCode = mismatches === 0 ? 0 : 1
