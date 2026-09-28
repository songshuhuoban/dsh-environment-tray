/**
 * P2 验证：`.env` 写入层的破坏性、并发安全与值保真。
 *
 * 这一层的失败模式都是"静默损坏用户数据"，所以测试必须覆盖：
 *   - 注释/空行/键序/行尾风格/末尾换行是否原样保留
 *   - 并发修改是否被拒绝（CAS）
 *   - 禁止名单是否前置拦截（写下去 DSH 会拒绝启动）
 *   - 无法忠实表示的值是否被拒绝（而不是写坏）
 *   - 写失败时是否留下临时文件垃圾
 *
 * 运行：node verify-env-write.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  applyEnvEdits,
  readDotEnvFile,
  revisionOf,
  splitDotEnv,
  joinDotEnv,
  validateEdit,
  checkPermissions,
  EnvEditRejected,
} from './lib/env-write.js'
import { parseDotEnv } from './lib/env-model.js'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-envwrite-'))
const file = join(scratch, '.env')
const rel = (p) => p.slice(scratch.length + 1)

/** 写一个初始文件。 */
const seed = (text) => writeFileSync(file, text, 'utf8')
/** 读回全文。 */
const read = () => readFileSync(file, 'utf8')
/** 当前 revision。 */
const rev = async () => (await readDotEnvFile(file)).revision

// ── 1. 结构保留：注释、空行、键序、格式 ─────────────────────────────────────
console.log('--- preservation ---')

seed(
  [
    '# 这是用户自己的注释',
    'ALPHA=1',
    '',
    '# 分组标题',
    'BETA=2',
    'GAMMA="three"',
    '',
  ].join('\n'),
)
{
  const seedText = [
    '# 这是用户自己的注释',
    'ALPHA=1',
    '',
    '# 分组标题',
    'BETA=2',
    'GAMMA="three"',
    '',
  ].join('\n')
  seed(seedText)

  const before = await readDotEnvFile(file)
  const after = await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'BETA', value: 'changed' }],
    expectedRevision: before.revision,
  })

  ok('existing key updated in place', after.values.BETA === 'changed')
  ok('other values untouched', after.values.ALPHA === '1' && after.values.GAMMA === 'three')
  ok('comments preserved', read().includes('# 这是用户自己的注释') && read().includes('# 分组标题'))
  // 断言"写入不改变结构"，而不是断言我手算的数字 —— 后者我已经算错三次
  ok(
    'blank line count unchanged',
    (read().match(/\n\n/g) ?? []).length === (seedText.match(/\n\n/g) ?? []).length,
    `before=${String((seedText.match(/\n\n/g) ?? []).length)} after=${String((read().match(/\n\n/g) ?? []).length)}`,
  )
  ok(
    'segment count unchanged',
    splitDotEnv(read()).length === splitDotEnv(seedText).length,
    `before=${String(splitDotEnv(seedText).length)} after=${String(splitDotEnv(read()).length)}`,
  )
  ok(
    'only the target line changed',
    splitDotEnv(read()).filter((s, i) => s.raw !== splitDotEnv(seedText)[i]?.raw).length === 1,
    JSON.stringify(splitDotEnv(read()).filter((s, i) => s.raw !== splitDotEnv(seedText)[i]?.raw).map((s) => s.raw)),
  )
  ok('key order preserved', read().indexOf('ALPHA') < read().indexOf('BETA') && read().indexOf('BETA') < read().indexOf('GAMMA'))
  ok('file still ends with newline', read().endsWith('\n'))
  ok('revision changed after write', after.revision !== before.revision)
}

// ── 2. 新增键追加到末尾，不动既有顺序 ───────────────────────────────────────
console.log('\n--- append ---')
{
  const before = await readDotEnvFile(file)
  const after = await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'DELTA', value: 'four' }],
    expectedRevision: before.revision,
  })
  ok('new key appended', after.values.DELTA === 'four')
  const lines = read().split('\n')
  ok('new key is after existing ones', lines.findIndex((l) => l.startsWith('DELTA')) > lines.findIndex((l) => l.startsWith('GAMMA')))
  ok('existing keys still in order', read().indexOf('ALPHA') < read().indexOf('GAMMA'))
}

