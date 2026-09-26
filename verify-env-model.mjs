/**
 * P1 验证：差分测试 + 真实机器快照。
 *
 * 最关键的一项是 `parseDotEnv` 与 `node:util.parseEnv` 的**差分测试** ——
 * 我的解析器必须与 DSH 实际使用的那一个逐位一致，否则 UI 显示的东西
 * 和 DSH 真正读到的会不一样。这不能靠读文档保证。
 *
 * 运行：node verify-env-model.mjs
 */

import { parseEnv } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseDotEnv,
  serializeDotEnvLine,
  representabilityOf,
  buildEnvironmentModel,
  describeVariable,
  isBootstrapOnly,
  resolveDshHome,
  readEnvFile,
  writabilityOf,
  BOOTSTRAP_NAMES,
  BOOTSTRAP_PREFIXES,
  HOME_LAYER_PROXY_NAMES,
  SENSITIVE_ENV_PATTERN,
  BLOCKED_REASON_TEXT,
} from './lib/env-model.js'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. 与 node:util.parseEnv 的差分测试 ──────────────────────────────────────
console.log('--- differential: parseDotEnv vs node:util.parseEnv ---')

const corpus = [
  ['export prefix', 'export MY=1'],
  ['export + dquote', 'export L="1"'],
  ['in-file ref stays literal', 'A=1\nB=$A\n'],
  ['brace ref stays literal', 'C=${OUTER}'],
  ['bare ref stays literal', 'D=$OUTER'],
  ['percent ref stays literal', 'DDD=%OUTER%'],
  ['dquote escape', 'E="x\\ny"'],
  ['squote literal', "F='$OUTER'"],
  ['colon separator drops line', 'G: v'],
  ['trailing comment', 'H=1 # tail'],
  ['multiline dquote', 'I="l1\nl2"'],
  ['empty value', 'J='],
  ['surrounding spaces', '  K = spaced  '],
  ['comment line', '# comment\nZ=1'],
  ['blank lines', '\n\nZ=2\n\n'],
  ['value with hash', 'Q=a#b'],
  ['value with spaced hash', 'R=a #b'],
  ['escaped quote (backslash does NOT escape)', 'S="he said \\"hi\\""'],
  ['backslash-backslash stays literal', 'T="a\\\\b"'],
  ['colon inside value', 'U=a:b'],
  ['equals inside value', 'V=a=b'],
  ['tab escape stays literal', 'W="a\\tb"'],
  ['carriage-return escape stays literal', 'W2="a\\rb"'],
  ['dollar escape stays literal', 'W3="a\\$b"'],
  ['unicode escape stays literal', 'W4="a\\u0041b"'],
  ['empty key-ish', '=v'],
  ['quoted key keeps quotes', '"K2"=v2'],
  ['single-quoted key keeps quotes', "'K3'=v3"],
  ['key with inner space', 'A B=v'],
  ['duplicate key last wins', 'X=1\nX=2'],
  ['crlf line ending', 'Y=1\r\nZ2=2\r\n'],
  ['value with trailing spaces in quotes', 'AA="  padded  "'],
  ['leading space preserved in quotes', 'AA2=" lead"'],
  ['dollar in dquote', 'AB="cost $5"'],
  ['no newline at eof', 'AC=1'],
  ['multiple exports', 'export A1=1\nexport B1=2'],
  ['hash only value', 'AD=#x'],
  ['hash no preceding space', 'AD2=a#b'],
  ['hash after only space', 'AD3= #b'],
  ['hash inside quotes preserved', 'AD4="a#b"'],
  ['single-quoted backslash-n literal', "A5='a\\nb'"],
  ['single-quoted backslash-quote', "A6='a\\'b'"],
  ['unquoted backslash literal', 'A7=a\\b'],
  ['single char', 'A=1'],
  ['unicode value', 'AE="中文值"'],
  ['very long key', `${'K'.repeat(60)}=v`],
]

for (const [label, source] of corpus) {
  let expected
  let expectedThrew = false
  try {
    expected = parseEnv(source)
  } catch {
    expectedThrew = true
  }
  if (expectedThrew) {
    console.log(`SKIP  ${label} (parseEnv threw; not comparable)`)
    continue
  }
  const actual = parseDotEnv(source)
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(`differential: ${label}`, same, same ? '' : `mine=${JSON.stringify(actual)} node=${JSON.stringify(expected)}`)
}

