const fs = require('node:fs')
const readline = require('node:readline')

const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2], 'utf8'), crlfDelay: Infinity })
;(async () => {
  const names = new Map()
  let sample = null
  let writeSample = null
  for await (const line of rl) {
    if (!line.includes('"tool/call"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'tool/call') continue
    const d = e.data ?? {}
    const name = d.name ?? d.tool ?? d.header?.name ?? '(unknown)'
    names.set(name, (names.get(name) ?? 0) + 1)
    if (sample === null) sample = e
    if (writeSample === null && /write|edit|str_replace/i.test(String(name))) writeSample = e
  }
  console.log('工具调用名字分布：')
  for (const [k, v] of [...names].sort((a,b)=>b[1]-a[1])) console.log('  ' + String(v).padStart(5) + '  ' + k)
  console.log()
  const show = writeSample ?? sample
  console.log('样本事件 data 结构：')
  console.log('  data keys: ' + Object.keys(show.data ?? {}).join(', '))
  console.log(JSON.stringify(show.data, null, 2).slice(0, 900))
})()
