/**
 * 构建产物等价性门禁。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────────────
 *
 * 迁移到 TypeScript 时最大的风险不是"类型报错"，而是**构建产物与旧的手写
 * `.mjs` 行为不一致** —— 那会静默改变已通过 877 项断言的实现。所以本脚本
 * 在**切换前**把新旧产物逐一对比。
 *
 * ── 对比什么 ────────────────────────────────────────────────────────────────
 *
 * 不是文本对比（重命名、注释、缩进都会变），而是：
 *   1. **导出的符号集合一致**（多一个少一个都是问题）
 *   2. **每个导出的函数/类，其 `length`（形参个数）一致**
 *   3. **同一组输入下行为一致**：直接对两个模块跑同一批调用并比对结果
 *
 * 第 3 项是核心。为此脚本对每个模块构造一批"探针调用"。
 *
 * 运行：node verify-build-parity.mjs
 */

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const PAIRS = [
  { name: 'env-model', legacy: 'lib/env-model.mjs' },
  { name: 'env-write', legacy: 'lib/env-write.mjs' },
  { name: 'credentials', legacy: 'lib/credentials.mjs' },
  { name: 'registry', legacy: 'lib/registry.mjs' },
  { name: 'host-api', legacy: 'lib/host-api.mjs' },
  { name: 'write-routes', legacy: 'lib/write-routes.mjs' },
]

let failures = 0
let compared = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 每个模块的行为抽样：`[标签, (mod) => 结果]`。
 *
 * 只用**纯函数**（无 IO、无时间依赖），这样新旧产物可以在同一进程里安全对比。
 * 覆盖面来自各套件里已被断言的行为，这里是它们的精简版。
 */
