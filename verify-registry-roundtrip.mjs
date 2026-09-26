/**
 * 往返测试：真的写一次注册表、读回来、再删掉。
 *
 * 用自建变量名 `DSH_ENV_MANAGER_RTT_<pid>`，测试后**无条件清理**（含失败路径），
 * 不留残留。这是验证写入路径唯一可信的方式 —— 假执行器只能证明命令行拼对了，
 * 证明不了 `reg.exe` 真的接受它。
 *
 * 同时观察一件事：`reg.exe add` **不会**广播 `WM_SETTINGCHANGE`，
 * 这对 UI 文案有直接影响（见设计文档 §2.1）。
 *
 * 运行：node verify-registry-roundtrip.mjs
 */

import { execFileSync } from 'node:child_process'
import { OsEnvironmentLayer, USER_SCOPE } from './lib/registry.mjs'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const NAME = `DSH_ENV_MANAGER_RTT_${String(process.pid)}`
const PLAIN_VALUE = 'rtt-plain-value'
const EXPAND_VALUE = '%USERPROFILE%\\rtt-bin'

const run = async (args) => {
  const buffer = execFileSync('reg.exe', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return buffer
}
const layer = new OsEnvironmentLayer({ run, platform: 'win32' })

/** 无条件删除我们的测试值。 */
function cleanup() {
  try {
    execFileSync('reg.exe', ['delete', 'HKCU\\Environment', '/v', NAME, '/f'], { windowsHide: true, stdio: 'ignore' })
    return true
  } catch {
    // 不存在时 reg delete 返回非零，属预期
    return false
  }
}

/** 直接读注册表，绕过我们的层，作为独立对照。 */
function readRaw(name) {
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true }).toString('utf8')
    const m = /REG_[A-Z_]+\s+(.*)/.exec(out)
    return m ? m[1].trim() : undefined
  } catch {
    return undefined
  }
}

cleanup()
ok('precondition: test value does not exist', readRaw(NAME) === undefined)

try {
  // ── 1. REG_SZ 往返 ────────────────────────────────────────────────────────
  const wrote1 = await layer.write(USER_SCOPE, NAME, PLAIN_VALUE, 'REG_SZ')
  ok('REG_SZ write reports success', wrote1.ok === true, JSON.stringify(wrote1))
  ok('independent readback matches', readRaw(NAME) === PLAIN_VALUE, JSON.stringify(readRaw(NAME)))

  const read1 = await layer.read(USER_SCOPE)
  const entry1 = read1.entries.find((e) => e.name === NAME)
  ok('our layer reads the value back', entry1?.value === PLAIN_VALUE, JSON.stringify(entry1))
  ok('type is REG_SZ as requested', entry1?.type === 'REG_SZ', String(entry1?.type))

  // ── 2. REG_EXPAND_SZ 类型保留（关键：写坏会破坏 %VAR%）───────────────────
  const wrote2 = await layer.write(USER_SCOPE, NAME, EXPAND_VALUE, 'REG_EXPAND_SZ')
  ok('REG_EXPAND_SZ write reports success', wrote2.ok === true, JSON.stringify(wrote2))
  ok('type is preserved as REG_EXPAND_SZ', wrote2.type === 'REG_EXPAND_SZ', String(wrote2.type))

  const read2 = await layer.read(USER_SCOPE)
  const entry2 = read2.entries.find((e) => e.name === NAME)
  ok('readback reports REG_EXPAND_SZ', entry2?.type === 'REG_EXPAND_SZ', String(entry2?.type))
  ok(
    'the %VAR% text survives unexpanded in the registry',
    entry2?.value === EXPAND_VALUE,
    `${JSON.stringify(entry2?.value)} (expected ${JSON.stringify(EXPAND_VALUE)})`,
  )

  // 独立对照：reg query 单值形式会**展开** %USERPROFILE%，所以只能比对类型行
  const rawLine = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', NAME], { windowsHide: true }).toString('utf8')
  ok('raw query confirms REG_EXPAND_SZ on disk', rawLine.includes('REG_EXPAND_SZ'), rawLine.trim().split(/\r?\n/).pop().trim())

  // ── 3. 删除 ───────────────────────────────────────────────────────────────
  const removed = await layer.remove(USER_SCOPE, NAME)
  ok('remove reports success', removed.ok === true, JSON.stringify(removed))
  ok('value is gone from the registry', readRaw(NAME) === undefined)

  const read3 = await layer.read(USER_SCOPE)
  ok('our layer no longer lists it', !read3.entries.some((e) => e.name === NAME))

  // ── 3b. 删除必须带备份，且撤销要能真的恢复 ────────────────────────────────
  // 删除注册表值没有回收站，这是用户唯一的挽回途径，所以必须在真注册表上验证。
  ok('remove captured the original value', removed.removed?.value === EXPAND_VALUE, JSON.stringify(removed.removed))
  ok('remove captured the original type', removed.removed?.type === 'REG_EXPAND_SZ', String(removed.removed?.type))

  const undone = await layer.write(USER_SCOPE, removed.removed.name, removed.removed.value, removed.removed.type)
  ok('undo write reports success', undone.ok === true, JSON.stringify(undone))
  ok('undo restored the type on disk', undone.type === 'REG_EXPAND_SZ', String(undone.type))

  const readUndone = await layer.read(USER_SCOPE)
  const entryUndone = readUndone.entries.find((e) => e.name === NAME)
  ok('undo restored the exact value', entryUndone?.value === EXPAND_VALUE, JSON.stringify(entryUndone))
  ok('undo restored the type', entryUndone?.type === 'REG_EXPAND_SZ', String(entryUndone?.type))

  // 再删一次，回到干净状态
  const removed2 = await layer.remove(USER_SCOPE, NAME)
  ok('second removal also succeeds', removed2.ok === true)
  ok('value gone again', readRaw(NAME) === undefined)

  // ── 4. 删除不存在的值必须被转述为失败（不静默成功）──────────────────────
  const removedAgain = await layer.remove(USER_SCOPE, NAME)
  ok('removing an absent value reports failure rather than faking success', removedAgain.ok === false, JSON.stringify(removedAgain))
  ok('a removal with no backup says so honestly', removedAgain.ok === false)
} finally {
  const cleaned = cleanup()
  console.log(`\n(cleanup ran; value ${cleaned ? 'removed' : 'was already absent'})`)
}

// ── 5. 最终确认无残留 ───────────────────────────────────────────────────────
ok('no residue left in HKCU\\Environment', readRaw(NAME) === undefined, String(readRaw(NAME)))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
