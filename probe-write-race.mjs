/**
 * 探针：`.env` 写入的并发窗口。
 *
 * 假设：`applyEnvEdits` 是「读 revision（await）→ 校验 → 原子写（await）」，
 * 两个并发请求若都在第一步读到同一 revision，就**都会通过 CAS**，
 * 后者覆盖前者 —— CAS 看似存在，但在同进程内并不排他。
 *
 * 这个脚本直接对库函数施压（不需要起 DSH）：多个 `applyEnvEdits` 同时发车，
 * 带**同一个** expectedRevision，看是否都成功。
 *
 * 运行：node probe-write-race.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { applyEnvEdits, readDotEnvFile } from './lib/env-write.mjs'
import { parseDotEnv } from './lib/env-model.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-race-'))
const dir = join(scratch, 'p')
mkdirSync(dir, { recursive: true })
const file = join(dir, '.env')
writeFileSync(file, 'SEED="1"\n', 'utf8')

const open = await readDotEnvFile(file)
console.log('initial revision :', open.revision)
console.log('initial content  :', JSON.stringify(readFileSync(file, 'utf8')))

// 10 个并发写入，全部带**同一个** expectedRevision，各写不同的键
const N = 10
const results = await Promise.allSettled(
  Array.from({ length: N }, (_v, i) =>
    applyEnvEdits({
      path: file,
      layer: 'project-env',
      expectedRevision: open.revision,
      edits: [{ op: 'set', name: `K${String(i)}`, value: `v${String(i)}` }],
    }),
  ),
)

const fulfilled = results.filter((r) => r.status === 'fulfilled').length
const rejected = results.filter((r) => r.status === 'rejected').length
const reasons = {}
for (const r of results) {
  if (r.status === 'rejected') {
    const code = r.reason?.code ?? r.reason?.name ?? 'unknown'
    reasons[code] = (reasons[code] ?? 0) + 1
  }
}

console.log()
console.log(`并发写入数        : ${N}`)
console.log(`成功              : ${fulfilled}`)
console.log(`被拒              : ${rejected}  ${JSON.stringify(reasons)}`)
console.log()

const finalText = readFileSync(file, 'utf8')
const finalValues = parseDotEnv(finalText)
const survived = Object.keys(finalValues).filter((k) => k !== 'SEED').length

console.log('最终内容          :', JSON.stringify(finalText))
console.log(`最终保留的键      : ${survived} / ${N}`)
console.log()
if (fulfilled > 1 && survived < fulfilled) {
  console.log('❌ 确认存在并发丢失：多个写入都"成功"了，但只有一部分键留下来。')
  console.log('   CAS 在这个窗口下不排他 —— 同一进程内的并发请求会互相覆盖。')
} else if (fulfilled === 1) {
  console.log('✅ CAS 排他：只有一个写入成功，其余被正确拒绝。')
} else {
  console.log(`⚠ 其他形态：成功 ${fulfilled}，存活 ${survived}。需要人看。`)
}

rmSync(scratch, { recursive: true, force: true })