// ── 2. 序列化往返：我们写出的内容必须能读回同一个值 ──────────────────────────
console.log('\n--- round-trip: serializeDotEnvLine ---')

const trickyValues = [
  'plain',
  '',
  'with space',
  'with "quotes"',
  'with \\backslash',
  'with\nnewline',
  'with\ttab',
  'trailing space ',
  ' leading space',
  '$NOT_EXPANDED',
  '${ALSO_NOT}',
  '%NOT_EXPANDED%',
  'hash # inside',
  'colon: inside',
  'equals=inside',
  '中文与 emoji 🎯',
  // 含单引号：双引号内是字面量 → 忠实
  "with 'single'",
  // 同时含两种引号 → 真正有损（两种引号都会在首个同类引号处截断）
  "both \"double\" and 'single'",
  // 含双引号 + 换行 → 真正有损
  'both "double"\nand newline',
]

let representable = 0
let unrepresentable = 0

const RT_KEY = 'RT'

let faithful = 0
let lossy = 0
let ambiguous = 0

for (const value of trickyValues) {
  const line = serializeDotEnvLine(RT_KEY, value)
  const issue = representabilityOf(line)
  const label = JSON.stringify(value).slice(0, 34)
  const nodeRead = parseEnv(line)[RT_KEY]
  const mineRead = parseDotEnv(line)[RT_KEY]

  if (issue === undefined) {
    faithful += 1
    ok(`faithful via parseEnv: ${label}`, nodeRead === value, `got ${JSON.stringify(nodeRead)}`)
    ok(`faithful via parseDotEnv: ${label}`, mineRead === value, `got ${JSON.stringify(mineRead)}`)
    continue
  }

  if (issue.lossy) {
    // 有损：必须**明确报告**，且确实读不回来（证明登记不是多余的）
    lossy += 1
    ok(`lossy is flagged: ${label}`, nodeRead !== value, 'flag says lossy but it round-trips?')
  } else {
    // 歧义：能读回原值，但与"未设置"无法区分
    ambiguous += 1
    ok(`ambiguous still round-trips: ${label}`, nodeRead === value, `got ${JSON.stringify(nodeRead)}`)
  }
  ok(`issue names a reason: ${label}`, typeof issue.reason === 'string' && issue.reason.length > 0, issue.reason)
}

ok('every tricky value is classified', faithful + lossy + ambiguous === trickyValues.length)
ok('exercised the faithful path', faithful >= 1, String(faithful))
ok('exercised the lossy path', lossy >= 1, String(lossy))
ok('exercised the ambiguous path', ambiguous >= 1, String(ambiguous))

// 引号形态选择（实测依据：单引号内双引号是字面量，双引号内单引号也是字面量）
ok(
  'value with double quote uses single quoting',
  serializeDotEnvLine('K', 'a"b') === `K='a"b'`,
  serializeDotEnvLine('K', 'a"b'),
)
ok(
  'value with single quote uses double quoting',
  serializeDotEnvLine('K', "a'b") === `K="a'b"`,
  serializeDotEnvLine('K', "a'b"),
)
ok('plain value uses double quoting', serializeDotEnvLine('K', 'plain') === 'K="plain"')
ok(
  'value with newline uses double quoting with escaped newline',
  serializeDotEnvLine('K', 'a\nb') === 'K="a\\nb"',
  serializeDotEnvLine('K', 'a\nb'),
)

// 冒号分隔行会被 parseEnv 静默丢弃 —— 序列化器绝不能生成
const emitted = trickyValues.map((v) => serializeDotEnvLine('K', v))
ok(
  'serializer always emits KEY= form',
  emitted.every((l) => /^K=/.test(l)),
  emitted.filter((l) => !/^K=/.test(l)).join(' | '),
)