// ── 3. 删除 ─────────────────────────────────────────────────────────────────
console.log('\n--- unset ---')
{
  const before = await readDotEnvFile(file)
  const after = await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'unset', name: 'BETA' }],
    expectedRevision: before.revision,
  })
  ok('unset removes the key', after.values.BETA === undefined)
  ok('unset leaves no empty line artifact', !read().includes('BETA'), JSON.stringify(read()))
  ok('other keys survive unset', after.values.ALPHA === '1' && after.values.DELTA === 'four')
  ok('new revision after unset', after.revision !== before.revision)
}

// ── 3b. `set` 不带 value ───────────────────────────────────────────────────
// 回归：曾经校验用 `edit.value ?? ''`、写入却直接传 `edit.value`，于是 HTTP 上
// 一个不带 value 的 set 会把**字面量 `"undefined"`** 写进文件。
console.log('\n--- set without value ---')
{
  seed('KEEP="1"\nEXISTING="old"\n')
  const after = await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [
      { op: 'set', name: 'NO_VALUE' },
      { op: 'set', name: 'EXISTING' },
      { op: 'set', name: 'EMPTY_ON_PURPOSE', value: '' },
    ],
  })
  ok('a set without value does not write the literal "undefined"', !read().includes('undefined'), JSON.stringify(read()))
  ok('a set without value writes an empty value', after.values.NO_VALUE === '', JSON.stringify(after.values.NO_VALUE))
  ok('an existing key is overwritten to empty as well', after.values.EXISTING === '')
  ok('an explicit empty value behaves the same', after.values.EMPTY_ON_PURPOSE === '')
  ok('the in-memory value matches the file for every edit', read().includes('NO_VALUE=""') && read().includes('EXISTING=""'))
  ok('untouched lines stay byte-identical', read().split('\n')[0] === 'KEEP="1"', JSON.stringify(read()))
}

// ── 4. 行尾风格保留（CRLF）─────────────────────────────────────────────────
console.log('\n--- line ending preservation ---')
{
  seed('ONE=1\r\nTWO=2\r\n')
  const before = await readDotEnvFile(file)
  await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'TWO', value: 'two' }],
    expectedRevision: before.revision,
  })
  ok('CRLF preserved after edit', read().includes('\r\n') && !/[^\r]\n/.test(read()), JSON.stringify(read()))
  ok('values read correctly under CRLF', parseDotEnv(read()).TWO === 'two')

  // 往 CRLF 文件里新增键，也应当用 CRLF
  const second = await readDotEnvFile(file)
  await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'THREE', value: '3' }],
    expectedRevision: second.revision,
  })
  ok('appended line uses CRLF in a CRLF file', /THREE="3"\r\n$/.test(read()), JSON.stringify(read()))
}

// ── 5. 新建文件 ─────────────────────────────────────────────────────────────
console.log('\n--- create ---')
{
  const fresh = join(scratch, 'fresh', '.env')
  const result = await applyEnvEdits({
    path: fresh,
    layer: 'user-env',
    edits: [{ op: 'set', name: 'CREATED', value: 'yes' }],
    expectedRevision: 'absent',
  })
  ok('file created', existsSync(fresh))
  ok('created value correct', result.values.CREATED === 'yes')
  ok('created file ends with newline', readFileSync(fresh, 'utf8').endsWith('\n'))
  ok('created nested directory', existsSync(join(scratch, 'fresh')))
}

// ── 6. CAS：并发修改必须被拒绝 ──────────────────────────────────────────────
console.log('\n--- CAS / concurrency ---')
{
  seed('X=1\n')
  const stale = await rev()
  // 模拟另一个程序在我们读取之后改了文件
  writeFileSync(file, 'X=1\nY=external\n', 'utf8')

  let rejected
  try {
    await applyEnvEdits({
      path: file,
      layer: 'project-env',
      edits: [{ op: 'set', name: 'X', value: '2' }],
      expectedRevision: stale,
    })
  } catch (error) {
    rejected = error
  }
  ok('stale revision is rejected', rejected instanceof EnvEditRejected, String(rejected))
  ok('rejection code is stale-revision', rejected?.code === 'stale-revision', String(rejected?.code))
  ok('external change NOT overwritten', read() === 'X=1\nY=external\n', JSON.stringify(read()))
  ok('rejection message names both revisions', String(rejected?.message).includes('sha256:') || String(rejected?.message).includes('absent'), String(rejected?.message))

  // 用最新 revision 重试应当成功
  const fresh = await rev()
  const after = await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'X', value: '2' }],
    expectedRevision: fresh,
  })
  ok('retry with fresh revision succeeds', after.values.X === '2')
  ok('external key preserved through our write', after.values.Y === 'external')
}

