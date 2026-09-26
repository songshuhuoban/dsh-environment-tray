/**
 * P3 验证：凭据域适配层。
 *
 * 这一层有两个必须证明的性质，而它们都不能靠"看代码觉得对"：
 *
 *  1. **绝不泄露密钥。** 用一个会记录所有调用的假 provider 断言：
 *     任何时候都不调用 `resolve()`，且返回的视图里不含密钥值。
 *  2. **遮蔽被翻译成可行动的信息。** `dsh-credentials` 的 `set()` 在只读源
 *     遮蔽时拒绝，这是**正确行为**（否则用户以为换了 key 实际没换）。
 *     我们要证明前置判断与拒绝捕获两条路径都能给出正确结论。
 *
 * 运行：node verify-credentials.mjs
 */

import {
  CredentialAccess,
  CredentialShadowed,
  CredentialRejected,
  credentialAccessOf,
  describeSource,
  isPossibleRef,
  toCredentialView,
} from './lib/credentials.js'
import { validateEdit } from './lib/env-write.js'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 假 provider：记录每一次调用 ─────────────────────────────────────────────
/** 造一个可控的假 credentials 服务。 */
function makeProvider(initial = {}) {
  const calls = []
  const state = new Map(Object.entries(initial))
  return {
    calls,
    state,
    async describe(ref) {
      calls.push({ method: 'describe', ref })
      const entry = state.get(ref)
      if (entry === undefined) return { configured: false, writable: true }
      return { configured: true, source: entry.source, writable: entry.writable }
    },
    async set(ref, value) {
      calls.push({ method: 'set', ref, value })
      const entry = state.get(ref)
      if (entry !== undefined && !entry.writable) {
        throw new Error(`credential "${ref}" is shadowed by read-only source "${entry.source}"`)
      }
      const next = state.get(ref) ?? { source: 'file', writable: true }
      next.value = value
      state.set(ref, next)
    },
    async unset(ref) {
      calls.push({ method: 'unset', ref })
      const entry = state.get(ref)
      if (entry !== undefined && !entry.writable) {
        throw new Error(`credential "${ref}" is shadowed by read-only source "${entry.source}"`)
      }
      state.delete(ref)
    },
    async resolve(ref) {
      // 如果实现调用它，这里会留下痕迹
      calls.push({ method: 'resolve', ref })
      const entry = state.get(ref)
      return entry?.value === undefined ? undefined : { value: entry.value, source: entry.source }
    },
    async listRecords() {
      calls.push({ method: 'listRecords' })
      return [
        { key: 'llm/route-a', kind: 'api-key' },
        { key: 'auth/grant', kind: 'grant' },
      ]
    },
  }
}

// ── 1. 绝不泄露 ─────────────────────────────────────────────────────────────
console.log('--- no leakage ---')
{
  const SECRET = 'sk-super-secret-value-12345'
  const provider = makeProvider({ MY_KEY: { source: 'file', writable: true, value: SECRET } })
  const access = new CredentialAccess(provider)

  const view = await access.describe('MY_KEY')
  ok('describe never calls resolve', provider.calls.every((c) => c.method !== 'resolve'), provider.calls.map((c) => c.method).join(','))
  ok('view has no value field', !('value' in view), Object.keys(view).join(','))
  ok('view does not contain the secret anywhere', !JSON.stringify(view).includes(SECRET), JSON.stringify(view))
  ok('view reports configured', view.configured === true)
  ok('view reports source', view.source === 'file')

  // 写入后回读的视图也不能含值
  provider.calls.length = 0
  const afterSet = await access.set('MY_KEY', 'sk-new-secret-999')
  ok('set never calls resolve', provider.calls.every((c) => c.method !== 'resolve'), provider.calls.map((c) => c.method).join(','))
  ok('post-set view has no value', !JSON.stringify(afterSet).includes('sk-new-secret-999'), JSON.stringify(afterSet))

  // 批量描述同样不含值
  provider.calls.length = 0
  const many = await access.describeMany(['MY_KEY', 'OTHER_KEY'])
  ok('describeMany never calls resolve', provider.calls.every((c) => c.method !== 'resolve'))
  ok('describeMany result has no value', !JSON.stringify(many).includes(SECRET), JSON.stringify(many))
  ok('describeMany covers every requested ref', Object.keys(many).join(',') === 'MY_KEY,OTHER_KEY', Object.keys(many).join(','))
}