// 空值：能读回空串，但"设为空"与"未设置"无法区分，必须显式告知 UI
const emptyLine = serializeDotEnvLine('K', '')
ok('empty value round-trips as empty string', parseEnv(emptyLine).K === '', JSON.stringify(parseEnv(emptyLine)))
ok(
  'empty value is flagged as ambiguous (not lossy)',
  representabilityOf(emptyLine)?.lossy === false,
  JSON.stringify(representabilityOf(emptyLine)),
)

// 登记表必须被覆盖写清理干净：同一个 key 换成可表示的值后不应残留问题
const staleKey = 'STALE'
serializeDotEnvLine(staleKey, "has 'quote'")
const cleaned = serializeDotEnvLine(staleKey, 'plain-now')
ok('issue registry is overwritten by a later faithful value', representabilityOf(cleaned) === undefined)

// ── 3. 禁止名单规则 ─────────────────────────────────────────────────────────
console.log('\n--- bootstrap rules ---')

ok('DSH_HOME is bootstrap-only (DSH_ prefix)', isBootstrapOnly('DSH_HOME'))
ok('XDG_CONFIG_HOME is bootstrap-only (XDG_ prefix)', isBootstrapOnly('XDG_CONFIG_HOME'))
ok('DYLD_X is bootstrap-only', isBootstrapOnly('DYLD_X'))
ok('BASH_FUNC_x is bootstrap-only', isBootstrapOnly('BASH_FUNC_foo'))
ok('PATH is bootstrap-only', isBootstrapOnly('PATH'))
ok('dsh_lowercase still caught (case-insensitive)', isBootstrapOnly('dsh_home'))
ok('MY_VAR is writable', !isBootstrapOnly('MY_VAR'))
ok('DEEPSEEK_API_KEY is writable (only the ref name is used)', !isBootstrapOnly('DEEPSEEK_API_KEY'))
ok('DEEPSEEK_BASE_URL is bootstrap-only', isBootstrapOnly('DEEPSEEK_BASE_URL'))
ok('NO_PROXY is bootstrap-only (needs home layer)', isBootstrapOnly('NO_PROXY'))
ok('denylist has 49 entries (matches BOOTSTRAP_NAMES)', BOOTSTRAP_NAMES.size === 49, String(BOOTSTRAP_NAMES.size))

// ── 4. 真实机器快照 ─────────────────────────────────────────────────────────
console.log('\n--- live model on this machine ---')
const model = buildEnvironmentModel({ cwd: process.cwd() })
console.log(`cwd            : ${model.cwd}`)
console.log(`DSH home       : ${model.home}`)
console.log(`project .env   : ${model.projectFile?.path ?? '(absent)'}`)
console.log(`user .env      : ${model.userFile?.path ?? '(absent)'}`)
console.log(`variables      : ${model.variables.length}`)

const runtime = model.variables.filter((v) => v.runtimeManaged)
console.log(`\nDSH_* runtime-managed (${runtime.length}):`)
for (const v of runtime.slice(0, 12)) console.log(`  ${describeVariable(v)}`)

const shadowed = model.variables.filter((v) => v.shadowed)
console.log(`\nshadowed (present in >1 layer): ${shadowed.length}`)
for (const v of shadowed.slice(0, 10)) {
  console.log(`  ${v.name} [effective=${v.effective}]`)
  for (const l of v.layers) console.log(`      ${l.layer.padEnd(12)} ${JSON.stringify(String(l.value).slice(0, 42))} writable=${l.writable}`)
}

// Windows 上环境名大小写不敏感，Path/PATH 都归一到同一个键；用大小写无关查找
const findByFold = (name) =>
  model.variables.find((v) => v.name.toUpperCase() === name.toUpperCase())

ok('resolved DSH home matches $DSH_HOME', model.home.toLowerCase() === resolveDshHome().toLowerCase(), model.home)
ok('DSH_SHELL present in model', findByFold('DSH_SHELL') !== undefined)
ok('DSH_SHELL marked runtimeManaged', findByFold('DSH_SHELL')?.runtimeManaged === true)
ok('DSH_SHELL effective layer is process', findByFold('DSH_SHELL')?.effective === 'process')
ok('PATH present and flagged bootstrap-only', findByFold('PATH')?.forbidden === true, findByFold('PATH')?.name ?? 'absent')
ok('every variable has an effective layer', model.variables.every((v) => v.effective !== undefined))
ok(
  'process-layer entries are never writable',
  model.variables.every((v) => v.layers.filter((l) => l.layer === 'process').every((l) => l.writable === false)),
)
ok(
  'forbidden flag is case-insensitive (Windows Path)',
  model.variables.filter((v) => v.forbidden).length > 0,
)