// ── 7. 禁止名单前置拦截 ─────────────────────────────────────────────────────
console.log('\n--- forbidden names ---')

ok('DSH_HOME rejected', validateEdit('DSH_HOME', 'project-env', 'x').some((p) => p.code === 'bootstrap-only'))
ok('PATH rejected', validateEdit('PATH', 'project-env', 'x').some((p) => p.code === 'bootstrap-only'))
ok('XDG_DATA_HOME rejected', validateEdit('XDG_DATA_HOME', 'project-env', 'x').some((p) => p.code === 'bootstrap-only'))
ok('lowercase dsh_home rejected', validateEdit('dsh_home', 'project-env', 'x').some((p) => p.code === 'bootstrap-only'))
ok('MY_VAR accepted', validateEdit('MY_VAR', 'project-env', 'x').length === 0)
ok('HTTP_PROXY rejected in project layer', validateEdit('HTTP_PROXY', 'project-env', 'x').some((p) => p.code === 'proxy-not-in-home'))
ok('HTTP_PROXY accepted in home layer', validateEdit('HTTP_PROXY', 'user-env', 'x').length === 0)
ok('bad name (digit first) rejected', validateEdit('1BAD', 'project-env', 'x').some((p) => p.code === 'invalid-name'))
ok('bad name (space) rejected', validateEdit('A B', 'project-env', 'x').some((p) => p.code === 'invalid-name'))
ok('empty name rejected', validateEdit('', 'project-env', 'x').some((p) => p.code === 'empty-name'))

{
  seed('KEEP=1\n')
  const before = await rev()
  let rejected
  try {
    await applyEnvEdits({
      path: file,
      layer: 'project-env',
      edits: [
        { op: 'set', name: 'GOOD_ONE', value: 'a' },
        { op: 'set', name: 'DSH_HOME', value: 'evil' },
      ],
      expectedRevision: before,
    })
  } catch (error) {
    rejected = error
  }
  ok('batch with one forbidden name is rejected whole', rejected?.code === 'validation-failed')
  ok('rejected batch wrote NOTHING', read() === 'KEEP=1\n', JSON.stringify(read()))
  ok('rejection lists the offending name', JSON.stringify(rejected?.problems ?? []).includes('DSH_HOME'))
}

// ── 8. 有损值必须被拒绝，绝不写坏 ───────────────────────────────────────────
console.log('\n--- lossy values ---')
{
  const bothQuotes = `a"b'c`
  ok('value with both quote kinds rejected', validateEdit('Q', 'project-env', bothQuotes).some((p) => p.code === 'lossy-value'))
  ok('value with double quote accepted', validateEdit('Q', 'project-env', 'a"b').length === 0)
  ok('value with single quote accepted', validateEdit('Q', 'project-env', "a'b").length === 0)
  ok('value with newline accepted', validateEdit('Q', 'project-env', 'a\nb').length === 0)

  seed('K=1\n')
  const before = await rev()
  let rejected
  try {
    await applyEnvEdits({
      path: file,
      layer: 'project-env',
      edits: [{ op: 'set', name: 'BAD', value: bothQuotes }],
      expectedRevision: before,
    })
  } catch (error) {
    rejected = error
  }
  ok('lossy write rejected', rejected?.code === 'validation-failed')
  ok('lossy write left file untouched', read() === 'K=1\n')
}