// ── 2. 遮蔽：前置判断与拒绝捕获两条路径 ─────────────────────────────────────
console.log('\n--- shadowing via pre-check ---')
{
  // 名字由继承的进程环境提供 → 只读、不可写
  const provider = makeProvider({ DEEPSEEK_API_KEY: { source: 'env', writable: false, value: 'from-process' } })
  const access = new CredentialAccess(provider)

  const view = await access.describe('DEEPSEEK_API_KEY')
  ok('shadowed ref is not editable', view.editable === false)
  ok('shadowed ref reports env source', view.source === 'env', String(view.source))
  ok('blockedReason names the source', String(view.blockedReason).includes('启动环境'), String(view.blockedReason))
  ok('blockedReason tells the user what to do', String(view.blockedReason).includes('重启'), String(view.blockedReason))

  let thrown
  try {
    await access.set('DEEPSEEK_API_KEY', 'sk-attempt')
  } catch (error) {
    thrown = error
  }
  ok('set throws CredentialShadowed', thrown instanceof CredentialShadowed, String(thrown))
  ok('shadowed error carries source', thrown?.source === 'env', String(thrown?.source))
  ok('pre-check prevented the provider call', provider.calls.every((c) => c.method !== 'set'), provider.calls.map((c) => c.method).join(','))
}

console.log('\n--- shadowing discovered only at write time ---')
{
  // 前置读时未配置，但 provider 在 set 时拒绝（例如 watcher 刚观察到外部编辑）
  const provider = makeProvider({})
  const access = new CredentialAccess(provider)
  // 让 set 时状态变成"被 env 遮蔽"
  provider.set = async (ref, value) => {
    provider.calls.push({ method: 'set', ref, value })
    provider.state.set(ref, { source: 'env', writable: false, value })
    throw new Error('shadowed by read-only source "env"')
  }

  let thrown
  try {
    await access.set('RACE_KEY', 'sk-x')
  } catch (error) {
    thrown = error
  }
  ok('rejection is recognised as shadowing, not generic failure', thrown instanceof CredentialShadowed, String(thrown))
  ok('post-rejection re-check found the env source', thrown?.source === 'env', String(thrown?.source))
  ok('message is actionable', String(thrown?.message).includes('无法覆盖'), String(thrown?.message))
}

// ── 3. 空值与非遮蔽类拒绝必须区分开 ─────────────────────────────────────────
console.log('\n--- rejection taxonomy ---')
{
  const provider = makeProvider({})
  const access = new CredentialAccess(provider)

  let emptyThrown
  try {
    await access.set('SOME_KEY', '')
  } catch (error) {
    emptyThrown = error
  }
  ok('empty value rejected', emptyThrown instanceof CredentialRejected)
  ok('empty value is NOT reported as shadowing', !(emptyThrown instanceof CredentialShadowed))
  ok('empty value code is empty-value', emptyThrown?.code === 'empty-value', String(emptyThrown?.code))
  ok('empty value never reached the provider', provider.calls.length === 0, provider.calls.map((c) => c.method).join(','))

  let badRefThrown
  try {
    await access.set('not a valid ref', 'x')
  } catch (error) {
    badRefThrown = error
  }
  ok('invalid ref name rejected', badRefThrown?.code === 'invalid-ref', String(badRefThrown?.code))

  // 非遮蔽类的写入失败
  const failing = makeProvider({})
  failing.set = async () => {
    throw new Error('disk is read-only')
  }
  const failingAccess = new CredentialAccess(failing)
  let genericThrown
  try {
    await failingAccess.set('K', 'v')
  } catch (error) {
    genericThrown = error
  }
  ok('generic failure is not misreported as shadowing', genericThrown instanceof CredentialRejected && !(genericThrown instanceof CredentialShadowed), String(genericThrown))
  ok('generic failure preserves the provider message', String(genericThrown?.message).includes('read-only'), String(genericThrown?.message))
}