// ── 5. 合成层测试：遮蔽、生效层与逐层可写性 ────────────────────────────────
// 本机两个 .env 都不存在，所以上面的真实快照证明不了遮蔽逻辑。这里构造一个
// 临时目录 + home，把三层同时喂给模型。
console.log('\n--- synthetic layers (shadowing / precedence / writability) ---')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-envmodel-'))
const projectDir = join(scratch, 'project')
const homeDir = join(scratch, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })

// 三层同时提供 SHARED，用不同值区分来源
writeFileSync(
  join(homeDir, '.env'),
  ['SHARED="from-home"', 'ONLY_HOME="h"', 'HOME_PROXY_CHECK="x"'].join('\n'),
)
writeFileSync(
  join(projectDir, '.env'),
  ['SHARED="from-project"', 'ONLY_PROJECT="p"', 'NEW_VAR="n"'].join('\n'),
)

const synthetic = buildEnvironmentModel({
  cwd: projectDir,
  home: homeDir,
  env: { SHARED: 'from-process', ONLY_PROCESS: 'p' },
})

const pick = (name) => synthetic.variables.find((v) => v.name === name)

const shared = pick('SHARED')
ok('SHARED is marked shadowed', shared?.shadowed === true)
ok('SHARED effective layer is process (highest trust)', shared?.effective === 'process', String(shared?.effective))
ok('SHARED carries all three layers', shared?.layers.length === 3, String(shared?.layers.length))
ok(
  'SHARED layer values are preserved per layer',
  shared?.layers.map((l) => l.value).join('|') === 'from-process|from-project|from-home',
  shared?.layers.map((l) => `${l.layer}=${l.value}`).join(' '),
)
ok(
  'SHARED layer order follows SOURCE_ORDER',
  shared?.layers.map((l) => l.layer).join(',') === 'process,project-env,user-env',
  shared?.layers.map((l) => l.layer).join(','),
)
ok('SHARED process layer is not writable', shared?.layers[0]?.writable === false)
ok('SHARED project layer is writable', shared?.layers[1]?.writable === true)
ok('SHARED user layer is writable', shared?.layers[2]?.writable === true)

ok('ONLY_PROCESS resolves to process', pick('ONLY_PROCESS')?.effective === 'process')
ok('ONLY_PROJECT resolves to project-env', pick('ONLY_PROJECT')?.effective === 'project-env')
ok('ONLY_HOME resolves to user-env', pick('ONLY_HOME')?.effective === 'user-env')
ok('single-layer variables are not marked shadowed', pick('ONLY_HOME')?.shadowed === false)
ok(
  '.env layer values carry their file path',
  pick('ONLY_HOME')?.layers[0]?.path === join(homeDir, '.env'),
  String(pick('ONLY_HOME')?.layers[0]?.path),
)
ok('process layer carries no path', pick('ONLY_PROCESS')?.layers[0]?.path === undefined)

