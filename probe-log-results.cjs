const fs = require('node:fs')
const readline = require('node:readline')

const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2], 'utf8'), crlfDelay: Infinity })
;(async () => {
  const byCall = new Map()
  for await (const line of rl) {
    if (!line.includes('"tool/result"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'tool/result') continue
    const d = e.data ?? {}
    byCall.set(d.callId, d)
  }
  console.log('tool/result 数量:', byCall.size)
  const first = [...byCall.values()][0]
  console.log('样本 data keys:', Object.keys(first ?? {}).join(', '))
  console.log(JSON.stringify(first, null, 2).slice(0, 800))
  // 找含 client.js 且提到 line 的结果
  for (const d of byCall.values()) {
    const blob = JSON.stringify(d)
    if (blob.includes('client.js') && blob.includes('line')) {
      console.log()
      console.log('一个涉及 client.js 的结果：')
      console.log(JSON.stringify(d, null, 2).slice(0, 700))
      break
    }
  }
})()