// ── 4. unset 同样受遮蔽保护 ─────────────────────────────────────────────────
console.log('\n--- unset under shadowing ---')
{
  const provider = makeProvider({ SHADOWED: { source: 'env', writable: false, value: 'x' } })
  const access = new CredentialAccess(provider)
  let thrown
  try {
    await access.unset('SHADOWED')
  } catch (error) {
    thrown = error
  }
  ok('unset on shadowed ref throws CredentialShadowed', thrown instanceof CredentialShadowed, String(thrown))
  ok('unset on shadowed ref explains why', String(thrown?.message).includes('无法覆盖'), String(thrown?.message))

  const clean = makeProvider({ PLAIN: { source: 'file', writable: true, value: 'x' } })
  const cleanAccess = new CredentialAccess(clean)
  const after = await cleanAccess.unset('PLAIN')
  ok('unset on writable ref succeeds', after.configured === false, JSON.stringify(after))
}

// ── 5. 引用名语法与 .env 变量名规则一致 ─────────────────────────────────────
console.log('\n--- ref grammar agreement ---')
{
  const samples = ['DEEPSEEK_API_KEY', 'a', '_x', 'A1_B2', 'lower', '1BAD', 'with space', 'with-dash', 'with.dot', '']
  let agree = 0
  for (const name of samples) {
    const refOk = isPossibleRef(name)
    const envOk = validateEdit(name, 'user-env', 'v').every((p) => p.code !== 'invalid-name' && p.code !== 'empty-name')
    if (refOk === envOk) agree += 1
    else console.log(`      mismatch on ${JSON.stringify(name)}: ref=${String(refOk)} env=${String(envOk)}`)
  }
  ok('ref grammar matches env var name grammar on all samples', agree === samples.length, `${String(agree)}/${String(samples.length)}`)
  ok('dashed name is not a valid ref', !isPossibleRef('WITH-DASH'))
}

// ── 6. 来源文案映射 ─────────────────────────────────────────────────────────
console.log('\n--- source labels ---')
{
  ok('env source labelled', describeSource('env').includes('启动环境'))
  ok('file source labelled', describeSource('file').includes('凭据库'))
  ok('project-env labelled', describeSource('project-env').includes('项目'))
  ok('user-env labelled', describeSource('user-env').includes('DSH_HOME'))
  ok('unknown source shown verbatim', describeSource('weird-source') === 'weird-source')
  ok('missing source handled', describeSource(undefined) === '未知来源')
}

// ── 7. toCredentialView 的纯函数行为 ────────────────────────────────────────
console.log('\n--- view projection ---')
{
  const unconfigured = toCredentialView({ configured: false, writable: true })
  ok('unconfigured+writable is editable', unconfigured.editable === true)
  ok('unconfigured+writable has no blockedReason', unconfigured.blockedReason === undefined)

  const noStore = toCredentialView({ configured: false, writable: false })
  ok('unconfigured+unwritable is not editable', noStore.editable === false)
  ok('unconfigured+unwritable explains no store', String(noStore.blockedReason).includes('没有可写'))

  const configuredWritable = toCredentialView({ configured: true, writable: true, source: 'file' })
  ok('configured+writable is editable', configuredWritable.editable === true)
  ok('configured+writable has no blockedReason', configuredWritable.blockedReason === undefined)

  const configuredShadowed = toCredentialView({ configured: true, writable: false, source: 'project-env' })
  ok('shadowed by project-env explains the layer', String(configuredShadowed.blockedReason).includes('项目 .env'), String(configuredShadowed.blockedReason))

  const undefinedInfo = toCredentialView(undefined)
  ok('undefined info degrades safely', undefinedInfo.configured === false && undefinedInfo.editable === false)
}

// ── 8. 记录枚举 ─────────────────────────────────────────────────────────────
console.log('\n--- record enumeration ---')
{
  const provider = makeProvider({})
  const access = new CredentialAccess(provider)
  const summary = await access.listRecordSummary()
  ok('record summary counts all records', summary.total === 2, String(summary.total))
  ok('record summary groups by kind', summary.byKind['api-key'] === 1 && summary.byKind.grant === 1, JSON.stringify(summary.byKind))
  ok('record summary exposes no values', !JSON.stringify(summary).includes('sk-'), JSON.stringify(summary))
}

// ── 9. 服务缺失时安全降级 ───────────────────────────────────────────────────
console.log('\n--- graceful absence ---')
{
  ok('absent credentials service yields undefined', credentialAccessOf({ get: () => undefined }) === undefined)
  ok('present via ctx.credentials is found', credentialAccessOf({ credentials: makeProvider({}) }) !== undefined)
  ok('present via ctx.get is found', credentialAccessOf({ get: (k) => (k === 'credentials' ? makeProvider({}) : undefined) }) !== undefined)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