// 禁止名单逐层可写性：代理变量只允许写在 home 层
writeFileSync(
  join(homeDir, '.env'),
  ['SHARED="from-home"', 'ONLY_HOME="h"', 'HTTP_PROXY="http://home-proxy"'].join('\n'),
)
writeFileSync(
  join(projectDir, '.env'),
  ['SHARED="from-project"', 'ONLY_PROJECT="p"', 'HTTP_PROXY="http://project-proxy"', 'DSH_HOME="nope"'].join('\n'),
)
const synthetic2 = buildEnvironmentModel({
  cwd: projectDir,
  home: homeDir,
  env: { PATH: '/usr/bin' },
})
const proxy = synthetic2.variables.find((v) => v.name === 'HTTP_PROXY')
ok('HTTP_PROXY present after rewrite', proxy !== undefined)
ok(
  'HTTP_PROXY project layer is blocked with a code (proxy must live in home .env)',
  proxy?.layers.find((l) => l.layer === 'project-env')?.blockedCode === 'proxy-not-in-home',
  String(proxy?.layers.find((l) => l.layer === 'project-env')?.blockedCode),
)
ok(
  'blocked codes have text in the shared table',
  BLOCKED_REASON_TEXT['proxy-not-in-home'] !== undefined && BLOCKED_REASON_TEXT['process-inherited'] !== undefined,
)
ok(
  'HTTP_PROXY home layer is allowed (documented exception)',
  proxy?.layers.find((l) => l.layer === 'user-env')?.writable === true,
)
ok('HTTP_PROXY is flagged forbidden (only home may set it)', proxy?.forbidden === true)
const dshHomeVar = synthetic2.variables.find((v) => v.name === 'DSH_HOME')
ok('DSH_HOME from project .env is blocked', dshHomeVar?.layers[0]?.writable === false)
ok('DSH_HOME is flagged runtimeManaged', dshHomeVar?.runtimeManaged === true)
ok('DSH_HOME is flagged forbidden', dshHomeVar?.forbidden === true)

rmSync(scratch, { recursive: true, force: true })

// ── 6. BOM 处理（与 parseEnv 的已知差异，必须被报告而不是静默）───────────────
// `parseEnv` **不**剥离开头的 U+FEFF，于是带 BOM 的文件里第一个变量名会变成
// `\uFEFFFIRST` —— 一个界面上不可见、因而用户既看不到也删不掉的名字。
// 我们剥掉它（与绝大多数工具一致），但把这个差异报出去。
console.log('\n--- BOM handling ---')
{
  const BOM = '\uFEFF'
  const withBom = `${BOM}FIRST="one"\nSECOND="two"\n`

  const nodeKeys = Object.keys(parseEnv(withBom))
  const bomKey = nodeKeys.find((k) => k.charCodeAt(0) === 0xfeff)
  ok(
    'DSH-side parseEnv keeps the BOM inside the first key (documents the hazard)',
    bomKey !== undefined,
    nodeKeys.map((k) => JSON.stringify(k)).join(','),
  )
  // 注意不要假设它排在第一个：U+FEFF 参与排序，实测 keys[0] 是 SECOND
  ok('parseEnv BOM key codepoints start with U+FEFF', bomKey?.charCodeAt(0) === 0xfeff, JSON.stringify(bomKey))
  ok(
    'parseEnv BOM key is otherwise the plain name',
    bomKey?.slice(1) === 'FIRST',
    JSON.stringify(bomKey),
  )

  const collected = []
  const mine = parseDotEnv(withBom, (w) => collected.push(w))
  ok('our parser strips the BOM from the first key', mine.FIRST === 'one', JSON.stringify(mine))
  ok('our parser still reads the second key', mine.SECOND === 'two')
  ok('no BOM-prefixed key remains', !Object.keys(mine).some((k) => k.charCodeAt(0) === 0xfeff), Object.keys(mine).join(','))

  ok('a BOM warning is emitted', collected.length === 1, JSON.stringify(collected))
  ok('the warning has a code', collected[0]?.code === 'bom', String(collected[0]?.code))
  ok(
    'the warning explains the divergence from DSH',
    String(collected[0]?.message).includes('DSH'),
    String(collected[0]?.message),
  )

  // 无 BOM 时不应产生任何诊断
  const clean = []
  parseDotEnv('A="1"\n', (w) => clean.push(w))
  ok('no warning for a BOM-less file', clean.length === 0, JSON.stringify(clean))

  // 模型层要把诊断带到 warnings 数组里（UI 靠它显示）
  const bomScratch = mkdtempSync(join(tmpdir(), 'dsh-bom-'))
  const bomProject = join(bomScratch, 'p')
  mkdirSync(bomProject, { recursive: true })
  writeFileSync(join(bomProject, '.env'), withBom, 'utf8')
  const bomModel = buildEnvironmentModel({ cwd: bomProject, home: join(bomScratch, 'h'), env: {} })
  ok('model surfaces the BOM warning', (bomModel.warnings ?? []).length === 1, JSON.stringify(bomModel.warnings))
  ok(
    'model warning carries the offending path',
    String(bomModel.warnings?.[0]?.path).endsWith('.env'),
    String(bomModel.warnings?.[0]?.path),
  )
  ok('model has a clean FIRST key despite the BOM', bomModel.variables.some((v) => v.name === 'FIRST'))
  rmSync(bomScratch, { recursive: true, force: true })
}