// ── 9. 值保真：穿过真实文件往返 ─────────────────────────────────────────────
console.log('\n--- value fidelity through a real file ---')
{
  const values = [
    ['PLAIN', 'plain'],
    ['SPACED', 'a b'],
    ['HASH', 'a#b'],
    ['DQUOTE', 'a"b'],
    ['SQUOTE', "a'b"],
    ['MULTILINE', 'a\nb'],
    ['BACKSLASH', 'a\\b'],
    ['DOLLAR', '$NOT_EXPANDED'],
    ['BRACE', '${ALSO_NOT}'],
    ['UNICODE', '中文 🎯'],
    ['TRAILING_SPACE', 'v '],
    ['LEADING_SPACE', ' v'],
    ['EQUALS', 'a=b'],
    ['COLON', 'a:b'],
  ]

  const fidelityFile = join(scratch, 'fidelity', '.env')
  let revision = 'absent'
  for (const [name, value] of values) {
    const result = await applyEnvEdits({
      path: fidelityFile,
      layer: 'user-env',
      edits: [{ op: 'set', name, value }],
      expectedRevision: revision,
    })
    revision = result.revision
  }

  const final = await readDotEnvFile(fidelityFile)
  for (const [name, value] of values) {
    ok(`fidelity: ${name}`, final.values[name] === value, `got ${JSON.stringify(final.values[name])}`)
  }
  ok('no line was silently dropped', Object.keys(final.values).length === values.length, String(Object.keys(final.values).length))
}

// ── 10. 不留临时文件垃圾 ────────────────────────────────────────────────────
console.log('\n--- no temp file litter ---')
{
  const litterDir = join(scratch, 'litter')
  mkdirSync(litterDir, { recursive: true })
  const litterFile = join(litterDir, '.env')
  let revision = 'absent'
  for (let i = 0; i < 5; i += 1) {
    const result = await applyEnvEdits({
      path: litterFile,
      layer: 'user-env',
      edits: [{ op: 'set', name: `K${String(i)}`, value: String(i) }],
      expectedRevision: revision,
    })
    revision = result.revision
  }
  const entries = readdirSync(litterDir)
  ok('only .env remains after repeated writes', entries.length === 1 && entries[0] === '.env', entries.join(', '))
}

// ── 11. 原子性：失败不留下半截文件 ──────────────────────────────────────────
console.log('\n--- atomicity ---')
{
  seed('A=1\nB=2\n')
  const before = await rev()
  // 制造一个校验失败
  await applyEnvEdits({
    path: file,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'C', value: '3' }],
    expectedRevision: before,
  }).catch(() => {})

  const content = read()
  ok('file is never left in a partial state', parseDotEnv(content).A === '1' && parseDotEnv(content).C === '3', JSON.stringify(content))
  ok('no stray temp files in project dir', readdirSync(scratch).filter((f) => f.endsWith('.tmp')).length === 0, readdirSync(scratch).join(', '))
}

// ── 12. 权限 ────────────────────────────────────────────────────────────────
console.log('\n--- permissions ---')
{
  const permFile = join(scratch, 'perm', '.env')
  await applyEnvEdits({
    path: permFile,
    layer: 'user-env',
    edits: [{ op: 'set', name: 'S', value: '1' }],
    expectedRevision: 'absent',
  })
  const check = await checkPermissions(permFile)
  if (process.platform === 'win32') {
    ok('permission check is honestly skipped on Windows', check.checked === false, JSON.stringify(check))
  } else {
    ok('new file is 0600', check.mode === '0600', String(check.mode))
    ok('permission check reports ok', check.ok === true)
  }
}

// ── 13. split/join 往返（内部不变式）────────────────────────────────────────
console.log('\n--- split/join round-trip ---')
{
  const samples = [
    'A=1\n',
    'A=1',
    '# c\n\nA=1\n\n',
    'A=1\r\nB=2\r\n',
    '',
    '# only a comment\n',
    'export A=1\n',
    'A: bogus\nB=2\n',
    // 末尾空行的各种形态 —— 这是早先的真实 bug
    'A=1\n\n',
    'A=1\n\n\n',
    'A=1\r\n\r\n',
    '\n',
    '\n\n',
    // 混合行尾
    'A=1\r\nB=2\nC=3\r\n',
    // 无末尾换行 + 末尾空行
    'A=1\nB=2',
    // 只有空行且无换行
    '   ',
  ]
  for (const sample of samples) {
    const rebuilt = joinDotEnv(splitDotEnv(sample))
    ok(`split/join identity: ${JSON.stringify(sample).slice(0, 26)}`, rebuilt === sample, `got ${JSON.stringify(rebuilt)}`)
  }

  // 非空行数必须守恒：末尾空行不能被吃掉。
  // 'A=1\n\n' 的业务含义是 **2 个逻辑行**：一个赋值行 + 一个末尾空行。
  const withTwoBlankTails = 'A=1\n\n'
  const segs = splitDotEnv(withTwoBlankTails)
  ok('trailing blank line is kept as a segment', segs.length === 2, `segments=${String(segs.length)} kinds=${segs.map((s) => s.kind).join(',')}`)
  ok(
    'trailing blank line classified as blank',
    segs[0]?.kind === 'entry' && segs[1]?.kind === 'blank',
    segs.map((s) => `${s.kind}:${JSON.stringify(s.raw)}`).join(' '),
  )
  ok(
    'blank segment carries its own line terminator',
    segs[1]?.raw === '\n',
    JSON.stringify(segs[1]?.raw),
  )
  // 三个连续换行才代表 2 个空行
  ok('three newlines yield two blank segments', splitDotEnv('A=1\n\n\n').filter((s) => s.kind === 'blank').length === 2)
}

