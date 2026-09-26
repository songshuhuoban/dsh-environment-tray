/**
 * 顺序回放会话日志里的 write + edit，重建文件最终内容。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────────
 *
 * 我把 `clean: true` 加进 tsdown 配置时实现还在 `lib/` 下，构建把
 * `lib/index.js`、`lib/client.js` 等清空了。没有 git，会话日志是唯一完整记录。
 *
 * 单独取"最后一次 write"不够 —— 之后还有若干 `edit`（如 client.js 缺 12 次）。
 * 所以按 seq 顺序回放所有 write/edit 才能得到最终内容。
 *
 * ── 安全原则 ────────────────────────────────────────────────────────────────
 *
 * `edit` 的 `old_string` 必须**恰好出现一次**才应用（与工具本身的契约一致）。
 * 不满足就**报告并跳过**，绝不猜 —— 一个猜错的替换会静默产出坏文件，
 * 而这正是本次事故的成因。
 *
 * 运行：node rebuild-from-session.mjs <session.jsonl> <outDir>
 */

import { createReadStream, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'

const [, , logPath, outDir] = process.argv
if (!logPath || !outDir) {
  console.error('usage: node rebuild-from-session.mjs <session.jsonl> <outDir>')
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })

/** 要重建的路径后缀。 */
const WANTED = [
  'lib/index.js',
  'lib/client.js',
  'lib/env-model.mjs',
  'lib/env-write.mjs',
  'lib/credentials.mjs',
  'lib/registry.mjs',
  'lib/host-api.mjs',
  'lib/write-routes.mjs',
]

/** 收集所有相关操作，按 seq 排序。 */
const ops = []

const rl = createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })
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
  if (typeof args?.file_path !== 'string') continue

  const norm = args.file_path.replace(/\\/g, '/')
  const want = WANTED.find((w) => norm.endsWith('/' + w) || norm === w)
  if (want === undefined) continue

  ops.push({ seq: e.seq ?? 0, kind: d.name, want, args })
}

ops.sort((a, b) => a.seq - b.seq)

/** 每个目标文件的当前状态。 */
const files = new Map()
const problems = []
let appliedWrites = 0
let appliedEdits = 0
let skippedEdits = 0

for (const op of ops) {
  if (op.kind === 'write') {
    if (typeof op.args.content !== 'string') continue
    files.set(op.want, op.args.content)
    appliedWrites += 1
    continue
  }

  // edit：old_string 必须恰好出现一次
  const current = files.get(op.want)
  if (current === undefined) {
    problems.push({ ...op, reason: 'edit before any write in this log' })
    skippedEdits += 1
    continue
  }
  const { old_string: oldStr, new_string: newStr, replace_all: replaceAll } = op.args
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
    problems.push({ ...op, reason: 'missing old_string/new_string' })
    skippedEdits += 1
    continue
  }

  const occurrences = current.split(oldStr).length - 1
  if (occurrences === 0) {
    problems.push({ ...op, reason: 'old_string not found (edit already superseded or content differs)' })
    skippedEdits += 1
    continue
  }
  if (occurrences > 1 && replaceAll !== true) {
    // 工具契约要求唯一；这里按唯一失败处理，不擅自 replace_all
    problems.push({ ...op, reason: `old_string occurs ${String(occurrences)} times and replace_all is not set` })
    skippedEdits += 1
    continue
  }

  files.set(op.want, replaceAll === true ? current.split(oldStr).join(newStr) : current.replace(oldStr, newStr))
  appliedEdits += 1
}

console.log(`操作序列：${String(ops.length)} 个（write ${String(appliedWrites)}，edit 应用 ${String(appliedEdits)}，edit 跳过 ${String(skippedEdits)}）\n`)

for (const want of WANTED) {
  const content = files.get(want)
  if (content === undefined) {
    console.log(`  MISSING    ${want}`)
    continue
  }
  const outPath = join(outDir, basename(want))
  writeFileSync(outPath, content, 'utf8')
  console.log(`  REBUILT    ${want.padEnd(22)} ${String(content.length).padStart(6)} bytes`)
}

if (problems.length > 0) {
  console.log()
  console.log(`⚠ ${String(problems.length)} 个 edit 未能应用（**必须人工核对**）：`)
  for (const p of problems.slice(0, 40)) {
    console.log(`    seq ${String(p.seq).padStart(5)}  ${p.want.padEnd(22)} ${p.reason}`)
  }
  if (problems.length > 40) console.log(`    …还有 ${String(problems.length - 40)} 条`)
}

console.log()
console.log(`输出目录: ${outDir}`)
