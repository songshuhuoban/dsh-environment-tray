/**
 * 探针：经**完整路径**（写文件 → `process.loadEnvFile`）验证引号策略。
 *
 * `parseEnv` 是 DSH 的读取路径之一，但真正把值装进 `process.env` 的是
 * `loadEnvFile`（`dsh-app-boot` 的 `loadLayeredEnv` 会同时用两者）。
 * 引号策略必须在**这条**路径上也成立，否则 UI 写出的文件在 DSH 里读不对。
 *
 * 运行：node probe-roundtrip-via-file.mjs
 */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnv } from 'node:util'

const SQ = String.fromCharCode(39)
const DQ = String.fromCharCode(34)

/** 用指定字面量包装一个值。 */
const dqWrap = (v) => `${DQ}${v}${DQ}`
const sqWrap = (v) => `${SQ}${v}${SQ}`

const cases = [
  ['plain', 'plain', dqWrap],
  ['with space', 'with space', dqWrap],
  ['hash', 'a#b', dqWrap],
  ['double quote', `a${DQ}b`, sqWrap],
  ['single quote', `a${SQ}b`, dqWrap],
  ['both quotes', `a${DQ}b${SQ}c`, null],
  ['newline', 'a\nb', dqWrap],
  ['double quote + newline', `a${DQ}b\nc`, null],
  ['backslash', 'a\\b', dqWrap],
  ['dollar', '$X', dqWrap],
]

const dir = mkdtempSync(join(tmpdir(), 'dsh-quote-probe-'))

for (const [label, value, wrap] of cases) {
  // 没有可用包装方式时，按序列化器的实际做法（双引号 + 换行转义）写入
  const literal = wrap === null ? dqWrap(value.replace(/\n/g, '\\n')) : wrap(value)
  const file = join(dir, 'probe.env')
  writeFileSync(file, `PROBE=${literal}\n`)

  const viaParseEnv = parseEnv(`PROBE=${literal}`).PROBE

  process.env.PROBE = undefined
  delete process.env.PROBE
  process.loadEnvFile(file)
  const viaLoadEnvFile = process.env.PROBE

  const okParse = viaParseEnv === value
  const okLoad = viaLoadEnvFile === value
  console.log(
    `${label.padEnd(24)} wrap=${wrap === null ? 'dq-lossy ' : wrap === sqWrap ? 'single   ' : 'double   '}` +
      ` parseEnv=${okParse ? 'OK ' : 'BAD'} loadEnvFile=${okLoad ? 'OK ' : 'BAD'}` +
      `${okParse && okLoad ? '' : `  got=${JSON.stringify(viaLoadEnvFile)}`}`,
  )
}
