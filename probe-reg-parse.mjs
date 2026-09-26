/**
 * 探针：为什么 parseRegQuery 一个值都没解析出来。
 *
 * 已确认值行正则匹配成功，所以 bug 在 scope 判断（inScope 没被置上）。
 *
 * 运行：node probe-reg-parse.mjs
 */

import { execFileSync } from 'node:child_process'
import { parseRegQuery, decodeRegOutput } from './lib/registry.js'

const buffer = execFileSync('reg.exe', ['query', 'HKCU\\Environment'], { windowsHide: true })
const text = decodeRegOutput(buffer)
const KEY = 'HKCU\\Environment'

console.log('--- direct call ---')
const entries = parseRegQuery(text, KEY)
console.log('entries:', entries.length)
console.log('first:', JSON.stringify(entries[0]))

console.log('\n--- trace the scope logic by hand ---')
const normalizedKey = KEY.replace(/^HK(CU|LM)\\/i, (m) => m.toUpperCase())
console.log('normalizedKey :', JSON.stringify(normalizedKey))

for (const line of text.split(/\r?\n/).slice(0, 4)) {
  if (line.trim().length === 0) {
    console.log('  [blank] skip')
    continue
  }
  const startsWithSpace = /^\s/.test(line)
  const hasBackslash = line.includes('\\')
  if (!startsWithSpace && hasBackslash) {
    const normalized = line.trim().replace(/^HK(CU|LM)\\/i, (m) => m.toUpperCase())
    console.log('  header candidate:', JSON.stringify(normalized))
    console.log('    matches key?  :', normalized.toLowerCase() === normalizedKey.toLowerCase())
    console.log('    regex changed?:', normalized !== line.trim())
  } else {
    console.log('  value line, startsWithSpace =', startsWithSpace)
  }
}

console.log('\n--- is the header regex even matching the real header? ---')
const header = 'HKEY_CURRENT_USER\\Environment'
console.log('header        :', JSON.stringify(header))
console.log('after replace :', JSON.stringify(header.replace(/^HK(CU|LM)\\/i, (m) => m.toUpperCase())))
console.log('KEY           :', JSON.stringify(KEY))
console.log('after replace :', JSON.stringify(normalizedKey))
console.log('equal?        :', header.replace(/^HK(CU|LM)\\/i, (m) => m.toUpperCase()) === normalizedKey)
