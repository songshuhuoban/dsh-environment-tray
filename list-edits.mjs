/**
 * 列出 session 里每个 `edit` 调用（路径 + seq），用于判断哪些文件的恢复版本不完整。
 *
 * 运行：node list-edits.mjs <session.jsonl>
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const rl = createInterface({ input: createReadStream(process.argv[2], 'utf8'), crlfDelay: Infinity })

const writes = new Map() // path -> last seq
const edits = [] // { path, seq }

for await (const line of rl) {
  if (!line.includes('"tool/call"')) continue
  let e
  try {
    e = JSON.parse(line)
  } catch {
    continue
  }
  const d = e.data
  if (d?.name !== 'write' && d?.name !== 'edit') continue
  let args
  try {
    args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments
  } catch {
    continue
  }
  const p = args?.file_path
  if (typeof p !== 'string') continue
  const short = p.replace(/\\/g, '/').split('/').slice(-2).join('/')
  if (d.name === 'write') writes.set(short, e.seq ?? 0)
  else edits.push({ path: short, seq: e.seq ?? 0 })
}

console.log('每个文件的最后一次 write 与其后的 edit 次数：\n')
const paths = [...new Set([...writes.keys(), ...edits.map((x) => x.path)])].sort()
for (const p of paths) {
  const w = writes.get(p)
  const after = edits.filter((x) => x.path === p && (w === undefined || x.seq > w))
  const flag = after.length > 0 ? `← 恢复版本缺 ${String(after.length)} 次 edit` : ''
  console.log(
    `  ${p.padEnd(34)} lastWrite=${String(w ?? '-').padStart(5)}  editsAfterWrite=${String(after.length).padStart(3)}  ${flag}`,
  )
}
console.log()
console.log(`（edit 总数 ${String(edits.length)}；一个文件可能被多次 edit，恢复时都需要回放）`)