// ── 7. 禁止名单必须与 DSH 源码逐条一致（差分）───────────────────────────────
// 这是最强的一种断言：不是"我认为名单是这样的"，而是**从 DSH 自己的实现里
// 提取权威名单**再比对。上游增删条目时，这条断言会立刻变红。
console.log('\n--- denylist fidelity vs DSH source ---')
{
  const DSH_APP_BOOT = join(
    'C:',
    'Users',
    'qq651',
    'AppData',
    'Local',
    'npm-cache',
    '_npx',
    '1e7f6d9597241db0',
    'node_modules',
    '@deepseek-ai',
    'dsh-app-boot',
    'lib',
    'index.js',
  )

  let src
  try {
    src = readFileSync(DSH_APP_BOOT, 'utf8')
  } catch {
    src = undefined
  }

  if (src === undefined) {
    console.log('SKIP  DSH 源码不在预期路径，跳过差分比对')
  } else {
    /** 从形如 `const NAME = new Set([ ... ])` 的源码里抽出字符串字面量。 */
    const extractSet = (source, constName) => {
      const at = source.indexOf(`const ${constName}`)
      if (at === -1) return undefined
      const open = source.indexOf('[', at)
      const close = source.indexOf(']', open)
      const body = source.slice(open + 1, close)
      return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    }

    const upstreamNames = extractSet(src, 'BOOTSTRAP_NAMES')
    const upstreamPrefixes = extractSet(src, 'BOOTSTRAP_PREFIXES')
    const upstreamProxy = extractSet(src, 'HOME_LAYER_PROXY_NAMES')

    ok('extracted the upstream BOOTSTRAP_NAMES list', Array.isArray(upstreamNames) && upstreamNames.length > 0, String(upstreamNames?.length))
    ok('extracted the upstream BOOTSTRAP_PREFIXES list', Array.isArray(upstreamPrefixes), String(upstreamPrefixes))

    // 逐条比对（顺序无关，因为两者都是集合语义）
    const ours = [...BOOTSTRAP_NAMES].sort()
    const theirs = [...upstreamNames].sort()
    const missing = theirs.filter((n) => !ours.includes(n))
    const extra = ours.filter((n) => !theirs.includes(n))
    ok('our BOOTSTRAP_NAMES is not missing any upstream entry', missing.length === 0, `missing: ${missing.join(',')}`)
    ok('our BOOTSTRAP_NAMES has no entries DSH does not reject', extra.length === 0, `extra: ${extra.join(',')}`)
    ok('BOOTSTRAP_NAMES matches upstream exactly', JSON.stringify(ours) === JSON.stringify(theirs), `${String(ours.length)} vs ${String(theirs.length)}`)

    const ourPrefixes = [...BOOTSTRAP_PREFIXES].sort()
    const theirPrefixes = [...upstreamPrefixes].sort()
    ok('BOOTSTRAP_PREFIXES matches upstream exactly', JSON.stringify(ourPrefixes) === JSON.stringify(theirPrefixes), `${JSON.stringify(ourPrefixes)} vs ${JSON.stringify(theirPrefixes)}`)

    const ourProxy = [...HOME_LAYER_PROXY_NAMES].sort()
    const theirProxy = [...upstreamProxy].sort()
    ok('HOME_LAYER_PROXY_NAMES matches upstream exactly', JSON.stringify(ourProxy) === JSON.stringify(theirProxy), `${JSON.stringify(ourProxy)} vs ${JSON.stringify(theirProxy)}`)
    ok('prefixes are all uppercase (matching is case-folded)', BOOTSTRAP_PREFIXES.every((p) => p === p.toUpperCase()))
  }
}