const BEHAVIOUR_SAMPLES = {
  'env-model': [
    ['parseDotEnv basic', (m) => m.parseDotEnv('A=1\nB="x y"\n')],
    ['parseDotEnv export prefix', (m) => m.parseDotEnv('export A=1\n')],
    ['parseDotEnv colon dropped', (m) => m.parseDotEnv('A: 1\nB=2\n')],
    ['parseDotEnv hash truncation', (m) => m.parseDotEnv('A=a#b\n')],
    ['parseDotEnv escapes literal', (m) => m.parseDotEnv('A="x\\ty"\n')],
    ['parseDotEnv no expansion', (m) => m.parseDotEnv('A=$B\n')],
    ['parseDotEnv BOM warning', (m) => {
      const w = []
      const v = m.parseDotEnv('\uFEFFA=1\n', (x) => w.push(x))
      return { v, w }
    }],
    ['serializeDotEnvLine plain', (m) => m.serializeDotEnvLine('K', 'v')],
    ['serializeDotEnvLine newline', (m) => m.serializeDotEnvLine('K', 'a\nb')],
    ['isBootstrapOnly cases', (m) => [
      m.isBootstrapOnly('PATH'),
      m.isBootstrapOnly('DSH_HOME'),
      m.isBootstrapOnly('dsh_home'),
      m.isBootstrapOnly('MY_VAR'),
      m.isBootstrapOnly('HTTP_PROXY'),
    ]],
    ['denylist size', (m) => [m.BOOTSTRAP_NAMES.size, m.BOOTSTRAP_PREFIXES.length, m.HOME_LAYER_PROXY_NAMES.size]],
    ['sensitive pattern', (m) => ['API_KEY', 'PATH', 'token'].map((n) => m.SENSITIVE_ENV_PATTERN.test(n))],
    ['writabilityOf matrix', (m) => [
      m.writabilityOf('X', 'process'),
      m.writabilityOf('X', 'credential'),
      m.writabilityOf('MY_VAR', 'project-env'),
      m.writabilityOf('PATH', 'project-env'),
      m.writabilityOf('HTTP_PROXY', 'project-env'),
      m.writabilityOf('HTTP_PROXY', 'user-env'),
      m.writabilityOf('X', 'nope'),
    ]],
    ['blocked reason text keys', (m) => Object.keys(m.BLOCKED_REASON_TEXT).sort()],
    ['source order', (m) => m.SOURCE_ORDER],
  ],

  'env-write': [
    ['splitDotEnv/joinDotEnv round-trip', (m) => {
      const samples = ['A=1\n', 'A=1\n\n', 'A=1\r\nB=2\r\n', '', '# c\n\nA=1\n\n', 'A=1\nB=2']
      return samples.map((s) => m.joinDotEnv(m.splitDotEnv(s)) === s)
    }],
    ['revisionOf', (m) => [m.revisionOf('/x', undefined), m.revisionOf('/x', 'A=1\n') === m.revisionOf('/y', 'A=1\n')]],
    ['validateEdit forbidden', (m) => [
      m.validateEdit('DSH_HOME', 'project-env', 'x').map((p) => p.code),
      m.validateEdit('PATH', 'project-env', 'x').map((p) => p.code),
      m.validateEdit('HTTP_PROXY', 'project-env', 'x').map((p) => p.code),
      m.validateEdit('HTTP_PROXY', 'user-env', 'x').map((p) => p.code),
      m.validateEdit('MY_VAR', 'project-env', 'x').map((p) => p.code),
      m.validateEdit('1BAD', 'project-env', 'x').map((p) => p.code),
    ]],
    ['validateEdit lossy value', (m) => m.validateEdit('Q', 'project-env', 'a"b\'c').map((p) => p.code)],
    ['EnvEditRejected shape', (m) => {
      const e = new m.EnvEditRejected('code-x', 'msg', [{ code: 'p' }])
      return [e.name, e.code, e.message, e.problems.length]
    }],
  ],

  credentials: [
    ['isPossibleRef', (m) => ['DEEPSEEK_API_KEY', 'a', '1BAD', 'WITH-DASH', 'with space', ''].map((s) => m.isPossibleRef(s))],
    ['describeSource', (m) => ['env', 'file', 'project-env', 'user-env', 'weird', undefined].map((s) => m.describeSource(s))],
    ['toCredentialView unconfigured+writable', (m) => m.toCredentialView({ configured: false, writable: true })],
    ['toCredentialView shadowed by env', (m) => m.toCredentialView({ configured: true, writable: false, source: 'env' })],
    ['toCredentialView shadowed by project-env', (m) => m.toCredentialView({ configured: true, writable: false, source: 'project-env' })],
    ['toCredentialView undefined', (m) => m.toCredentialView(undefined)],
    ['credentialAccessOf absent', (m) => m.credentialAccessOf({ get: () => undefined }) === undefined],
    ['CredentialShadowed shape', (m) => {
      const e = new m.CredentialShadowed('REF', 'env', false)
      return [e.name, e.code, e.ref, e.source, e.writable]
    }],
    ['CredentialRejected shape', (m) => {
      const e = new m.CredentialRejected('empty-value', 'msg')
      return [e.name, e.code, e.message]
    }],
  ],

  registry: [
    ['normalizeKeyPath', (m) => [
      m.normalizeKeyPath('HKCU\\Environment'),
      m.normalizeKeyPath('HKLM\\x'),
      m.normalizeKeyPath('HKEY_CURRENT_USER\\Environment'),
      m.normalizeKeyPath('  hkcu\\Environment  '),
    ]],
    ['normalizeKeyPath equivalence', (m) => m.normalizeKeyPath('HKCU\\E') === m.normalizeKeyPath('HKEY_CURRENT_USER\\E')],
    ['parseRegQuery real output', (m) => m.parseRegQuery(
      'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\x\r\n    A    REG_SZ    1\r\n',
      'HKCU\\Environment',
    )],
    ['parseRegQuery excludes subkey', (m) => m.parseRegQuery(
      'HKEY_CURRENT_USER\\Environment\r\n    P    REG_SZ    1\r\n\r\nHKEY_CURRENT_USER\\Environment\\Sub\r\n    INNER    REG_SZ    2\r\n',
      'HKCU\\Environment',
    )],
    ['parseRegQuery default name', (m) => m.parseRegQuery(
      'HKEY_CURRENT_USER\\Environment\r\n    (Default)    REG_SZ    d\r\n    C    REG_DWORD    0x10\r\n    E    REG_SZ\r\n',
      'HKCU\\Environment',
    )],
    ['decodeRegOutput non-utf8', (m) => typeof m.decodeRegOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))],
    ['mergePath', (m) => [
      m.OsEnvironmentLayer.mergePath('U', 'M'),
      m.OsEnvironmentLayer.mergePath('U', ''),
      m.OsEnvironmentLayer.mergePath('', 'M'),
      m.OsEnvironmentLayer.mergePath('', ''),
      m.OsEnvironmentLayer.mergePath(undefined, 'M'),
    ]],
    ['scope constants', (m) => [m.USER_SCOPE, m.MACHINE_SCOPE]],
    ['mergeOsLayers shape', (m) => {
      const base = {
        cwd: 'C:\\p', home: 'C:\\h', warnings: [],
        variables: [{ name: 'SHARED', layers: [{ layer: 'process', value: 'p', writable: false }], effective: 'process', shadowed: false, forbidden: false, sensitive: false, runtimeManaged: false }],
      }
      const merged = m.mergeOsLayers(base, {
        [m.USER_SCOPE]: { entries: [{ name: 'SHARED', type: 'REG_SZ', value: 'u' }, { name: 'TOKEN_X', type: 'REG_SZ', value: 't' }] },
        [m.MACHINE_SCOPE]: { entries: [{ name: 'SYS', type: 'REG_EXPAND_SZ', value: '%X%' }] },
      })
      return {
        names: merged.map((v) => v.name),
        shared: merged.find((v) => v.name === 'SHARED'),
        sys: merged.find((v) => v.name === 'SYS'),
        tokenSensitive: merged.find((v) => v.name === 'TOKEN_X')?.sensitive,
        baseUnmutated: base.variables[0].layers.length,
      }
    }],
  ],

  'host-api': [
    ['summarizeValue short', (m) => m.summarizeValue('hello')],
    ['summarizeValue long', (m) => m.summarizeValue('x'.repeat(500))],
    ['summarizeValue exact limit', (m) => m.summarizeValue('y'.repeat(120))],
    ['summarizeValue over limit', (m) => m.summarizeValue('y'.repeat(121)).truncated],
    ['route constants', (m) => [m.STATE_ROUTE, m.HEALTH_ROUTE, m.CREDENTIAL_STATE_ROUTE]],
    ['projectState redaction', (m) => {
      const model = {
        cwd: 'C:\\p', home: 'C:\\h', warnings: [],
        projectFile: { path: 'C:\\p\\.env', values: {} },
        userFile: undefined,
        variables: [
          { name: 'PLAIN', layers: [{ layer: 'process', value: 'visible', writable: false }], effective: 'process', shadowed: false, forbidden: false, sensitive: false, runtimeManaged: false },
          { name: 'MY_TOKEN', layers: [{ layer: 'process', value: 'secret-value', writable: false }], effective: 'process', shadowed: false, forbidden: false, sensitive: true, runtimeManaged: false },
        ],
      }
      const p = m.projectState(model)
      return {
        counts: p.counts,
        files: p.files,
        leaksSecret: JSON.stringify(p).includes('secret-value'),
        plainHasSummary: p.variables.find((v) => v.name === 'PLAIN')?.layers[0]?.valueSummary?.preview,
        tokenLayer: p.variables.find((v) => v.name === 'MY_TOKEN')?.layers[0],
      }
    }],
    ['projectState reveal=false', (m) => {
      const model = {
        cwd: 'C:\\p', home: 'C:\\h', warnings: [],
        projectFile: undefined, userFile: undefined,
        variables: [{ name: 'PLAIN', layers: [{ layer: 'process', value: 'visible', writable: false }], effective: 'process', shadowed: false, forbidden: false, sensitive: false, runtimeManaged: false }],
      }
      const p = m.projectState(model, { revealValues: false })
      return { leaks: JSON.stringify(p).includes('visible'), layer: p.variables[0].layers[0] }
    }],
    ['projectState carries warnings', (m) => {
      const p = m.projectState({ cwd: 'c', home: 'h', projectFile: undefined, userFile: undefined, variables: [], warnings: [{ code: 'bom', message: 'm' }] })
      return p.warnings
    }],
  ],

  'write-routes': [
    ['route constants', (m) => [m.ENV_ROUTE, m.CREDENTIAL_ROUTE, m.REGISTRY_ROUTE]],
    ['resolveLayerPath project', (m) => m.resolveLayerPath('project-env', 'C:\\p', 'C:\\h')],
    ['resolveLayerPath user', (m) => m.resolveLayerPath('user-env', 'C:\\p', 'C:\\h')],
    ['resolveLayerPath rejects bad layer', (m) => {
      try {
        m.resolveLayerPath('os-user', 'C:\\p', 'C:\\h')
        return 'NO THROW'
      } catch (error) {
        return String(error.message).includes('不支持的层')
      }
    }],
    ['resolveLayerPath rejects mismatched claim', (m) => {
      try {
        m.resolveLayerPath('project-env', 'C:\\p', 'C:\\h', 'C:\\evil\\.env')
        return 'NO THROW'
      } catch (error) {
        return String(error.message).includes('不一致')
      }
    }],
    ['resolveLayerPath accepts matching claim', (m) => {
      const derived = m.resolveLayerPath('project-env', 'C:\\p', 'C:\\h')
      return m.resolveLayerPath('project-env', 'C:\\p', 'C:\\h', derived) === derived
    }],
    ['toWriteRejected status mapping', (m) => [
      m.toWriteRejected({ code: 'stale-revision', message: 'x', problems: [], name: 'EnvEditRejected' }) instanceof Error,
      m.toWriteRejected(new Error('boom')).status,
      m.toWriteRejected(new Error('boom')).code,
    ]],
    ['createRequestGuard fails closed', (m) => {
      const guard = m.createRequestGuard({ connection: undefined })
      const captured = {}
      const res = { writeHead: (s) => { captured.status = s }, end: (b) => { captured.body = b } }
      const allowed = guard({ headers: {} }, res)
      return { allowed, status: captured.status, body: captured.body }
    }],
    ['createRequestGuard honours requestRejection', (m) => {
      const guard = m.createRequestGuard({ connection: { requestRejection: () => 403 } })
      const captured = {}
      const res = { writeHead: (s) => { captured.status = s }, end: (b) => { captured.body = b } }
      return { allowed: guard({ headers: {} }, res), status: captured.status }
    }],
    ['createRequestGuard passes when undefined', (m) => {
      const guard = m.createRequestGuard({ connection: { requestRejection: () => undefined } })
      return guard({ headers: {} }, { writeHead: () => {}, end: () => {} })
    }],
  ],
}

