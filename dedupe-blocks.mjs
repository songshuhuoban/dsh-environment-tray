/**
 * 删除重建产物里被重复插入的连续块。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────────
 *
 * 从会话日志回放 write+edit 重建文件时，`lib/env-model.mjs` 的头部被重复插入
 * 了两次（三份 import 头）。原因是某个 edit 的边界在我回放时对不齐 ——
 * 这正是"用日志重建"这种手段的固有风险，所以**必须逐项核对**，
 * 而核对手段就是 `node --check` 加上跑原来的断言套件。
 *
 * 本脚本只做一件保守的事：找出**完全相同的连续行块**，保留第一份、删除后续重复，
 * 然后报告删了什么。不做任何推测性修改。
 *
 * 运行：node dedupe-blocks.mjs <file> [minBlockLines]
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [, , file, minArg] = process.argv
if (!file) {
  console.error('usage: node dedupe-blocks.mjs <file> [minBlockLines=8]')
  process.exit(2)
}

const minBlock = Number(minArg ?? 8)
const lines = readFileSync(file, 'utf8').split('\n')

let removed = 0
let changed = true

// 反复扫描，直到没有可删的重复块（一次删除可能让新的重复浮现）
while (changed) {
  changed = false

  for (let i = 0; i < lines.length && !changed; i += 1) {
    for (let len = Math.min(400, lines.length - i); len >= minBlock && !changed; len -= 1) {
      const block = lines.slice(i, i + len)
      // 块内不能全是空行（那会误删正常空行）
      if (block.every((l) => l.trim().length === 0)) continue

      // 在第一份之后寻找完全相同的块
      for (let j = i + 1; j + len <= lines.length; j += 1) {
        let same = true
        for (let k = 0; k < len; k += 1) {
          if (lines[j + k] !== block[k]) {
            same = false
            break
          }
        }
        if (!same) continue

        // 删除 [j, j+len)
        lines.splice(j, len)
        removed += len
        changed = true
        console.log(`  删除重复块：原位置 ${String(j + 1)}，长度 ${String(len)} 行（与位置 ${String(i + 1)} 相同）`)
        break
      }
    }
  }
}

writeFileSync(file, lines.join('\n'), 'utf8')
console.log()
console.log(removed === 0 ? '未发现重复块' : `共删除 ${String(removed)} 行`)
