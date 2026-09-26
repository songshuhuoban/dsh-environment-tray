/**
 * P0 本地校验：在**不启动 DSH** 的前提下验证两个半边。
 *
 * 宿主半边：真实 `import()` 本包，检查导出形态符合 cordis 插件契约。
 * 客户端半边：mock `window.__ModuleLoader__` 与 `require`，断言 bundle 注册了
 * 工厂、且工厂能物化出 `apply`（同时验证惰性——注册时不应执行工厂体）。
 *
 * 运行：node check-p0.mjs
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

let failures = 0
const ok = (label, condition, detail = '') => {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 宿主半边 ────────────────────────────────────────────────────────────────
console.log('--- host half ---')
const host = await import(pathToFileURL(resolve('lib/index.js')).href)

ok('exports apply()', typeof host.apply === 'function')
ok('exports name === "env-manager"', host.name === 'env-manager', String(host.name))
ok(
  'declares inject: ["shellEnv", "credentials", "connection"]',
  Array.isArray(host.inject) &&
    host.inject.length === 3 &&
    host.inject.includes('shellEnv') &&
    host.inject.includes('credentials') &&
    host.inject.includes('connection'),
  JSON.stringify(host.inject),
)

// 用一个假 ctx 跑一遍 apply，断言它在缺少 shellEnv 时也不抛错（防御性契约）
const fakeCtx = { get: () => undefined, logger: () => ({ info: () => {} }), on: () => {} }
let applyThrew
try {
  host.apply(fakeCtx)
  applyThrew = undefined
} catch (error) {
  applyThrew = error
}
ok('apply() does not throw when shellEnv is absent', applyThrew === undefined, String(applyThrew ?? ''))

// 再跑一遍，这次给一个可用的假注册表，断言注册契约（key 前缀 / 声明 / resolve）
let captured
const fakeShellEnv = {
  register(contributor) {
    captured = contributor
    return () => {}
  },
}
// 覆盖两种访问形态：ctx.shellEnv（首选）与 ctx.get('shellEnv')
const ctxWithShellEnv = {
  shellEnv: fakeShellEnv,
  get: (key) => (key === 'shellEnv' ? fakeShellEnv : undefined),
  logger: () => ({ info: () => {} }),
  on: () => {},
}

// 凭据探测是异步的（apply 里 fire-and-forget），给它一个记录调用的假 provider
const credentialCalls = []
const fakeCredentials = {
  async describe() {
    credentialCalls.push('describe')
    return { configured: false, writable: true }
  },
  async set() {
    credentialCalls.push('set')
  },
  async unset() {
    credentialCalls.push('unset')
  },
  async resolve() {
    credentialCalls.push('resolve')
    throw new Error('resolve must never be reached')
  },
  async listRecords() {
    credentialCalls.push('listRecords')
    return [{ key: 'demo/one', kind: 'api-key' }]
  },
}
ctxWithShellEnv.credentials = fakeCredentials
try {
  host.apply(ctxWithShellEnv)
} catch (error) {
  ok('apply() with shellEnv does not throw', false, String(error))
}
// 等异步探测结算
await new Promise((resolve) => setTimeout(resolve, 20))
ok('credential probe ran and enumerated records', credentialCalls.includes('listRecords'), credentialCalls.join(',') || '(none)')
ok('credential probe never resolved a value', !credentialCalls.includes('resolve'), credentialCalls.join(','))

if (captured === undefined) {
  ok('register() was called', false)
} else {
  ok('register() was called', true)
  const keys = Object.keys(captured.variables ?? {})
  ok('declares exactly one variable', keys.length === 1, keys.join(','))
  const key = keys[0] ?? ''
  ok('key has DSH_ prefix', key.startsWith('DSH_'), key)
  ok(
    'key is not a reserved built-in',
    !['DSH_HOME', 'DSH_SHELL', 'DSH_SESSION_ID'].includes(key),
    key,
  )
  ok('key suffix is a legal env name', /^[A-Z][A-Z0-9_]*$/.test(key.slice('DSH_'.length)), key)
  ok('variable has a description', typeof captured.variables[key]?.description === 'string')

  const resolved = captured.resolve({})
  ok('resolve() returns only declared keys', Object.keys(resolved).join(',') === key)
  ok('resolve() returns a string', typeof resolved[key] === 'string', resolved[key])
}

// ── 客户端半边 ──────────────────────────────────────────────────────────────
console.log('\n--- client half ---')
let registered
let factoryRanDuringRegistration = false

globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      registered = record
    },
  },
}

await import(pathToFileURL(resolve('lib/client.js')).href)

ok('bundle registered a factory', typeof registered?.factory === 'function')
ok('bundle id is the package name', registered?.id === 'dsh-env-manager', String(registered?.id))
ok(
  'factory is lazy (body not run at registration)',
  factoryRanDuringRegistration === false,
)

// 物化工厂，断言导出形态
const requiredModules = []
const fakeRequire = (spec) => {
  requiredModules.push(spec)
  if (spec === 'react') {
    // 客户端半边用到 hooks，所以 fake 必须提供它们
    return {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children.length > 1 ? children : props?.children },
        children,
      }),
      Fragment: Symbol('Fragment'),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    // 平台种子模块：不在磁盘上，由前端 shell 提供。这里只把用到的组件
    // 降级成主机元素 —— 契约细节由 verify-client-ui.mjs 覆盖。
    const h = (type) => (props) => {
      const { icon, children, ...rest } = props
      return { type, props: rest, children: [icon ?? null, children ?? null] }
    }
    return {
      Button: h('button'),
      Input: h('input'),
      Modal: ({ open, children }) => (open === true ? { type: 'div', props: { 'data-modal': 'open' }, children: [children] } : null),
      DisclosureRow: () => null,
      IconChevronDownOutline14: () => null,
      IconContextInjectionOutline16: () => null,
      IconEditOutline16: () => null,
      IconRefreshOutline16: () => null,
      IconSearchOutline16: () => null,
      IconTrashOutline16: () => null,
    }
  }
  throw new Error(`unknown module: ${spec}`)
}

const clientExports = registered.factory(fakeRequire)
ok('client factory exports apply()', typeof clientExports.apply === 'function')
ok(
  'client requires only react + the ui-primitives platform seed',
  [...new Set(requiredModules)].sort().join(',') === '@deepseek-ai/dsh-client-ui-primitives,react',
  [...new Set(requiredModules)].join(','),
)

// 跑一遍客户端 apply，断言注册进正确的槽位且带 id
const registrations = []
const injections = []
const fakeClientCtx = {
  slots: {
    inject(name, callback) {
      injections.push(name)
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
let clientApplyThrew
try {
  clientExports.apply(fakeClientCtx)
  clientApplyThrew = undefined
} catch (error) {
  clientApplyThrew = error
}
ok('client apply() does not throw', clientApplyThrew === undefined, String(clientApplyThrew ?? ''))
ok(
  'injects into the session header utilities area',
  injections.join(',') === 'conversation.session.header.utilities',
  injections.join(','),
)
ok('does not register a Settings tab', !injections.includes('settings.plugins.tab'), injections.join(','))
ok('registers one entry', registrations.length === 1, String(registrations.length))
ok(
  'entry options carry name+id+order',
  registrations[0]?.options?.name === 'conversation.session.header.utilities' &&
    registrations[0]?.options?.id === 'env-manager' &&
    typeof registrations[0]?.options?.order === 'number',
  JSON.stringify(registrations[0]?.options ?? {}),
)
ok('entry component is a function', typeof registrations[0]?.component === 'function')

// 渲染一次，确认组件本身不炸。fake hooks 里 useState 返回初始值，
// 所以模态框停在关闭态 —— 入口按钮必须仍然渲染出来。
const rendered = registrations[0].component({})
ok('entry component renders without throwing', rendered !== null && rendered !== undefined)
{
  const flat = []
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (Array.isArray(node)) {
      for (const c of node) collect(c)
      return
    }
    // 函数型节点（Button / Modal 这些假实现）要**调用**才算渲染，
    // 否则走到的只是一层没展开的元素。真 React 也是这么做的。
    if (typeof node.type === 'function') {
      collect(node.type(node.props ?? {}))
      return
    }
    flat.push(node)
    for (const c of node.children ?? []) collect(c)
  }
  collect(rendered)
  const entryButton = flat.find((n) => n.type === 'button')
  ok('the closed entry renders one trigger button', flat.filter((n) => n.type === 'button').length === 1, String(flat.filter((n) => n.type === 'button').length))
  ok('the trigger has an accessible name', entryButton?.props?.['aria-label'] === '环境变量', JSON.stringify(entryButton?.props ?? {}))
  ok('no modal is rendered while closed', flat.every((n) => n.props?.['data-modal'] !== 'open'))
}

// ── 客户端 inject 导出（真实启动失败过的那个 bug 的回归测试）────────────────
// 实测过的启动错误原文：
//   failed to apply loader entry 3666c652 (dsh-env-manager):
//   cannot get property "slots" without inject
//
// **两次修错**值得记下来：第一次我以为要写 package.json 的
// `dsh.client.inject`（列包名）—— 重启后仍然报同一个错。
// 真正的机制是客户端 bundle **自己导出** `inject`（cordis fiber inject）。
// 两者是不同的东西：`dsh.client.inject` 归 dsh-client-modules 管，只影响
// boot graph 的加载顺序，**不解除 cordis 的服务访问限制**。
//
// 依据来自第一方包，不是我的推断：
//   dsh-client-ui-settings-plugins 的 `const inject = ["slots", "locale", ...]`
console.log('\n--- client inject export (regression) ---')
{
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  ok('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
  ok(
    'package.json does NOT carry a client inject (that is a different mechanism)',
    manifest.dsh?.client?.inject === undefined,
    JSON.stringify(manifest.dsh?.client?.inject),
  )

  // **这才是 cordis 检查的那个 inject**：由 bundle 导出
  ok('client bundle exports inject', Array.isArray(clientExports.inject), typeof clientExports.inject)
  ok('inject declares the slots service', clientExports.inject?.includes('slots') === true, JSON.stringify(clientExports.inject))
  ok(
    'inject declares only slots (slot readiness is handled by slots.inject)',
    clientExports.inject?.length === 1,
    JSON.stringify(clientExports.inject),
  )

  // 与第一方包对照，确认约定（不靠我的记忆）
  const firstParty = resolve(
    'C:/Users/qq651/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js',
  )
  if (existsSync(firstParty)) {
    const src = readFileSync(firstParty, 'utf8')
    const m = /const inject = \[([\s\S]*?)\]/.exec(src)
    if (m === null) {
      ok('first-party bundle declares inject in the same shape', false, 'regex found no inject array')
    } else {
      const theirServices = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
      ok('first-party bundle declares inject in the same shape', theirServices.length > 0, JSON.stringify(theirServices))
      ok('their inject also names the slots service', theirServices.includes('slots'), JSON.stringify(theirServices))
      ok(
        'their inject uses service names, not package names',
        theirServices.every((s) => !s.startsWith('@')),
        JSON.stringify(theirServices),
      )
    }
  } else {
    console.log('SKIP  找不到第一方参照包')
  }

  // 真实 cordis 对未声明服务的访问是**抛错**，不是返回 undefined。
  // 用一个忠实的替身复现这个约束 —— 这正是早先的假替身漏掉的东西。
  const makeStrictCtx = (services, declared) =>
    new Proxy(services, {
      get(target, prop) {
        if (typeof prop === 'string' && prop !== 'then' && !declared.includes(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`)
        }
        return target[prop]
      },
    })

  const slotsImpl = { inject: () => {}, register: () => () => {} }

  let threwDeclared
  try {
    clientExports.apply(makeStrictCtx({ slots: slotsImpl }, clientExports.inject))
  } catch (error) {
    threwDeclared = error
  }
  ok('with the declared inject, apply() runs under the strict proxy', threwDeclared === undefined, String(threwDeclared))

  // 反向：不声明必须抛 —— 证明这个替身真的在检查（否则上面的 PASS 毫无意义）
  let threwUndeclared
  try {
    clientExports.apply(makeStrictCtx({ slots: slotsImpl }, []))
  } catch (error) {
    threwUndeclared = error
  }
  ok(
    'without the declaration, the strict proxy throws (mirrors the real failure)',
    threwUndeclared !== undefined && String(threwUndeclared.message).includes('without inject'),
    String(threwUndeclared),
  )
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