const importOrNull = async (p) => {
  if (!existsSync(p)) return null
  try {
    return await import(pathToFileURL(resolve(p)).href)
  } catch (error) {
    return { __importError: String(error?.message ?? error) }
  }
}

console.log('=== 构建产物等价性检查 ===\n')

for (const pair of PAIRS) {
  const built = `lib/${pair.name}.js`
  console.log(`--- ${pair.name} ---`)

  if (!existsSync(built)) {
    console.log(`  SKIP  尚未构建 ${built}`)
    continue
  }

  const legacy = await importOrNull(pair.legacy)
  const next = await importOrNull(built)

  if (legacy === null) {
    console.log(`  SKIP  没有旧产物 ${pair.legacy}（可能已切换完成）`)
    continue
  }
  compared += 1
  if (legacy.__importError !== undefined) {
    ok(`${pair.name}: legacy imports`, false, legacy.__importError)
    continue
  }
  if (next.__importError !== undefined) {
    ok(`${pair.name}: new build imports`, false, next.__importError)
    continue
  }

  // 1. 导出符号集合
  const legacyKeys = Object.keys(legacy).filter((k) => k !== 'default').sort()
  const nextKeys = Object.keys(next).filter((k) => k !== 'default').sort()
  const missing = legacyKeys.filter((k) => !nextKeys.includes(k))
  const added = nextKeys.filter((k) => !legacyKeys.includes(k))
  ok(`${pair.name}: no export removed`, missing.length === 0, missing.join(', '))
  ok(`${pair.name}: no export added`, added.length === 0, added.join(', '))

  // 2. 函数形参个数（签名兼容性的粗检）
  let arityMismatch = []
  for (const key of legacyKeys) {
    const a = legacy[key]
    const b = next[key]
    if (typeof a === 'function' && typeof b === 'function' && a.length !== b.length) {
      arityMismatch.push(`${key}(${String(a.length)}→${String(b.length)})`)
    }
  }
  ok(`${pair.name}: function arities unchanged`, arityMismatch.length === 0, arityMismatch.join(', '))

  // 3. 行为抽样：对同名纯函数跑同一批输入
  const samples = BEHAVIOUR_SAMPLES[pair.name]
  if (samples === undefined) {
    console.log(`  (无行为抽样)`)
    continue
  }
  for (const [label, run] of samples) {
    let a
    let b
    let aErr
    let bErr
    try {
      a = JSON.stringify(await run(legacy))
    } catch (error) {
      aErr = String(error?.message ?? error)
    }
    try {
      b = JSON.stringify(await run(next))
    } catch (error) {
      bErr = String(error?.message ?? error)
    }
    if (aErr !== undefined || bErr !== undefined) {
      ok(`${pair.name}: ${label}`, aErr === bErr, `legacy=${String(aErr)} new=${String(bErr)}`)
    } else {
      ok(`${pair.name}: ${label}`, a === b, a === b ? '' : `legacy=${String(a).slice(0, 70)} new=${String(b).slice(0, 70)}`)
    }
  }
}

