/**
 * 探针：`node:util.parseEnv` 的双引号转义到底支持什么。
 *
 * 差分测试暴露了我的解析器与 Node 不一致。转义语义必须按实测修，
 * 不能按文档或直觉猜。这个脚本只负责把真相打出来。
 *
 * 运行：node probe-parseenv-escapes.mjs
 */

import { parseEnv } from 'node:util'

console.log('node', process.version)

const cases = [
  // 注释截断
  ['hash at value start        ', 'Q=#x'],
  ['hash no preceding space    ', 'Q=a#b'],
  ['hash with preceding space  ', 'Q=a #b'],
  ['hash after only space      ', 'Q= #b'],
  ['hash in quotes             ', 'Q="a#b"'],

  // 双引号转义
  ['backslash-quote            ', 'S="he said \\"hi\\""'],
  ['backslash-backslash        ', 'T="a\\\\b"'],
  ['backslash-n                ', 'W="a\\nb"'],
  ['backslash-t                ', 'W="a\\tb"'],
  ['backslash-r                ', 'W="a\\rb"'],
  ['backslash-f                ', 'W="a\\fb"'],
  ['backslash-v                ', 'W="a\\vb"'],
  ['backslash-0                ', 'W="a\\0b"'],
  ['backslash-dollar          ', 'W="a\\$b"'],
  ['backslash-x                ', 'W="a\\xb"'],
  ['backslash-u                ', 'W="a\\u0041b"'],
  ['lone backslash at end      ', 'W="a\\\\"'],
  ['raw newline inside quotes  ', 'W="a\nb"'],

  // 单引号
  ['single: backslash-n        ', "W='a\\nb'"],
  ['single: backslash-quote    ', "W='a\\'b'"],

  // 键的处理
  ['quoted key dquote          ', '"K"=v'],
  ['quoted key squote          ', "'K'=v"],
  ['key with inner spaces      ', 'A B=v'],
  ['key with tab               ', 'A\tB=v'],

  // 无引号值的边界
  ['unquoted trailing space    ', 'K=v   '],
  ['unquoted inner space       ', 'K=a b'],
  ['unquoted backslash         ', 'K=a\\b'],
  ['value only spaces          ', 'K=   '],
]

for (const [label, source] of cases) {
  try {
    const result = parseEnv(source)
    // 用可见字符打印，避免转义看不出差别
    const shown = JSON.stringify(result)
    console.log(`${label} ${source.replace(/\n/g, '\\n').padEnd(24)} -> ${shown}`)
  } catch (error) {
    console.log(`${label} ${source.replace(/\n/g, '\\n').padEnd(24)} -> THROWS ${error.constructor.name}`)
  }
}