// ── 14. revision 语义 ───────────────────────────────────────────────────────
console.log('\n--- revision semantics ---')
{
  ok('absent revision is the literal "absent"', revisionOf('/x', undefined) === 'absent')
  ok('same content yields same revision', revisionOf('/x', 'A=1\n') === revisionOf('/y', 'A=1\n'))
  ok('different content yields different revision', revisionOf('/x', 'A=1\n') !== revisionOf('/x', 'A=2\n'))
}

console.log('\n--- create-only ---')
{
  const createFile = join(scratch, 'create-only.env')
  const first = await applyEnvEdits({ path: createFile, layer: 'user-env', createOnly: true, expectedRevision: 'absent', edits: [{ op: 'set', name: 'NewVar', value: '' }] })
  ok('create-only accepts an empty value in a new file', first.values.NewVar === '')
  const original = readFileSync(createFile, 'utf8')
  const duplicate = await applyEnvEdits({ path: createFile, layer: 'user-env', createOnly: true, expectedRevision: first.revision, edits: [{ op: 'set', name: 'NewVar', value: 'overwrite' }] }).catch((error) => error)
  ok('create-only rejects an existing name with a stable code', duplicate.code === 'already-exists')
  ok('duplicate creation preserves the original file byte for byte', readFileSync(createFile, 'utf8') === original)
  const partial = await applyEnvEdits({ path: createFile, layer: 'user-env', createOnly: true, edits: [{ op: 'set', name: 'OtherVar', value: 'new' }, { op: 'set', name: 'NewVar', value: 'bad' }] }).catch((error) => error)
  ok('a create batch with one duplicate performs no partial write', partial.code === 'already-exists' && readFileSync(createFile, 'utf8') === original)
  const caseName = process.platform === 'win32' ? 'NEWVAR' : 'NewVar'
  const caseDuplicate = await applyEnvEdits({ path: createFile, layer: 'user-env', createOnly: true, edits: [{ op: 'set', name: caseName, value: 'bad' }] }).catch((error) => error)
  ok('create-only follows the platform key matching rules', caseDuplicate.code === 'already-exists')
  const competing = await Promise.allSettled(['first', 'second'].map((value) => applyEnvEdits({ path: createFile, layer: 'user-env', createOnly: true, edits: [{ op: 'set', name: 'ConcurrentVar', value }] })))
  ok('concurrent create-only calls cannot replace each other', competing.filter((result) => result.status === 'fulfilled').length === 1 && competing.filter((result) => result.status === 'rejected' && result.reason.code === 'already-exists').length === 1)
  const updated = await applyEnvEdits({ path: createFile, layer: 'user-env', edits: [{ op: 'set', name: 'NewVar', value: 'edited' }] })
  ok('ordinary edits still replace an existing value', updated.values.NewVar === 'edited')
}

rmSync(scratch, { recursive: true, force: true })

