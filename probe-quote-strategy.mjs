/**
 * 探针：单引号能否承载双引号与换行。
 *
 * 差分测试里我断言"含单引号的值有损"，但测试说它能往返 —— 必须实测确认
 * 到底哪边对，再决定序列化器的引号策略。
 *
 * 运行：node probe-quote-strategy.mjs
 */

import { parseEnv } from 'node:util'

const SQ = String.fromCharCode(39) // '
const DQ = String.fromCharCode(34) // "
const BS = String.fromCharCode(92) // \

const cases = [
  ['single quote inside double quotes', `K=${DQ}with ${SQ}single${SQ}${DQ}`],
  ['double quote inside single quotes', `K=${SQ}a${DQ}b${SQ}`],
  ['backslash-n inside single quotes  ', `K=${SQ}a${BS}nb${SQ}`],
  ['real newline inside single quotes ', `K=${SQ}a\nb${SQ}`],
  ['two single quotes (empty-ish)     ', `K=${SQ}${SQ}`],
  ['single quote inside single quotes ', `K=${SQ}a${SQ}b${SQ}`],
  ['double+both quotes                ', `K=${DQ}a${DQ}b${SQ}${DQ}`],
]

for (const [label, source] of cases) {
  let out
  try {
    out = JSON.stringify(parseEnv(source))
  } catch (error) {
    out = `THROWS ${error.constructor.name}`
  }
  console.log(`${label} ${JSON.stringify(source).padEnd(34)} -> ${out}`)
}
