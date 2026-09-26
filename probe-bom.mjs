/**
 * 探针：`.env` 文件带 UTF-8 BOM 时会怎样。
 *
 * Windows 上的记事本等工具常给文本文件加 BOM。BOM 是 U+FEFF，
 * `readFileSync(p, 'utf8')` **不会**剥掉它，所以它会被当成第一行内容的一部分。
 *
 * 三个要回答的问题：
 *   1. `parseEnv` / 我的 `parseDotEnv` 会把 BOM 算进第一个键名吗？
 *   2. 编辑第一行之后写回，BOM 还在吗？
 *   3. 如果 BOM 粘进键名，UI 能看见吗？
 *
 * 运行：node probe-bom.mjs
 */

import { parseEnv } from 'node:util'
import { parseDotEnv } from './lib/env-model.js'
import { splitDotEnv, joinDotEnv } from './lib/env-write.js'

const BOM = '\uFEFF'
const withBom = `${BOM}FIRST="one"\nSECOND="two"\n`

console.log('=== 1. 键名是否被 BOM 污染 ===')
console.log('input bytes      :', Buffer.from(withBom, 'utf8').slice(0, 12).toString('hex'))
console.log('parseEnv         :', JSON.stringify(parseEnv(withBom)))
console.log('我的 parseDotEnv :', JSON.stringify(parseDotEnv(withBom)))
console.log()
console.log('第一个键名是否以 U+FEFF 开头：')
const nodeKeys = Object.keys(parseEnv(withBom))
const mineKeys = Object.keys(parseDotEnv(withBom))
console.log('  parseEnv  :', JSON.stringify(nodeKeys[0]), '->', nodeKeys[0].charCodeAt(0) === 0xfeff)
console.log('  我的      :', JSON.stringify(mineKeys[0]), '->', mineKeys[0].charCodeAt(0) === 0xfeff)
console.log()
console.log('=== 2. split/join 是否保住 BOM ===')
const segs = splitDotEnv(withBom)
console.log('segments         :', segs.map((s) => `${s.kind}:${JSON.stringify(s.raw)}`).join(' | '))
console.log('join 往返一致    :', joinDotEnv(segs) === withBom)
console.log()
console.log('=== 3. 无 BOM 的对照 ===')
const noBom = 'FIRST="one"\nSECOND="two"\n'
console.log('parseEnv         :', JSON.stringify(parseEnv(noBom)))
console.log()
console.log('=== 4. 结论 ===')
console.log('如果第 1 项两个都显示 true，说明 BOM 会让第一个变量名变成 "\\uFEFFFIRST"，')
console.log('这个名字在 UI 里**不可见**（BOM 无字形），用户既看不到也删不掉，')
console.log('而 DSH 读到的键名与显示的不同 —— 这就是静默损坏。')