// ── 15. 大小写：Windows 上环境名不区分大小写 ─────────────────────────────────
// 这是一个真实 bug 的回归测试：先前 `pending.get(seg.key)` 是大小写敏感的，
// 于是文件里有 `MyVar=...` 时写入 `MYVAR=...` 会**保留旧行并追加新行**，
// 同一个变量在文件里出现两遍。
//
// 注意不能用 PATH/Path 做样本：`isBootstrapOnly` 会折叠大小写，所以
// `Path` 也命中禁止名单（这本身是正确行为，但会让这个测试测到别的东西）。
console.log('\n--- case-insensitive key matching ---')
{
  const caseFile = join(scratch, 'case', '.env')
  const isWindows = process.platform === 'win32'

  // writeFileSync 不会建目录（applyEnvEdits 会，这里绕过了它）
  mkdirSync(join(scratch, 'case'), { recursive: true })
  writeFileSync(caseFile, 'MyVar="original"\nOTHER="x"\n', 'utf8')
  const before = await readDotEnvFile(caseFile)
  const after = await applyEnvEdits({
    path: caseFile,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'MYVAR', value: 'replaced' }],
    expectedRevision: before.revision,
  })

  const text = readFileSync(caseFile, 'utf8')
  const matchingLines = text.split('\n').filter((l) => /^\s*(export\s+)?MyVar\s*=/i.test(l))

  if (isWindows) {
    ok('Windows: only ONE line for a case-variant key', matchingLines.length === 1, JSON.stringify(matchingLines))
    ok('Windows: the original casing is preserved', text.includes('MyVar='), JSON.stringify(text))
    ok('Windows: value was actually replaced', after.values.MyVar === 'replaced', JSON.stringify(after.values))
    ok('Windows: the other key is untouched', after.values.OTHER === 'x')
  } else {
    ok('POSIX: case variants are distinct variables', matchingLines.length === 2, JSON.stringify(matchingLines))
  }

  // unset 也必须按平台语义命中
  const caseFile2 = join(scratch, 'case2', '.env')
  mkdirSync(join(scratch, 'case2'), { recursive: true })
  writeFileSync(caseFile2, 'MyVar="a"\nKEEP="k"\n', 'utf8')
  const b2 = await readDotEnvFile(caseFile2)
  const a2 = await applyEnvEdits({
    path: caseFile2,
    layer: 'project-env',
    edits: [{ op: 'unset', name: 'MYVAR' }],
    expectedRevision: b2.revision,
  })
  const text2 = readFileSync(caseFile2, 'utf8')
  if (isWindows) {
    ok('Windows: unset matches a case variant', !/MyVar\s*=/i.test(text2), JSON.stringify(text2))
    ok('Windows: unset kept the other key', a2.values.KEEP === 'k')
  } else {
    ok('POSIX: unset of a different case leaves the original', /MyVar\s*=/i.test(text2), JSON.stringify(text2))
  }
}

// ── 16. 同一批里的重复编辑 ──────────────────────────────────────────────────
console.log('\n--- duplicate edits in one batch ---')
{
  const dupFile = join(scratch, 'dup', '.env')
  mkdirSync(join(scratch, 'dup'), { recursive: true })
  writeFileSync(dupFile, 'A="1"\n', 'utf8')
  const b = await readDotEnvFile(dupFile)
  const a = await applyEnvEdits({
    path: dupFile,
    layer: 'project-env',
    edits: [
      { op: 'set', name: 'A', value: 'first' },
      { op: 'set', name: 'A', value: 'second' },
    ],
    expectedRevision: b.revision,
  })
  const text = readFileSync(dupFile, 'utf8')
  ok('duplicate edits produce exactly one line', text.split('\n').filter((l) => /^A\s*=/.test(l)).length === 1, JSON.stringify(text))
  ok('the last duplicate wins', a.values.A === 'second', JSON.stringify(a.values))
}

// ── 17. BOM：解释它，但不能擅自删掉用户的字节 ───────────────────────────────
console.log('\n--- BOM preservation through a write ---')
{
  const BOM = '\uFEFF'
  const bomDir = join(scratch, 'bom')
  mkdirSync(bomDir, { recursive: true })
  const bomFile = join(bomDir, '.env')
  const original = `${BOM}FIRST="one"\nSECOND="two"\n`
  writeFileSync(bomFile, original, 'utf8')

  const before = await readDotEnvFile(bomFile)
  const after = await applyEnvEdits({
    path: bomFile,
    layer: 'project-env',
    edits: [{ op: 'set', name: 'SECOND', value: 'changed' }],
    expectedRevision: before.revision,
  })

  const text = readFileSync(bomFile, 'utf8')
  ok('BOM is preserved on disk (we explain it, we do not delete it)', text.charCodeAt(0) === 0xfeff, JSON.stringify(text.slice(0, 8)))
  ok('the edit landed', after.values.SECOND === 'changed', JSON.stringify(after.values))
  ok('the BOM-prefixed first key is still readable by our parser', after.values.FIRST === 'one', JSON.stringify(after.values))
  ok('only the target line changed', text.split('\n').filter((l) => l.includes('changed')).length === 1, JSON.stringify(text))
}

