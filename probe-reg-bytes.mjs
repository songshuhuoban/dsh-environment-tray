/**
 * 探针：`reg.exe query` 的原始字节到底长什么样。
 *
 * 我的解析器一个值都没解析出来，而肉眼看输出是标准 4 空格分隔。
 * 所以问题在字节层（行尾、代码页、尾随空格），必须看原始数据。
 *
 * 运行：node probe-reg-bytes.mjs
 */

import { execFileSync } from 'node:child_process'

const buffer = execFileSync('reg.exe', ['query', 'HKCU\\Environment'], { windowsHide: true })
console.log('bytes:', buffer.length)

const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
const lines = text.split(/\r?\n/)
console.log('lines:', lines.length)

for (const [i, line] of lines.slice(0, 6).entries()) {
  console.log(`\n[${String(i)}] len=${String(line.length)}`)
  console.log('  raw :', JSON.stringify(line))
  console.log('  vis :', line.replace(/ /g, '·').replace(/\t/g, '→'))

  // 打印分隔处附近的字符码，确认到底是不是空格
  const m = /(REG_[A-Z_]+)/.exec(line)
  if (m) {
    const at = m.index
    console.log('  around REG_:', JSON.stringify(line.slice(Math.max(0, at - 6), at + m[0].length + 6)))
    console.log(
      '  codes     :',
      line
        .slice(Math.max(0, at - 5), at + m[0].length + 4)
        .split('')
        .map((c) => c.charCodeAt(0))
        .join(','),
    )
  }

  // 我的正则是否匹配？
  const mine = /^\s{4}(.*?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line)
  console.log('  regex match:', mine === null ? 'NO' : JSON.stringify([mine[1], mine[2], mine[3]]))
}
