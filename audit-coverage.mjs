/**
 * 覆盖审计：每个 lib 导出的符号，是否被某个测试套件实际引用？
 *
 * 导出但从未被断言过的符号是"看起来有保护、其实没有"的盲区 ——
 * 它们会随着改动悄悄失效，而没有任何红灯。
 *
 * 运行：node audit-coverage.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const libDir = 'lib'
const suites = readdirSync('.').filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
const probes = readdirSync('.').filter((f) => f.startsWith('probe-') && f.endsWith('.mjs'))

const suiteText = suites.map((f) => readFileSync(f, 'utf8')).join('\n')
const probeText = probes.map((f) => readFileSync(f, 'utf8')).join('\n')

/** 从一个模块源码里抓出所有 `export function|class|const` 的名字。 */
function exportsOf(src) {
  const names = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1])
  return [...names].sort()
}

const rows = []
let untested = 0
let probeOnly = 0

for (const file of readdirSync(libDir).filter((f) => f.endsWith('.mjs'))) {
  const src = readFileSync(join(libDir, file), 'utf8')
  for (const name of exportsOf(src)) {
    // 用词边界匹配，避免 `parseDotEnv` 命中 `parseDotEnvX`
    const inSuite = new RegExp(`\\b${name}\\b`).test(suiteText)
    const inProbe = new RegExp(`\\b${name}\\b`).test(probeText)
    rows.push({ file, name, inSuite, inProbe })
    if (!inSuite && !inProbe) untested += 1
    else if (!inSuite && inProbe) probeOnly += 1
  }
}

console.log('模块与导出符号覆盖情况：\n')
let currentFile = ''
for (const r of rows) {
  if (r.file !== currentFile) {
    currentFile = r.file
    console.log(`  ${currentFile}`)
  }
  const mark = r.inSuite ? '✅ 测试' : r.inProbe ? '🔍 仅探针' : '❌ 未覆盖'
  console.log(`      ${mark.padEnd(10)} ${r.name}`)
}

console.log()
console.log(`导出符号总数   : ${rows.length}`)
console.log(`测试覆盖       : ${rows.filter((r) => r.inSuite).length}`)
console.log(`仅探针覆盖     : ${probeOnly}`)
console.log(`完全未覆盖     : ${untested}`)

if (untested > 0) {
  console.log('\n未覆盖清单：')
  for (const r of rows.filter((x) => !x.inSuite && !x.inProbe)) console.log(`  - ${r.file} :: ${r.name}`)
  console.log('\n❌ 存在未覆盖的导出 —— 它们看起来受保护，实际没有断言守住。')
} else if (probeOnly > 0) {
  console.log('\n⚠ 所有导出都被引用了，但有若干只在探针里出现（探针不是断言，建议补进测试套件）。')
} else {
  console.log('\n✅ 每个导出都被至少一个测试套件实际引用。')
}

console.log()
console.log(`套件数: ${suites.length}  探针数: ${probes.length}`)
console.log(`套件: ${suites.join(', ')}`)
console.log(`探针: ${probes.join(', ')}`)