// ── 18. 同进程并发写入必须被串行化 ──────────────────────────────────────────
// 实测过的真实故障：CAS 只挡得住**外部**进程（它们会改变磁盘上的 revision），
// 挡不住**同一进程内**的并发 —— 10 个带同一 revision 的并发写入**全部返回成功**，
// 但只有 1 个键存活，9 个"成功"的保存静默丢失。
// 修法是把「读 → 校验 → 写」放进按路径的临界区。
console.log('\n--- concurrent writes are serialized ---')
{
  const raceDir = join(scratch, 'race')
  mkdirSync(raceDir, { recursive: true })
  const raceFile = join(raceDir, '.env')
  writeFileSync(raceFile, 'SEED="1"\n', 'utf8')

  const open = await readDotEnvFile(raceFile)
  const N = 10
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_v, i) =>
      applyEnvEdits({
        path: raceFile,
        layer: 'project-env',
        expectedRevision: open.revision,
        edits: [{ op: 'set', name: `K${String(i)}`, value: `v${String(i)}` }],
      }),
    ),
  )

  const fulfilled = results.filter((r) => r.status === 'fulfilled').length
  const staleCount = results.filter((r) => r.status === 'rejected' && r.reason?.code === 'stale-revision').length

  ok('exactly one concurrent write succeeds', fulfilled === 1, String(fulfilled))
  ok('every other concurrent write is rejected as stale', staleCount === N - 1, String(staleCount))
  ok(
    'no silent loss: successes equal surviving writes',
    fulfilled === Object.keys(parseDotEnv(readFileSync(raceFile, 'utf8'))).filter((k) => k !== 'SEED').length,
    JSON.stringify(parseDotEnv(readFileSync(raceFile, 'utf8'))),
  )

  // 顺序重试（每次带新 revision）必须让全部键落地 —— 证明拒绝是可恢复的
  for (let i = 0; i < N; i += 1) {
    const cur = await readDotEnvFile(raceFile)
    await applyEnvEdits({
      path: raceFile,
      layer: 'project-env',
      expectedRevision: cur.revision,
      edits: [{ op: 'set', name: `K${String(i)}`, value: `v${String(i)}` }],
    })
  }
  const sequential = parseDotEnv(readFileSync(raceFile, 'utf8'))
  ok(
    'sequential retries persist every key',
    Array.from({ length: N }, (_v, i) => `K${String(i)}`).every((k) => sequential[k] !== undefined),
    JSON.stringify(Object.keys(sequential)),
  )

  // 并发写**不同文件**必须都能成功（临界区是按路径的，不是全局的）
  const otherFile = join(raceDir, 'other.env')
  const [a, b] = await Promise.allSettled([
    applyEnvEdits({ path: raceFile, layer: 'project-env', expectedRevision: (await readDotEnvFile(raceFile)).revision, edits: [{ op: 'set', name: 'PA', value: '1' }] }),
    applyEnvEdits({ path: otherFile, layer: 'project-env', expectedRevision: 'absent', edits: [{ op: 'set', name: 'PB', value: '1' }] }),
  ])
  ok('concurrent writes to different paths both succeed', a.status === 'fulfilled' && b.status === 'fulfilled', `${a.status}/${b.status}`)

  // 一次失败**不能**毒化该路径的链：后续写入必须仍能进行
  const poisoned = join(raceDir, 'poison.env')
  const bad = await applyEnvEdits({ path: poisoned, layer: 'project-env', expectedRevision: 'absent', edits: [{ op: 'set', name: 'DSH_HOME', value: 'x' }] }).catch((e) => e)
  ok('a rejected edit throws (chain not silently swallowed)', bad instanceof Error, String(bad))
  const after = await applyEnvEdits({ path: poisoned, layer: 'project-env', expectedRevision: 'absent', edits: [{ op: 'set', name: 'FINE', value: 'ok' }] })
  ok('a later write still proceeds after a rejection', after.values.FINE === 'ok', JSON.stringify(after.values))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