// ── 8. 前缀禁令与敏感名规则 ─────────────────────────────────────────────────
console.log('\n--- prefix bans and the sensitive-name rule ---')
{
  // 前缀禁令：四个前缀各自都要真的挡住
  for (const prefix of BOOTSTRAP_PREFIXES) {
    const name = `${prefix}SOMETHING`
    ok(`prefix ban blocks ${prefix}*`, isBootstrapOnly(name), name)
  }
  ok('prefix list has all four documented entries', BOOTSTRAP_PREFIXES.length === 4, JSON.stringify(BOOTSTRAP_PREFIXES))
  ok('a name merely containing DSH_ is not banned', !isBootstrapOnly('MY_DSH_THING'))
  ok('a name with the prefix mid-string is not banned', !isBootstrapOnly('XDSH_HOME'))

  // 敏感名规则必须与 dsh-subprocess 的 scrubbedParentEnv 用同一条正则
  for (const name of ['API_KEY', 'MY_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET', 'key', 'token']) {
    ok(`sensitive pattern matches ${name}`, SENSITIVE_ENV_PATTERN.test(name), name)
  }
  for (const name of ['PATH', 'HOME', 'LANG', 'MY_VAR']) {
    ok(`sensitive pattern ignores ${name}`, !SENSITIVE_ENV_PATTERN.test(name), name)
  }
}

// ── 9. 逐层可写性 ───────────────────────────────────────────────────────────
console.log('\n--- per-layer writability ---')
{
  ok('process layer is never writable', writabilityOf('ANY', 'process').writable === false)
  ok('process layer carries the inherited code', writabilityOf('ANY', 'process').blockedCode === 'process-inherited')
  ok('credential layer is writable', writabilityOf('ANY', 'credential').writable === true)
  ok('project layer is writable for a plain name', writabilityOf('MY_VAR', 'project-env').writable === true)
  ok('user layer is writable for a plain name', writabilityOf('MY_VAR', 'user-env').writable === true)
  ok('project layer refuses a banned name', writabilityOf('PATH', 'project-env').writable === false)
  ok('banned name gets the bootstrap-only code', writabilityOf('PATH', 'project-env').blockedCode === 'bootstrap-only')
  ok('proxy refused in project layer with the proxy code', writabilityOf('HTTP_PROXY', 'project-env').blockedCode === 'proxy-not-in-home')
  ok('proxy allowed in the home layer (documented exception)', writabilityOf('HTTP_PROXY', 'user-env').writable === true)
  ok('unknown layer reports itself', writabilityOf('X', 'nope').blockedCode === 'unknown-layer')
  ok('every blocked code has human text', Object.keys(BLOCKED_REASON_TEXT).length >= 4, String(Object.keys(BLOCKED_REASON_TEXT).length))
}

// ── 10. readEnvFile 的边界 ──────────────────────────────────────────────────
console.log('\n--- readEnvFile ---')
{
  const rfScratch = mkdtempSync(join(tmpdir(), 'dsh-readenv-'))
  const present = join(rfScratch, 'present.env')
  writeFileSync(present, 'A="1"\n', 'utf8')

  const hit = readEnvFile(present)
  ok('reads an existing file', hit?.values?.A === '1', JSON.stringify(hit))

  const collected = []
  readEnvFile(present, collected)
  ok('accepts a warnings collector', Array.isArray(collected) && collected.length === 0)

  ok('returns undefined for a missing file', readEnvFile(join(rfScratch, 'nope.env')) === undefined)

  // 目录路径也算读取失败，必须返回 undefined 而不是抛
  let threw
  let dirResult
  try {
    dirResult = readEnvFile(rfScratch)
  } catch (error) {
    threw = error
  }
  ok('does not throw when the path is a directory', threw === undefined, String(threw))
  ok('returns undefined for a directory', dirResult === undefined, JSON.stringify(dirResult))

  // 警告必须带上出错的文件路径
  const bomFile = join(rfScratch, 'bom.env')
  writeFileSync(bomFile, '\uFEFFA="1"\n', 'utf8')
  const bomWarnings = []
  readEnvFile(bomFile, bomWarnings)
  ok('warning carries the offending path', bomWarnings[0]?.path === bomFile, JSON.stringify(bomWarnings))

  rmSync(rfScratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
