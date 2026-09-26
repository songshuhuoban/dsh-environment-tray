/**
 * 从会话日志里恢复被构建覆盖的源文件。
 *
 * ── 背景（这是一个我造成的失误）─────────────────────────────────────────────
 *
 * 我把 `clean: true` 加进 tsdown 配置时，实现还在 `lib/` 下、尚未迁进 `src/`，
 * 于是构建把 `lib/index.js`（宿主实现）与 `lib/client.js`（32KB UI）都清空了。
 * 没有 git 仓库，`.backup/` 里只有 profile 配置 —— 会话日志是唯一的完整记录。
 *
 * ── 日志结构（实测，不是猜的）───────────────────────────────────────────────
 *
 * JSONL，每行一个事件。工具调用是 `{"type":"tool/call","data":{name, arguments}}`，
 * 其中 `arguments` 是**JSON 字符串**，`write` 调用里含 `file_path` 与 `content`。
 *
 * 取每个路径的**最后一次 write**（不是最长）—— 因为我后来可能写过更短的修订版。
 *
 * 运行：node recover-from-session.mjs <session.jsonl> <outDir>
 */

import { createReadStream, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'

const [, , logPath, outDir] = process.argv
if (!logPath || !outDir) {
  console.error('usage: node recover-from-session.mjs <session.jsonl> <outDir>')
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })

/** 想恢复的路径后缀（匹配用）。 */
const WANTED = [
  'lib/index.js',
  'lib/client.js',
  'lib/env-model.mjs',
  'lib/env-write.mjs',
  'lib/credentials.mjs',
  'lib/registry.mjs',
  'lib/host-api.mjs',
  'lib/write-routes.mjs',
  'cordis.patch.yml',
  'preflight.mjs',
]

/** want → { path, content, seq }（按 seq 覆盖，保留最后一次） */
const latest = new Map()

const rl = createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })
let lines = 0
let calls = 0

for await (const line of rl) {
  lines += 1
  if (!line.includes('"tool/call"')) continue

  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const data = event.data
  if (data?.name !== 'write') continue
  calls += 1

  let args
  try {
    args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments
  } catch {
    continue
  }
  const filePath = args?.file_path
  const content = args?.content
  if (typeof filePath !== 'string' || typeof content !== 'string') continue

  const norm = filePath.replace(/\\/g, '/')
  for (const want of WANTED) {
    if (norm.endsWith('/' + want) || norm === want) {
      const prev = latest.get(want)
      // 按事件顺序取最后一次（seq 单调递增）
      if (prev === undefined || (event.seq ?? 0) >= (prev.seq ?? 0)) {
        latest.set(want, { path: filePath, content, seq: event.seq ?? 0 })
      }
    }
  }
}

console.log(`扫描 ${String(lines)} 行；write 调用 ${String(calls)} 次\n`)

let recovered = 0
for (const want of WANTED) {
  const hit = latest.get(want)
  if (hit === undefined) {
    console.log(`  MISSING    ${want}`)
    continue
  }
  const outPath = join(outDir, basename(want))
  writeFileSync(outPath, hit.content, 'utf8')
  recovered += 1
  console.log(
    `  RECOVERED  ${want.padEnd(22)} ${String(hit.content.length).padStart(6)} bytes  (seq ${String(hit.seq)})`,
  )
}

console.log()
console.log(`恢复 ${String(recovered)}/${String(WANTED.length)} 个文件 → ${outDir}`)
console.log()
console.log('**注意**：这是最后一次 `write` 的内容。若之后用 `edit` 改过该文件，')
console.log('  恢复出来的版本会缺那些改动 —— 必须逐个核对，不要直接当成最终版。')