console.log()
// **空集不算通过。** 若一个模块都没真正对比过，报"等价"就是假通过 ——
// 这个错误我在 audit-readme.mjs 里犯过一次（正则没匹配到任何条目却打印了✅），
// 所以这里显式要求至少比过一个。
if (compared === 0) {
  const legacyLeft = PAIRS.filter((pair) => existsSync(pair.legacy)).length
  if (legacyLeft === 0) {
    // 迁移完成后的正常状态：旧的手写实现已删除，没有可比对象。
    // 这时**不能**说"等价"（那会是空集假通过），只能说本门禁已退役。
    console.log('⏭  旧的手写实现（lib/*.mjs）已全部删除 —— 迁移已完成，本门禁退役。')
    console.log('   它只在"新旧并存"的迁移期有意义；等价性结论见 git 历史里迁移提交时的运行记录。')
    console.log('   现在守行为的是各 verify-*.mjs（已指向 lib/*.js）与 verify-client-parity.mjs。')
  } else {
    console.log('❌ 没有对比任何模块 —— 构建产物尚未生成。')
    console.log('   这不构成"等价"结论。先用 `pnpm run build` 生成 lib/*.js。')
    process.exitCode = 1
  }
} else if (failures === 0) {
  console.log(`✅ 产物等价（对比了 ${String(compared)} 个模块）`)
} else {
  console.log(`❌ ${String(failures)} 项不一致（对比了 ${String(compared)} 个模块）`)
  process.exitCode = 1
}
