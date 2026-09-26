const fs = require('node:fs')
const readline = require('node:readline')

const KINDS = new Map()
let toolCallSample = null
let seq = 0

const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2], 'utf8'), crlfDelay: Infinity })
;(async () => {
  for await (const line of rl) {
    if (line.length < 40) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    KINDS.set(e.type, (KINDS.get(e.type) ?? 0) + 1)

    // 找工具调用：type 里含 tool，或有 name/arguments
    const blob = JSON.stringify(e)
    if (!toolCallSample && /"name"\s*:\s*"(write|edit|str_replace)/.test(blob)) {
      toolCallSample = e
    }
    if (toolCallSample && seq < 3 && /EnvManagerTab/.test(blob)) { seq += 1 }
  }
  console.log('事件类型分布：')
  for (const [k, v] of [...KINDS].sort((a,b)=>b[1]-a[1])) console.log('  ' + String(v).padStart(5) + '  ' + k)
  console.log()
  if (toolCallSample) {
    console.log('工具调用样本（顶层键）：')
    console.log('  ' + Object.keys(toolCallSample).join(', '))
    console.log('  data keys: ' + Object.keys(toolCallSample.data ?? {}).join(', '))
    const msg = toolCallSample.data?.message
    if (msg) {
      console.log('  message.content types: ' + (msg.content ?? []).map((c) => c.type).join(', '))
      for (const c of msg.content ?? []) {
        console.log('    [' + c.type + '] keys: ' + Object.keys(c).join(', '))
        if (c.type === 'tool-call' || c.type === 'tool_use' || c.name) {
          console.log('      name=' + c.name + '  input keys: ' + Object.keys(c.input ?? c.arguments ?? {}).join(', '))
        }
      }
    }
  } else {
    console.log('未找到 write/edit 工具调用样本')
  }
})()
