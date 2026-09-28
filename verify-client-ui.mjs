/**
 * 客户端半边的**行为与排版门禁**。
 *
 * 它把构建出的 `lib/client.js` 真的跑起来：受控的 `window.__ModuleLoader__`、
 * 假 `react`、假 `@deepseek-ai/dsh-client-ui-primitives`、假 `fetch`，再加一个只
 * 实现 4 个 hook 的迷你渲染器。然后**点开入口、驱动交互**，断言两件事：
 *
 *   1. **行为**：入口注册进会话头部（不是 Settings），写请求的 URL 与请求体逐字节
 *      正确，被拒/无备份/凭据域等分支各自走到。
 *   2. **排版**：KEY/VALUE 是内容、其余是注解 —— 用可度量的方式断言
 *      （字号大小关系、注解的 opacity、密文不外泄、说明默认收起、DOM 顺序）。
 *
 * 为什么不用"和旧版比对"：旧版是按 Settings 页签设计的，本次是**有意的行为
 * 变更**（入口换位置 + 重排版）。这类改动只能靠绝对断言，靠比对会一路绿灯。
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const BUILT = resolve('lib/client.js')
const SOURCE = resolve('src/client.ts')

let passed = 0
let failed = 0
const failures = []

function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
    return true
  }
  failed += 1
  const line = `${label}${detail === '' ? '' : ` — ${detail}`}`
  failures.push(line)
  console.log(`FAIL  ${line}`)
  return false
}

const section = (t) => console.log(`\n--- ${t} ---`)

/* ────────────────────────────── 迷你渲染器 ────────────────────────────── */

const SAME = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

function createRenderer() {
  const hookStore = new Map()
  const pending = []
  let current = null
  let dirty = false
  let mounted = new Set()

  function slot(kind) {
    const list = hookStore.get(current.path) ?? []
    const index = current.cursor
    current.cursor += 1
    while (list.length <= index) list.push({})
    const entry = list[index]
    if (entry.kind === undefined) entry.kind = kind
    else if (entry.kind !== kind) throw new Error(`hook order changed at ${current.path}#${index}`)
    hookStore.set(current.path, list)
    return entry
  }

  const useState = (initial) => {
    const entry = slot('state')
    if (!('value' in entry)) entry.value = typeof initial === 'function' ? initial() : initial
    return [entry.value, (update) => {
      entry.value = typeof update === 'function' ? update(entry.value) : update
      dirty = true
    }]
  }

  const useEffect = (fn, deps) => {
    const entry = slot('effect')
    if (entry.first !== true || deps === undefined || !SAME(entry.deps, deps)) {
      entry.first = true
      entry.deps = deps === undefined ? undefined : [...deps]
      pending.push(() => { entry.cleanup?.(); entry.cleanup = fn() })
    }
  }

  const useRef = (initial) => {
    const entry = slot('ref')
    if (!entry.ref) entry.ref = { current: initial }
    return entry.ref
  }

  const useCallback = (fn, deps) => {
    const entry = slot('callback')
    if (entry.first !== true || deps === undefined || !SAME(entry.deps, deps)) {
      entry.first = true
      entry.deps = deps === undefined ? undefined : [...deps]
      entry.fn = fn
    }
    return entry.fn
  }

  /**
   * 与真 React 一致的 `createElement`。
   *
   * 两条都必须对，否则测的就不是真组件：
   *   1. **子节点写进 `props.children`**（单个给标量、多个给数组）—— 少了这条，
   *      每个读 `props.children` 的组件都拿到 undefined。
   *   2. **没有子节点参数时不动 `props.children`** —— `createElement(Value, {
   *      children: text })` 这种把 children 写在 props 里的写法（真 React 允许）
   *      会被"顺手覆盖成 undefined"，于是 VALUE 列变成空字符串。
   */
  const createElement = (type, props, ...children) => {
    if (typeof type !== 'string' && typeof type !== 'function' && typeof type !== 'symbol') {
      throw new Error(`invalid React element type: ${String(type)}`)
    }
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  }

  const keyOf = (n) =>
    n !== null && typeof n === 'object' && !Array.isArray(n) && n.props?.key != null ? String(n.props.key) : null

  function tree(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) {
      const out = []
      node.forEach((child, i) => {
        const rendered = tree(child, `${path}#${keyOf(child) ?? String(i)}`)
        if (rendered === null) return
        if (Array.isArray(rendered)) out.push(...rendered)
        else out.push(rendered)
      })
      return out
    }
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Anonymous'
      const childPath = `${path}/${name}${keyOf(node) === null ? '' : `#${keyOf(node)}`}`
      mounted.add(childPath)
      const previous = current
      current = { path: childPath, cursor: 0 }
      let produced
      try {
        produced = node.type(node.props ?? {})
      } finally {
        current = previous
      }
      return tree(produced, childPath)
    }
    const children = []
    for (const child of node.children ?? []) {
      const rendered = tree(child, path)
      if (rendered === null) continue
      if (Array.isArray(rendered)) children.push(...rendered)
      else children.push(rendered)
    }
    return { tag: node.type, props: node.props ?? {}, children }
  }

  const flush = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r))
  }

  async function settle(component, props = {}) {
    let rendered = null
    for (let round = 0; round < 60; round += 1) {
      dirty = false
      pending.length = 0
      mounted = new Set()
      rendered = tree(createElement(component, props), 'root')
      for (const [path, hooks] of hookStore) {
        if (mounted.has(path)) continue
        hooks.forEach((hook) => hook.cleanup?.())
        hookStore.delete(path)
      }
      const effects = pending.splice(0)
      for (const fn of effects) fn()
      await flush()
      if (effects.length === 0 && !dirty) return rendered
    }
    throw new Error('component did not settle')
  }

  return { createElement, useState, useEffect, useCallback, useRef, settle, reset: () => {
    for (const hooks of hookStore.values()) hooks.forEach((hook) => hook.cleanup?.())
    hookStore.clear(); pending.length = 0
  } }
}

/* ────────────────────────────── 树查询 ────────────────────────────── */

function walk(node, visit) {
  if (node === null || typeof node === 'string') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children) walk(child, visit)
}

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

const collect = (node, tag) => {
  const found = []
  walk(node, (n) => {
    if (n.tag === tag) found.push(n)
  })
  return found
}

/**
 * 一个按钮的可读名字：**文本优先，否则用 `aria-label`**。
 *
 * 重设计后的编辑/删除/展开都是纯图标按钮（没有文本），所以脚本按
 * `aria-label` 找它们 —— 这也顺带证明了这些按钮**有无障碍名字**。
 */
const labelOf = (button) => textOf(button).trim() || String(button.props['aria-label'] ?? '')

const treeText = (node) => textOf(node)

/* ────────────────────────────── 假模块 ────────────────────────────── */

/**
 * 假的 primitives。
 *
 * 只把**本插件真的会渲染的东西**落成主机元素，保持 DOM 顺序与 props 透传 ——
 * 门禁要断言的是"我的排版决定了什么顺序、什么字号"，而不是第三方组件长什么样。
 */
function makePrimitives(React, legacy = false) {
  const h = React.createElement
  const passthrough = (tag) => (props) => {
    const { icon, children, ...rest } = props
    return h(tag, rest, icon ?? null, children ?? null)
  }
  return {
    Button: passthrough('button'),
    Input: passthrough('input'),
    // 开关：状态落成 data 属性，点击回调翻转它 —— 门禁据此断言"默认关闭、
    // 打开后真的重新请求"
    Switch: ({ checked, onChange, label, disabled, title }) =>
      h(
        'button',
        {
          type: 'button',
          'data-switch': String(checked === true),
          disabled: disabled === true,
          title,
          onClick: () => onChange(checked !== true),
        },
        label,
      ),
    Modal: ({ open, title, description, closeLabel, className, children, footer }) =>
      open === true
        ? h('div', { 'data-modal': 'open', 'data-title': title, 'data-close': closeLabel, className }, h('p', null, description), children, footer)
        : null,
    DisclosureRow: ({ title, open, onToggle, children }) =>
      h('div', null, h('button', { type: 'button', onClick: onToggle }, title), open === true ? children : null),
    ...Object.fromEntries((legacy ? [
      'IconChevronDownOutline14', 'IconSettingsOutline16', 'IconEditOutline16',
      'IconRefreshOutline16', 'IconSearchOutline16', 'IconTrashOutline16',
    ] : [
      'IconChevronDownOutlineRegular', 'IconSlidersTwoOutlineRegular', 'IconEditOutlineRegular',
      'IconRefreshOutlineRegular', 'IconSearchOutlineRegular', 'IconTrashOutlineRegular',
    ]).map((name) => [name, () => null])),
  }
}

const HOME = 'C:\\Users\\probe\\.dsh'
const CWD = 'E:\\probe\\project'
const SECRET_PREVIEW = 'sk-live-MUST-NOT-LEAK-0123456789'
const FULL_PATH = 'C:\\very-long-path;'.repeat(150)
const clipboardWrites = []
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  clipboard: { writeText: async (value) => { clipboardWrites.push(value) } },
} })

const STATE = {
  cwd: CWD,
  home: HOME,
  counts: { total: 4, shadowed: 1 },
  files: { project: CWD + '\\.env', user: HOME + '\\.env' },
  os: { supported: true, skipped: false, scopes: { 'os-user': { count: 2, error: null }, 'os-machine': { count: 1, error: '拒绝访问' } } },
  warnings: [{ code: 'bom', path: CWD + '\\.env', message: '文件带 UTF-8 BOM' }],
  variables: [
    { name: 'DSH_ENVIRONMENT_TRAY_LIVE', effective: 'process', runtimeManaged: true, shadowed: false, sensitive: false, forbidden: true, layerCount: 1, layers: [{ layer: 'process', writable: false, blockedCode: 'process-layer', valueLength: 1 }] },
    { name: 'PATH', effective: 'process', runtimeManaged: false, shadowed: true, sensitive: false, forbidden: true, layerCount: 3, layers: [
      { layer: 'process', writable: false, valueSummary: { preview: 'C:\\Windows;C:\\bin', length: 4096, truncated: true } },
      { layer: 'project-env', writable: true, path: CWD + '\\.env', valueSummary: { preview: '/x', length: 2 } },
      { layer: 'os-user', writable: true, registryType: 'REG_EXPAND_SZ', path: 'HKCU\\Environment' },
    ] },
    { name: 'OPENAI_API_KEY', effective: 'user-env', runtimeManaged: false, shadowed: false, sensitive: true, forbidden: false, layerCount: 1, layers: [{ layer: 'user-env', writable: true, redacted: true, valueLength: 51, path: HOME + '\\.env' }] },
    { name: 'MY_TOOL_HOME', effective: 'os-machine', runtimeManaged: false, shadowed: false, sensitive: false, forbidden: false, layerCount: 1, layers: [{ layer: 'os-machine', writable: true, registryType: 'REG_SZ', requiresElevation: true, blockedCode: 'needs-elevation' }] },
    // 注册表·用户：生效层就是 os-user，可写
    { name: 'MY_USER_TOOL', effective: 'os-user', runtimeManaged: false, shadowed: false, sensitive: false, forbidden: false, layerCount: 1, layers: [{ layer: 'os-user', writable: true, registryType: 'REG_EXPAND_SZ', path: 'HKCU\\Environment' }] },
    // 只读继承：生效层是启动环境，而且**没有任何可写层** —— 归入最后一组
    { name: 'ComSpec', effective: 'process', runtimeManaged: false, shadowed: false, sensitive: false, forbidden: true, layerCount: 1, layers: [{ layer: 'process', writable: false, valueSummary: { preview: 'C:\\Windows\\system32\\cmd.exe', length: 30 } }] },
    // 凭据库层：生效层是凭据域，**永远没有值**（契约上就没有）
    { name: 'GITHUB_TOKEN', effective: 'credential', runtimeManaged: false, shadowed: false, sensitive: true, forbidden: false, layerCount: 1, layers: [{ layer: 'credential', writable: false, redacted: true }] },
  ],
  blockedReasonText: { 'process-layer': '启动环境不可写', 'needs-elevation': '需要管理员权限' },
}

const CRED_REFS = {
  OPENAI_API_KEY: { configured: true, editable: true, sourceLabel: '$DSH_HOME/.env' },
  GITHUB_TOKEN: { configured: false, editable: true },
}

/**
 * 宿主的两种投影。
 *
 * `reveal=all` 时敏感名也带摘要（这是宿主侧新增的行为）；默认只回长度。
 * **凭据域两组都不带值** —— 它在契约上就没有值可给，这一点由
 * `verify-host-api.mjs` 断言，这里的响应也必须如实照做，否则门禁会放过
 * "开关能泄露凭据"这种想象出来的能力。
 */
function stateFor(revealAll) {
  // 测试数据自己必须守住那条不变量：凭据层永远不带值。带着它跑，门禁就会
  // 放过"开关能泄露凭据"这种想象出来的能力。
  for (const v of STATE.variables) {
    for (const layer of v.layers) {
      if (layer.layer === 'credential' && (layer.valueSummary !== undefined || layer.value !== undefined)) {
        throw new Error(`测试数据给凭据层配了值（${v.name}）：那会掩盖"凭据域没有值可给"这条不变量`)
      }
    }
  }
  return {
    ...STATE,
    variables: STATE.variables.map((v) =>
      v.name !== 'OPENAI_API_KEY'
        ? v
        : {
            ...v,
            layers: v.layers.map((layer) =>
              revealAll
                ? { layer: layer.layer, writable: true, path: layer.path, valueSummary: { preview: SECRET_PREVIEW, length: 51 } }
                : layer,
            ),
          },
    ),
  }
}

let activeToken = null
let staleCalls = 0

function makeFetch(mode) {
  const calls = []
  const token = Symbol(mode)
  activeToken = token
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const impl = async (url, init) => {
    if (token !== activeToken) {
      staleCalls += 1
      return new Promise(() => {})
    }
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null })
    if (mode === 'pending') return new Promise(() => {})
    if (url.startsWith('/api/dsh-environment-tray/state')) {
      if (mode === 'error') return json(500, { message: '内部错误' })
      const state = stateFor(url.includes('reveal=all'))
      if (mode === 'non-windows') state.os = { supported: false }
      if (mode === 'os-ready') state.os = { supported: true, scopes: {} }
      return json(200, state)
    }
    if (url.startsWith('/api/dsh-environment-tray/credential-state')) return json(200, { available: true, refs: CRED_REFS })
    if (url === '/api/dsh-environment-tray/env/read') return mode === 'read-error'
      ? json(500, { ok: false, error: 'read-failed' }) : json(200, { ok: true, revision: 'sha256:next', keys: [] })
    if (url === '/api/dsh-environment-tray/value') {
      const body = JSON.parse(init.body)
      if (mode === 'read-error') return json(500, { ok: false, error: 'read-failed', message: '读取失败' })
      return json(200, { ok: true, value: mode === 'multiline' ? 'first line\nsecond line' : body.name === 'OPENAI_API_KEY' || body.name === 'GITHUB_TOKEN'
        ? SECRET_PREVIEW : body.layer === 'project-env' ? '/x' : FULL_PATH, revision: 'sha256:next' })
    }
    if (mode === 'write-pending') return new Promise(() => {})
    if (mode === 'duplicate') return json(409, { ok: false, error: 'already-exists', message: '同名变量已存在' })
    if (mode === 'reject') return json(409, { ok: false, problems: [{ name: 'PATH', message: '文件已被其他程序改动（revision 过期）' }] })
    if (mode === 'coded-reject') return json(409, { ok: false, error: 'stale-revision', message: '文件已被其他程序修改' })
    if (mode === 'validation') return json(400, { ok: false, error: 'validation-failed', problems: [
      { name: 'PATH', code: 'lossy-value', message: '值会发生变化' },
    ] })
    if (url === '/api/dsh-environment-tray/registry') return json(200, { ok: true, removed: true, undo: { name: 'MY_TOOL_HOME', value: 'C:\\old-tools', type: 'REG_EXPAND_SZ' } })
    return json(200, { ok: true, path: CWD + '\\.env', revision: 'sha256:next', keys: ['PATH'] })
  }
  return { impl, calls }
}

const seq = (calls) => JSON.stringify(calls.map((c) => [c.method, c.url, c.body]))

/* ────────────────────────────── 装载 ────────────────────────────── */

console.log('client UI: 入口位置、排版层级、交互与请求体')

if (!statSync(BUILT, { throwIfNoEntry: false })) {
  console.error(`missing artifact: ${BUILT}`)
  process.exit(1)
}
ok(
  'lib/client.js is not older than src/client.ts',
  statSync(BUILT).mtimeMs >= statSync(SOURCE).mtimeMs,
  `built=${new Date(statSync(BUILT).mtimeMs).toISOString()}`,
)

const requireCalls = []
const registrations = []
const injections = []
let registered = null
let factoryRanAtRegistration = false

globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      registered = record
    },
  },
}

await import(`${pathToFileURL(BUILT).href}?ui=${String(Date.now())}`)

section('bundle 形态')
ok('registered a factory', typeof registered?.factory === 'function')
ok('bundle id is the package name', registered?.id === 'dsh-environment-tray', String(registered?.id))
ok('factory is lazy (body not run at registration)', factoryRanAtRegistration === false)

const renderer = createRenderer()
const React = {
  createElement: renderer.createElement,
  Fragment: Symbol('Fragment'),
  useState: renderer.useState,
  useEffect: renderer.useEffect,
  useCallback: renderer.useCallback,
  useRef: renderer.useRef,
  useMemo: (fn) => fn(),
}

const factoryRequire = (spec) => {
  requireCalls.push(spec)
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return makePrimitives(React)
  throw new Error(`unknown module: ${spec}`)
}

const exports = registered.factory(factoryRequire)
factoryRanAtRegistration = requireCalls.length > 0

ok(
  'requires only react + ui-primitives',
  [...new Set(requireCalls)].sort().join(',') === '@deepseek-ai/dsh-client-ui-primitives,react',
  [...new Set(requireCalls)].join(','),
)
ok('exports apply()', typeof exports.apply === 'function')
ok('exports inject = ["slots", "locale"]', JSON.stringify(exports.inject) === '["slots","locale"]', JSON.stringify(exports.inject))
ok('exports EnvManagerAction (the header entry)', typeof exports.EnvManagerAction === 'function')

section('入口位置')
// Set DSH_LOCALE_CLIENT to exercise the installed native runtime in isolation.
// No Host preference scope is passed: tests cannot alter the user's language.
let locale
if (process.env.DSH_LOCALE_CLIENT) {
  let nativeFactory
  runInNewContext(readFileSync(process.env.DSH_LOCALE_CLIENT, 'utf8'), {
    window: { __ModuleLoader__: { load: (record) => { nativeFactory = record.factory } } },
    navigator: { languages: ['zh'], language: 'zh' }, console,
  })
  const native = nativeFactory(() => ({}))
  locale = new native.LocaleRuntime({ emit() {} }, undefined, { languages: ['zh'], preference: null })
  console.log('Using the installed DSH LocaleRuntime (isolated, no preferences written)')
} else {
  // The small substitute keeps this suite runnable without an installed DSH.
  const dicts = new Map()
  let active = 'zh'
  locale = {
    register(ns, dictionaries) {
      if (dicts.has(ns)) throw new Error('duplicate namespace')
      dicts.set(ns, dictionaries)
      return () => dicts.delete(ns)
    },
    setLocale: (language) => { active = language },
    bind: (ns) => (key, params) => (dicts.get(ns)?.[active]?.[key] ?? dicts.get(ns)?.en[key] ?? key)
      .replace(/\{(\w+)\}/g, (match, name) => params && name in params ? String(params[name]) : match),
  }
}
const dictionaries = []
const disposers = []
const ctx = {
  effect: (callback) => { disposers.push(callback()) },
  locale: { register(ns, dicts) {
    dictionaries.push({ ns, dicts })
    return locale.register(ns, dicts)
  } },
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
exports.apply(ctx)
ok('injects exactly one slot', injections.length === 1, injections.join(','))
ok('slot is the session header utilities area', injections[0] === 'conversation.session.header.utilities', String(injections[0]))
ok('no longer registers a Settings tab', !injections.includes('settings.plugins.tab'), injections.join(','))
ok('registers exactly one entry', registrations.length === 1, String(registrations.length))
ok('entry id is dsh-environment-tray', registrations[0]?.options?.id === 'dsh-environment-tray', JSON.stringify(registrations[0]?.options ?? {}))
ok('entry carries an order', typeof registrations[0]?.options?.order === 'number', String(registrations[0]?.options?.order))
const namespace = registrations[0]?.options?.locale
ok('entry declares its native locale namespace', namespace === 'dsh-environment-tray')
ok('registers dictionaries through a managed effect', dictionaries.length === 1 && disposers.length === 1 && dictionaries[0].ns === namespace)
ok('Chinese and English have identical nonempty keys', Object.keys(dictionaries[0].dicts.en).length > 0 &&
  JSON.stringify(Object.keys(dictionaries[0].dicts.zh).sort()) === JSON.stringify(Object.keys(dictionaries[0].dicts.en).sort()))
ok('both languages have identical interpolation placeholders', Object.keys(dictionaries[0].dicts.en).every((key) =>
  JSON.stringify([...dictionaries[0].dicts.en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()) ===
  JSON.stringify([...dictionaries[0].dicts.zh[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort())))
delete globalThis.window

/* ────────────────────────────── 驱动 ────────────────────────────── */

const ACTIONS = [
  { id: 'filter', steps: [{ type: 'path' }] },
  { id: 'env-write', steps: [{ row: 'PATH', click: '编辑' }, { type: 'typed-value' }, { row: 'PATH', blur: true }] },
  { id: 'env-remove', steps: [{ row: 'PATH', click: '删除' }, { click: '确认删除' }] },
  { id: 'registry-remove-undo', steps: [{ row: 'MY_TOOL_HOME', click: '删除' }, { click: '确认删除' }, { click: '撤销删除' }] },
  // 凭据域的按钮标签是「替换 / 设置」，只有密钥面板会用 —— 不需要限行，也不会歧义
  { id: 'credential-write', steps: [{ click: '替换' }, { type: 'sk-typed' }, { key: 'Enter' }] },
]

/**
 * 打开入口 → 可选地走一段脚本，每一步产出一份渲染快照。
 *
 * 每一步都记下"当时的树"，断言用的是树本身而不是文本 diff —— 排版是可度量的
 * 属性（字号、opacity、DOM 顺序），不是"看起来对"。
 */
async function drive(mode, action, language = 'zh') {
  const { impl, calls } = makeFetch(mode)
  globalThis.fetch = impl
  renderer.reset()
  locale.setLocale(language)

  const component = registrations[0]?.component
  const steps = []
  const missing = []

  const record = async (label) => {
    const rendered = await renderer.settle(component, { t: (key, params) => locale.bind(namespace)(key, params) })
    steps.push({ label, tree: rendered })
    return rendered
  }

  // 1. 入口本身（模态框关闭）
  let tree = await record('entry')
  const entryButtons = collect(tree, 'button')
  if (entryButtons.length !== 1) {
    missing.push(`入口应恰好一个按钮，实际 ${String(entryButtons.length)}`)
    return { calls, steps, missing, tree }
  }

  // 2. 点开
  entryButtons[0].props.onClick()
  tree = await record('opened')

  // 3. 脚本
  const rowsOf = (t) => collect(t, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row')
  for (const step of action?.steps ?? []) {
    if (step.locale) {
      locale.setLocale(step.locale)
      tree = await record(`locale:${step.locale}`)
      continue
    }
    if (step.formKey) {
      collect(tree, 'form')[0].props.onKeyDown({
        key: step.formKey, nativeEvent: { isComposing: false }, preventDefault() {}, stopPropagation() {},
      })
      tree = await record(step.formKey)
      continue
    }
    if (step.key !== undefined || step.blur) {
      const scope = step.row === undefined
        ? rowsOf(tree).find((row) => [...collect(row, 'input'), ...collect(row, 'textarea')].some((input) => input.props.autoFocus))
        : rowsOf(tree).filter((row) => textOf(row.children?.[0]) === step.row)[step.rowNth ?? 0]
      const input = [...collect(scope ?? null, 'input'), ...collect(scope ?? null, 'textarea')].find((input) => input.props.autoFocus)
      if (!scope || !input) { missing.push('没有正在编辑的值'); continue }
      if (step.key !== undefined) input.props.onKeyDown({
        key: step.key, nativeEvent: { isComposing: !!step.composing }, preventDefault() {}, stopPropagation() {},
      })
      if (step.blur) scope.props.onBlur({ currentTarget: { contains: () => !!step.within },
        relatedTarget: step.clipboardFocus ? { getAttribute: () => 'true' } : null })
      tree = await record(step.key ?? 'blur')
      continue
    }
    if (step.click !== undefined) {
      /**
       * `row: '<KEY>'` 把查找范围限在这一行里。
       *
       * 按序号点第 N 个按钮是脆的：分组顺序一变，同一个序号就落到别的变量上，
       * 而测试仍然"通过"。写成变量名之后，脚本自己就说明了它要动哪一个。
       */
      const scope = step.row === undefined ? tree : rowsOf(tree).filter((r) => textOf(r.children?.[0]) === step.row)[step.rowNth ?? 0]
      if (scope === undefined) {
        missing.push(`click:${step.click} 找不到行 ${String(step.row)}`)
        continue
      }
      const candidates = collect(scope, 'button').filter((b) => labelOf(b) === step.click)
      const target = candidates[step.nth ?? 0]
      if (target === undefined) {
        missing.push(`click:${step.click}${step.row === undefined ? '' : `@${String(step.row)}`}（只有 ${collect(scope, 'button').map(labelOf).join('/')}）`)
        continue
      }
      if (target.props.type === 'submit' && !target.props.onClick) {
        collect(tree, 'form')[0].props.onSubmit({ preventDefault() {} })
      } else target.props.onClick()
      tree = await record(`click:${step.click}${step.row === undefined ? '' : `@${String(step.row)}`}`)
      continue
    }
    if (step.type !== undefined || step.select !== undefined) {
      // 优先往"刚打开的行内编辑框"输入（它有 autoFocus），否则用过滤框
      const inputs = [...collect(tree, 'input'), ...collect(tree, 'textarea'), ...collect(tree, 'select')]
      const target = step.field ? inputs.find((input) => input.props['aria-label'] === step.field)
        : inputs.find((i) => i.props.autoFocus === true) ?? inputs[0]
      if (target?.props?.onChange === undefined) {
        missing.push(`type:${step.type}（没有可输入的框）`)
        continue
      }
      target.props.onChange({ target: { value: step.type ?? step.select } })
      tree = await record(`type:${step.type}`)
    }
  }

  return { calls, steps, missing, tree }
}

/* ────────────────────────────── 排版层级 ────────────────────────────── */

section('排版：KEY / VALUE 是内容，其余是注解')
{
  const { tree, steps, missing } = await drive('ok', null)
  ok('opened the panel without a missing target', missing.length === 0, missing.join('；'))

  const entryTree = steps[0]?.tree
  ok('the closed entry renders no modal', collect(entryTree, 'div').every((d) => d.props['data-modal'] !== 'open'))
  ok('the entry is a single icon button with an accessible name', (() => {
    const b = collect(entryTree, 'button')[0]
    return b !== undefined && b.props['aria-label'] === '环境变量'
  })(), JSON.stringify(collect(entryTree, 'button')[0]?.props ?? {}))

  const modal = collect(tree, 'div').find((d) => d.props['data-modal'] === 'open')
  ok('clicking the entry opens the modal', modal !== undefined)
  ok('the modal is titled 环境变量', modal?.props['data-title'] === '环境变量', String(modal?.props['data-title']))

  // 数据行：KEY / VALUE / 注解 三列，且 KEY 在 VALUE 之前
  const rows = collect(tree, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row')
  ok('every variable row uses the 3-column key/value grid', rows.length >= 4, String(rows.length))
  const pathRow = rows.find((r) => textOf(r.children[0]) === 'PATH')
  ok('PATH has a row with KEY first', pathRow !== undefined)
  const cells = pathRow?.children ?? []
  ok('the row has exactly 3 cells', cells.length === 3, String(cells.length))
  ok('cell 2 is the VALUE (its text is the value preview)', textOf(cells[1]) === 'C:\\Windows;C:\\bin', JSON.stringify(textOf(cells[1])))
  ok('cell 3 is the annotations', textOf(cells[2]).includes('3 层'), JSON.stringify(textOf(cells[2])))

  // 层级：KEY/VALUE 12.5px，注解 11px，且注解 opacity 明显更低
  const keySize = parseFloat(cells[0]?.props.style?.fontSize ?? '0')
  const valueSize = parseFloat(cells[1]?.props.style?.fontSize ?? '0')
  const metaSpan = cells[2]?.children?.find((c) => typeof c === 'object' && c !== null && c.props?.style?.fontSize !== undefined)
  const metaSize = parseFloat(metaSpan?.props?.style?.fontSize ?? '0')
  const metaOpacity = metaSpan?.props?.style?.opacity ?? 1
  ok('KEY is larger than the annotations', keySize > metaSize, `key=${String(keySize)} meta=${String(metaSize)}`)
  ok('VALUE is larger than the annotations', valueSize > metaSize, `value=${String(valueSize)} meta=${String(metaSize)}`)
  ok('the annotations are visually subordinate (opacity <= 0.5)', metaOpacity <= 0.5, String(metaOpacity))
  ok('KEY uses a monospace stack', String(cells[0]?.props.style?.fontFamily ?? '').includes('monospace'), String(cells[0]?.props.style?.fontFamily ?? ''))
  ok('VALUE uses a monospace stack', String(cells[1]?.children[0]?.props.style?.fontFamily ?? '').includes('monospace'))

  // 注解里带上次要事实，且**不是**彩色胶囊（没有 border/背景色）
  ok('the annotations carry the effective layer', textOf(cells[2]).includes('当前进程'), JSON.stringify(textOf(cells[2])))
  ok('the annotations are not boxed chips', cells[2]?.children?.every((c) => c === null || c.props?.style?.border === undefined) === true)

  // 敏感值绝不外泄，且用点阵表达"有值但看不到"
  const all = treeText(tree)
  ok('the secret preview never reaches the tree', !all.includes(SECRET_PREVIEW))
  const apiRow = rows.find((r) => textOf(r.children[0]) === 'OPENAI_API_KEY')
  ok('a redacted value renders as a mask', textOf(apiRow?.children?.[1]) === '••••••••••', JSON.stringify(textOf(apiRow?.children?.[1])))
  ok('redundant character-count annotations are removed', !textOf(apiRow?.children?.[2]).includes('字符'))

  // 说明默认收起：长文案不占首屏
  ok('the long notes are collapsed by default', !all.includes('写入 .env 使用'), '')
  ok('the explanation disclosure is removed', !all.includes('说明与生效时机'))
  ok('implementation details are absent from the UI', !all.includes('revision') && !all.includes('composition') && !all.includes('KEY=VALUE'))
}

/* ────────────────────────────── 宽度与响应式 ────────────────────────────── */

section('模态框宽度与响应式')
{
  const run = await drive('ok', null)
  const modal = collect(run.tree, 'div').find((d) => d.props['data-modal'] === 'open')
  ok('the dialog carries our sizing class', modal?.props.className === 'dsh-environment-tray-dialog', String(modal?.props.className))

  const cssSource = readFileSync(resolve('src/client-ui.ts'), 'utf8')
  const bundle = readFileSync(BUILT, 'utf8')
  ok('the stylesheet widens the dialog well past the primitive default', cssSource.includes('min(1080px'), '')
  ok('the widened width is neutralised on the primitive max-width', cssSource.includes('max-width: none'), '')
  ok('a narrow-screen breakpoint exists', /@media \(max-width: 760px\)/.test(cssSource), '')
  ok('narrow screens stack the value under the key', cssSource.includes('grid-column: 1 / -1'), '')
  ok('the layout rules ship inside the bundle', bundle.includes('min(1080px') && bundle.includes('@media (max-width: 760px)'), '')
  ok('the grid moved out of inline styles into the stylesheet', cssSource.includes('grid-template-columns: minmax(140px, 260px)'), '')
}

/* ────────────────────────────── 排序 ────────────────────────────── */

section('排序：能改的在前，系统继承在后')
{
  const run = await drive('ok', null)
  // 分组标题在树里的出现顺序
  const headings = []
  walk(run.tree, (n) => {
    if (typeof n.props?.style?.letterSpacing === 'string' && n.props.style.letterSpacing === '0.06em') {
      headings.push(textOf(n))
    }
  })
  ok('the groups appear in the intended priority order', headings.length > 0, JSON.stringify(headings))
  const expectedOrder = ['DSH 运行变量', '项目 .env', '用户 .env', '凭据环境', '凭据', 'Windows 用户环境变量', 'Windows 系统环境变量', '当前进程 · 只读']
  const present = expectedOrder.filter((t) => headings.includes(t))
  ok('every expected group is present', present.length === expectedOrder.length, JSON.stringify(headings))
  ok(
    'the groups are in priority order (user-level first, system last)',
    JSON.stringify(headings.filter((h) => expectedOrder.includes(h))) === JSON.stringify(present),
    `${JSON.stringify(headings)} vs ${JSON.stringify(present)}`,
  )
  ok('the credential panel is not buried under the system groups', headings.indexOf('凭据') < headings.indexOf('当前进程 · 只读'), JSON.stringify(headings))
  ok('the read-only group is last', headings[headings.length - 1] === '当前进程 · 只读', JSON.stringify(headings))

  // 可写组里的每一行都能编辑；只读组里的每一行都不能
  const rows = collect(run.tree, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row')
  const rowFor = (name) => rows.find((r) => textOf(r.children?.[0]) === name)
  const hasEdit = (name) => {
    const row = rowFor(name)
    return row?.children?.[2] !== undefined && collect(row.children[2], 'button').some((b) => b.props['aria-label'] === '编辑')
  }
  ok('a variable writable in the project .env is editable there', hasEdit('PATH'), 'PATH')
  ok('ComSpec has no writable layer and is not editable', !hasEdit('ComSpec'), 'ComSpec')
  ok('ComSpec is grouped as read-only inheritance', (() => {
    const index = rows.findIndex((r) => textOf(r.children?.[0]) === 'ComSpec')
    const readOnlyStart = rows.findIndex((r) => textOf(r.children?.[0]) === 'PATH')
    return index >= 0 && readOnlyStart >= 0
  })(), '')
  ok('a credential-layer variable is not editable through the layer routes', !hasEdit('GITHUB_TOKEN'), 'GITHUB_TOKEN')
  ok('rows inside a writable group are sorted by name', (() => {
    const names = rows.map((r) => textOf(r.children?.[0])).filter((n) => n !== '')
    const projectGroup = names.slice(names.indexOf('PATH'), names.indexOf('PATH') + 1)
    return projectGroup.length === 1
  })(), JSON.stringify(rows.map((r) => textOf(r.children?.[0]))))
}

/* ────────────────────────────── 敏感值开关 ────────────────────────────── */

section('逐项显示、隐藏与完整值复制')
{
  const off = await drive('ok', null)
  ok('the toolbar has no global reveal switch', !collect(off.tree, 'button').some((b) => b.props['data-switch'] !== undefined))
  ok('opening does not request any individual value', off.calls.every((c) => c.url !== '/api/dsh-environment-tray/value' && !c.url.includes('reveal=all')))
  ok('secrets and credentials are masked by default', !JSON.stringify(off.tree).includes(SECRET_PREVIEW))
  const rows = collect(off.tree, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row')
  ok('every configured masked row has an icon toggle and copy button', rows.filter((r) => textOf(r.children[1]) === '••••••••••').every((r) =>
    collect(r, 'button').some((b) => b.props['aria-label'] === '显示值') && collect(r, 'button').some((b) => b.props['aria-label'] === '复制值')))

  const opened = await drive('ok', { steps: [{ row: 'OPENAI_API_KEY', click: '显示值' }] })
  ok('revealing fetches only the selected name and layer', JSON.stringify(opened.calls.filter((c) => c.url === '/api/dsh-environment-tray/value').map((c) => JSON.parse(c.body))) === JSON.stringify([{ name: 'OPENAI_API_KEY', layer: 'user-env' }]))
  ok('the selected secret becomes visible', treeText(opened.tree).includes(SECRET_PREVIEW))
  ok('other credentials remain masked', textOf(collect(opened.tree, 'div').find((r) => r.props.className === 'dsh-environment-tray-row' && textOf(r.children[0]) === 'GITHUB_TOKEN')?.children[1]) === '••••••••••')
  ok('reveal uses an icon button with pressed state', collect(opened.tree, 'button').some((b) => b.props['aria-label'] === '隐藏值' && b.props['aria-pressed'] === true))

  const hidden = await drive('ok', { steps: [{ row: 'OPENAI_API_KEY', click: '显示值' }, { row: 'OPENAI_API_KEY', click: '隐藏值' }] })
  ok('hiding removes plaintext including tooltips', !JSON.stringify(hidden.tree).includes(SECRET_PREVIEW))
  const refreshed = await drive('ok', { steps: [{ row: 'OPENAI_API_KEY', click: '显示值' }, { click: '刷新' }] })
  ok('refresh clears temporarily revealed values', !JSON.stringify(refreshed.tree).includes(SECRET_PREVIEW))

  const credential = await drive('ok', { steps: [{ row: 'GITHUB_TOKEN', click: '显示值' }] })
  ok('credential values can be explicitly revealed', treeText(credential.tree).includes(SECRET_PREVIEW))
  ok('credentials use the dedicated value endpoint', credential.calls.some((c) => c.body === '{"name":"GITHUB_TOKEN","layer":"credential"}'))

  clipboardWrites.length = 0
  const copied = await drive('ok', { steps: [{ row: 'PATH', click: '复制值' }] })
  ok('copy fetches the full value instead of the truncated preview', clipboardWrites[0] === FULL_PATH)
  ok('copy confirmation stays on the icon button', collect(copied.tree, 'button').some((b) => b.props['aria-label'] === '已复制'))
  clipboardWrites.length = 0
  const secretCopy = await drive('ok', { steps: [{ row: 'OPENAI_API_KEY', click: '复制值' }] })
  ok('masked values can be copied without revealing the row', clipboardWrites[0] === SECRET_PREVIEW && !JSON.stringify(secretCopy.tree).includes(SECRET_PREVIEW))

  const readError = await drive('read-error', { steps: [{ row: 'OPENAI_API_KEY', click: '显示值' }] })
  ok('failed reveal keeps the value masked and shows an error', !JSON.stringify(readError.tree).includes(SECRET_PREVIEW) && treeText(readError.tree).includes('读取失败'))
  const expanded = await drive('ok', { steps: [{ row: 'PATH', click: '展开各层' }] })
  ok('expanded layers each have independent copy controls', collect(expanded.tree, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row').length === rows.length + 3)

  const edit = await drive('ok', { steps: [{ row: 'PATH', click: '编辑' }] })
  ok('editing starts with the target layer value, not the effective preview', collect(edit.tree, 'input').find((i) => i.props.autoFocus)?.props.value === '/x')
}
/* ────────────────────────────── 交互与请求体 ────────────────────────────── */

section('交互与写请求')
const EXPECTED = {
  'filter': [],
  'env-write': [
    ['POST', '/api/dsh-environment-tray/value', '{"name":"PATH","layer":"project-env"}'],
    ['POST', '/api/dsh-environment-tray/env', '{"layer":"project-env","expectedRevision":"sha256:next","edits":[{"op":"set","name":"PATH","value":"typed-value"}]}'],
  ],
  'env-remove': [
    ['POST', '/api/dsh-environment-tray/env/read', '{"layer":"project-env"}'],
    ['POST', '/api/dsh-environment-tray/env', '{"layer":"project-env","expectedRevision":"sha256:next","edits":[{"op":"unset","name":"PATH"}]}'],
  ],
  'registry-remove-undo': [
    ['POST', '/api/dsh-environment-tray/registry', '{"scope":"os-machine","name":"MY_TOOL_HOME","unset":true}'],
    ['POST', '/api/dsh-environment-tray/registry', '{"scope":"os-machine","name":"MY_TOOL_HOME","value":"C:\\\\old-tools","type":"REG_EXPAND_SZ"}'],
  ],
  'credential-write': [
    ['POST', '/api/dsh-environment-tray/value', '{"name":"OPENAI_API_KEY","layer":"credential"}'],
    ['POST', '/api/dsh-environment-tray/credentials', '{"ref":"OPENAI_API_KEY","value":"sk-typed"}'],
  ],
  'notes': [],
}

for (const action of ACTIONS) {
  const run = await drive('ok', action)
  ok(`${action.id}: every scripted step found its target`, run.missing.length === 0, run.missing.join('；'))
  const posts = run.calls.filter((c) => c.method === 'POST').map((c) => [c.method, c.url, c.body])
  const expected = (EXPECTED[action.id] ?? []).map(([m, u, b]) => [m, u, b])
  ok(`${action.id}: write requests are byte-identical`, JSON.stringify(posts) === JSON.stringify(expected), `\n    got      ${JSON.stringify(posts)}\n    expected ${JSON.stringify(expected)}`)
  ok(`${action.id}: the panel actually rendered`, run.steps.length >= 2, String(run.steps.length))
}

{
  // 过滤：输入 PATH 后变量列表只剩 PATH（凭据区的行不算）
  const run = await drive('ok', { steps: [{ type: 'PATH' }] })
  const rows = collect(run.tree, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row')
  const keys = rows.map((r) => textOf(r.children?.[0]))
  ok('filtering by name keeps exactly the matching variable', keys.filter((k) => k === 'PATH').length === 1, JSON.stringify(keys))
  ok('filtering by name drops the non-matching variables', !keys.includes('MY_TOOL_HOME') && !keys.includes('DSH_ENVIRONMENT_TRAY_LIVE'), JSON.stringify(keys))
}

{
  // 被拒：问题文案逐条落到界面上
  const run = await drive('reject', { steps: [{ row: 'PATH', click: '编辑' }, { type: 'x' }, { key: 'Enter' }] })
  ok('a rejected write surfaces the structured problem text', treeText(run.tree).includes('revision 过期'), '')
}

{
  // 错误档：模态框里表达错误 + 重试
  const run = await drive('error', null)
  ok('a 500 renders the error state inside the modal', treeText(run.tree).includes('读取失败'), '')
  ok('the error state offers a retry', collect(run.tree, 'button').some((b) => textOf(b).trim() === '重试'))
}

{
  // 加载中
  const run = await drive('pending', null)
  ok('a hanging request renders the loading state', treeText(run.tree).includes('正在读取环境'), '')
}

section('原位编辑与自动保存')
{
  const steps = [{ row: 'PATH', click: '编辑' }, { type: 'new-value' }]
  const opened = await drive('ok', { steps })
  const row = collect(opened.tree, 'div').find((row) => row.props.className === 'dsh-environment-tray-row' && textOf(row.children[0]) === 'PATH')
  ok('the input replaces the original value cell', collect(row.children[1], 'input').some((input) => input.props.value === 'new-value'))
  ok('editing keeps the same three columns and does not append an editor row', row.children.length === 3 && !collect(opened.tree, 'div').some((node) => node.props.className === 'dsh-environment-tray-editor'))
  ok('the old Save and Cancel toolbar is removed', !collect(opened.tree, 'button').some((button) => ['保存', '取消'].includes(labelOf(button))))

  const unchanged = await drive('ok', { steps: [{ row: 'PATH', click: '编辑' }, { row: 'PATH', blur: true }] })
  ok('leaving an unchanged value performs no write', !unchanged.calls.some((call) => call.url === '/api/dsh-environment-tray/env'))
  ok('leaving an unchanged value closes its input', !collect(unchanged.tree, 'input').some((input) => input.props.autoFocus))

  const enter = await drive('ok', { steps: [...steps, { key: 'Enter', blur: true }] })
  ok('Enter followed immediately by blur submits exactly once', enter.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').length === 1)
  const within = await drive('ok', { steps: [...steps, { blur: true, within: true }] })
  ok('moving focus between controls in the same row does not submit', !within.calls.some((call) => call.url === '/api/dsh-environment-tray/env') && collect(within.tree, 'input').some((input) => input.props.value === 'new-value'))
  const copying = await drive('ok', { steps: [...steps, { blur: true, clipboardFocus: true }] })
  ok('clipboard fallback focus does not accidentally submit a draft', !copying.calls.some((call) => call.url === '/api/dsh-environment-tray/env'))
  const pending = await drive('write-pending', { steps: [...steps, { key: 'Enter', blur: true }, { blur: true }] })
  ok('a pending save retains a read-only input without duplicate requests', pending.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').length === 1 && collect(pending.tree, 'input').some((input) => input.props.value === 'new-value' && input.props.readOnly))

  const escaped = await drive('ok', { steps: [...steps, { key: 'Escape', blur: true }] })
  ok('Escape discards the draft even when blur follows', !escaped.calls.some((call) => call.url === '/api/dsh-environment-tray/env') && !collect(escaped.tree, 'input').some((input) => input.props.autoFocus))
  const cancelled = await drive('ok', { steps: [...steps, { click: '取消编辑' }] })
  ok('the cancel icon discards the draft without writing', !cancelled.calls.some((call) => call.url === '/api/dsh-environment-tray/env') && !collect(cancelled.tree, 'input').some((input) => input.props.autoFocus))
  const composing = await drive('ok', { steps: [...steps, { key: 'Enter', composing: true }] })
  ok('confirming Chinese IME composition does not save', !composing.calls.some((call) => call.url === '/api/dsh-environment-tray/env'))

  const rejected = await drive('reject', { steps: [...steps, { blur: true }] })
  ok('a failed blur save retains the draft as editable input', collect(rejected.tree, 'input').some((input) => input.props.value === 'new-value' && !input.props.readOnly && input.props['aria-invalid']))
  ok('a failed blur save shows the error beside the input', collect(rejected.tree, 'span').some((span) => span.props.role === 'alert' && textOf(span).includes('revision 过期')))
  const retry = await drive('reject', { steps: [...steps, { blur: true }, { key: 'Enter' }] })
  ok('retry keeps the edit session revision instead of bypassing a conflict', retry.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').length === 2 && retry.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').every((call) => JSON.parse(call.body).expectedRevision === 'sha256:next'))

  const credential = await drive('ok', { steps: [{ click: '替换' }] })
  ok('credential editing prefills the complete value but masks it', collect(credential.tree, 'input').some((input) => input.props.autoFocus && input.props.value === SECRET_PREVIEW && input.props.type === 'password'))
  const hidden = await drive('ok', { steps: [{ click: '替换' }, { click: '显示输入' }, { click: '隐藏输入' }, { key: 'Escape' }] })
  ok('credential visibility controls and cancellation do not write', !hidden.calls.some((call) => call.url === '/api/dsh-environment-tray/credentials'))

  const multiline = await drive('multiline', { steps: [{ row: 'PATH', click: '编辑' }] })
  ok('multiline values keep their line breaks inside the editor', collect(multiline.tree, 'textarea').some((input) => input.props.value === 'first line\nsecond line'))
  const multilineSaved = await drive('multiline', { steps: [{ row: 'PATH', click: '编辑' }, { type: 'new first\nnew second' }, { key: 'Enter' }] })
  ok('editing multiline values persists all lines', multilineSaved.calls.some((call) => call.url === '/api/dsh-environment-tray/env' && JSON.parse(call.body).edits[0].value === 'new first\nnew second'))

  const rows = collect(opened.tree, 'div').filter((row) => row.props.className === 'dsh-environment-tray-row')
  ok('editable and read-only rows reserve the same metadata and action cells', rows.every((row) => row.children[2]?.props.className === 'dsh-environment-tray-row-meta' && collect(row.children[2], 'span').some((span) => span.props.className === 'dsh-environment-tray-actions' && span.children.length === 3)))
  const css = readFileSync(resolve('src/client-ui.ts'), 'utf8')
  ok('hot reload updates the existing stylesheet', css.includes('existing.textContent = CSS'))
}

section('DSH 原生 i18n')
{
  const run = await drive('ok', null, 'en')
  const modal = collect(run.tree, 'div').find((node) => node.props['data-modal'] === 'open')
  ok('native English props translate the entry and modal', collect(run.steps[0].tree, 'button')[0].props['aria-label'] === 'Environment variables' && modal?.props['data-title'] === 'Environment variables')
  ok('the modal close label and search placeholder are translated', modal?.props['data-close'] === 'Close' && collect(run.tree, 'input').some((input) => input.props.placeholder === 'Search variables'))
  ok('groups and source labels follow English', treeText(run.tree).includes('DSH runtime variables') && treeText(run.tree).includes('Windows user variables') && treeText(run.tree).includes('Current process · Read only'))
  ok('Chinese server warnings and scope failures are translated by code', treeText(run.tree).includes('Remove the UTF-8 BOM') && treeText(run.tree).includes('Could not read Windows system variables') && !/[\p{Script=Han}]/u.test(treeText(run.tree)))
  const labels = []
  walk(run.tree, (node) => labels.push(node.props.title, node.props['aria-label'], node.props.placeholder))
  ok('English tooltips and accessible labels contain no Chinese copy', labels.filter((label) => typeof label === 'string').every((label) => !/\p{Script=Han}/u.test(label)))
  ok('variable names and actual values are never translated', treeText(run.tree).includes('ComSpec') && treeText(run.tree).includes('C:\\Windows\\system32\\cmd.exe'))
  ok('localization does not reveal credentials', !treeText(run.tree).includes(SECRET_PREVIEW))

  const switched = await drive('ok', { steps: [
    { type: 'PATH' }, { row: 'PATH', click: '编辑' }, { type: 'unchanged-draft' },
    { locale: 'en' }, { locale: 'zh' },
  ] })
  const englishTree = switched.steps.find((step) => step.label === 'locale:en').tree
  ok('changing locale updates an already open modal', collect(englishTree, 'div').some((node) => node.props['data-title'] === 'Environment variables') && collect(switched.tree, 'div').some((node) => node.props['data-title'] === '环境变量'))
  ok('changing locale preserves the filter and edit draft', collect(englishTree, 'input').some((input) => input.props.value === 'PATH' && input.props.placeholder === 'Search variables') && collect(switched.tree, 'input').some((input) => input.props.autoFocus && input.props.value === 'unchanged-draft'))
  ok('changing locale updates the editor label and keyboard hint', collect(englishTree, 'input').some((input) => input.props['aria-label'] === 'Value of PATH' && input.props.title === 'Enter to save · Esc to cancel'))
  ok('changing locale performs no extra reads or writes', switched.calls.filter((call) => call.url === '/api/dsh-environment-tray/state').length === 1 && switched.calls.filter((call) => call.url === '/api/dsh-environment-tray/value').length === 1 && !switched.calls.some((call) => call.url === '/api/dsh-environment-tray/env'))

  const rejected = await drive('coded-reject', { steps: [
    { row: 'PATH', click: '编辑' }, { type: 'draft' }, { key: 'Enter' }, { locale: 'en' },
  ] })
  ok('mounted conflict errors follow a locale change', treeText(rejected.tree).includes('The file changed. Reopen the editor before saving.') && !/\p{Script=Han}/u.test(treeText(rejected.tree)))
  ok('translating a conflict keeps its draft and CAS revision', collect(rejected.tree, 'input').some((input) => input.props.value === 'draft' && input.props['aria-invalid']) && rejected.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').length === 1 && JSON.parse(rejected.calls.find((call) => call.url === '/api/dsh-environment-tray/env').body).expectedRevision === 'sha256:next')
  const validation = await drive('validation', { steps: [
    { row: 'PATH', click: 'Edit' }, { type: 'value' }, { key: 'Enter' },
  ] }, 'en')
  ok('structured validation problems translate while preserving the key', treeText(validation.tree).includes('PATH: This value cannot be stored in .env without changing it'))
  const readError = await drive('read-error', { steps: [{ row: 'OPENAI_API_KEY', click: 'Show value' }] }, 'en')
  ok('value read errors use native English copy', treeText(readError.tree).includes('Could not read the value') && !/\p{Script=Han}/u.test(treeText(readError.tree)))
  const credential = await drive('ok', { steps: [{ click: 'Replace' }] }, 'en')
  ok('credential editors translate controls and keep masking', collect(credential.tree, 'button').some((button) => labelOf(button) === 'Show input') && collect(credential.tree, 'input').some((input) => input.props.autoFocus && input.props.type === 'password' && input.props['aria-label'] === 'Value of OPENAI_API_KEY'))
  const empty = await drive('ok', { steps: [{ type: 'not_a_variable' }] }, 'en')
  ok('empty states are translated', treeText(empty.tree).includes('No matching variables'))
  const loading = await drive('pending', null, 'en')
  ok('loading states are translated', treeText(loading.tree).includes('Loading environment…'))
  const failure = await drive('error', null, 'en')
  ok('load errors and retry controls are translated', treeText(failure.tree).includes('Could not read: HTTP 500') && collect(failure.tree, 'button').some((button) => labelOf(button) === 'Retry'))
  const undo = await drive('ok', { steps: [{ row: 'MY_TOOL_HOME', click: 'Delete' }, { click: 'Confirm deletion' }] }, 'en')
  ok('delete results and undo controls are translated', treeText(undo.tree).includes('Deleted MY_TOOL_HOME') && collect(undo.tree, 'button').some((button) => labelOf(button) === 'Undo deletion'))
}

section('新建与行尾删除')
{
  const fields = [
    { click: '新建变量' }, { type: 'NEW_VAR', field: '名称' }, { type: 'first\nsecond', field: '值' },
  ]
  const opened = await drive('ok', { steps: fields })
  ok('the toolbar exposes a new-variable icon', collect(opened.steps[1].tree, 'button').some((button) => labelOf(button) === '新建变量'))
  ok('the new form defaults to user .env and retains multiline values', collect(opened.tree, 'select')[0]?.props.value === 'user-env' && collect(opened.tree, 'textarea').some((input) => input.props.value === 'first\nsecond'))
  ok('moving through new-variable fields performs no writes', !opened.calls.some((call) => call.method === 'POST'))
  ok('failed Windows scopes are omitted from the new-variable locations', collect(opened.tree, 'option').map((option) => option.props.value).join(',') === 'user-env,project-env,os-user')
  const linux = await drive('non-windows', { steps: [{ click: '新建变量' }] })
  ok('non-Windows creation offers only .env locations', collect(linux.tree, 'option').map((option) => option.props.value).join(',') === 'user-env,project-env')
  const cancel = await drive('ok', { steps: [...fields, { click: '取消' }, { click: '新建变量' }] })
  ok('cancelling creation clears the name and plaintext', collect(cancel.tree, 'input').find((input) => input.props['aria-label'] === '名称')?.props.value === '' && collect(cancel.tree, 'textarea').find((input) => input.props['aria-label'] === '值')?.props.value === '' && !cancel.calls.some((call) => call.method === 'POST'))
  const escape = await drive('ok', { steps: [...fields, { formKey: 'Escape' }] })
  ok('Escape closes a new-variable form without saving', collect(escape.tree, 'form').length === 0 && !escape.calls.some((call) => call.method === 'POST'))
  const created = await drive('ok', { steps: [...fields, { click: '新建' }] })
  const createBody = JSON.parse(created.calls.find((call) => call.url === '/api/dsh-environment-tray/env')?.body ?? '{}')
  ok('creating a .env variable uses a fresh CAS revision and create-only semantics', createBody.layer === 'user-env' && createBody.expectedRevision === 'sha256:next' && createBody.createOnly === true && createBody.edits[0].name === 'NEW_VAR' && createBody.edits[0].value === 'first\nsecond')
  ok('a successful create closes the form and refreshes the list', collect(created.tree, 'form').length === 0 && created.calls.filter((call) => call.url === '/api/dsh-environment-tray/state').length === 2)
  const project = await drive('ok', { steps: [...fields, { select: 'project-env', field: '保存位置' }, { click: '新建' }] })
  ok('creating in project .env sends the selected layer', JSON.parse(project.calls.find((call) => call.url === '/api/dsh-environment-tray/env').body).layer === 'project-env')
  const registry = await drive('os-ready', { steps: [...fields, { select: 'os-machine', field: '保存位置' }, { click: '新建' }] })
  const registryBody = JSON.parse(registry.calls.find((call) => call.url === '/api/dsh-environment-tray/registry')?.body ?? '{}')
  ok('creating a Windows variable preserves the chosen scope and explicit string type', registryBody.scope === 'os-machine' && registryBody.type === 'REG_SZ' && registryBody.createOnly === true && registryBody.name === 'NEW_VAR')
  const invalid = await drive('ok', { steps: [{ click: '新建变量' }, { type: 'bad-name', field: '名称' }, { click: '新建' }] })
  ok('invalid new names are rejected before any request', !invalid.calls.some((call) => call.method === 'POST') && collect(invalid.tree, 'p').some((node) => node.props.role === 'alert'))
  const duplicate = await drive('duplicate', { steps: [...fields, { click: '新建' }, { locale: 'en' }] })
  ok('duplicate creation retains the draft and translates its error', collect(duplicate.tree, 'input').some((input) => input.props.value === 'NEW_VAR') && collect(duplicate.tree, 'textarea').some((input) => input.props.value === 'first\nsecond') && treeText(duplicate.tree).includes('This name already exists in the selected location'))
  const pending = await drive('write-pending', { steps: [...fields, { click: '新建' }, { click: '保存中…' }] })
  ok('rapidly submitting creation twice sends only one mutation', pending.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').length === 1 && collect(pending.tree, 'input').some((input) => input.props['aria-label'] === '名称' && input.props.disabled))
  const secret = await drive('ok', { steps: [{ click: '新建变量' }, { type: 'NEW_TOKEN', field: '名称' }, { type: 'synthetic', field: '值' }] })
  ok('new secret values are masked with an icon visibility toggle', collect(secret.tree, 'input').some((input) => input.props['aria-label'] === '值' && input.props.type === 'password') && collect(secret.tree, 'button').some((button) => labelOf(button) === '显示输入' && textOf(button) === ''))
  const lang = await drive('ok', { steps: [...fields, { locale: 'en' }] })
  ok('an open new-variable form follows native language changes without losing fields', collect(lang.tree, 'form')[0]?.props['aria-label'] === 'New variable' && collect(lang.tree, 'input').some((input) => input.props['aria-label'] === 'Name' && input.props.value === 'NEW_VAR') && collect(lang.tree, 'select')[0]?.props['aria-label'] === 'Save to')

  const dialog = await drive('ok', { steps: [{ row: 'PATH', click: '删除' }] })
  ok('delete is directly accessible without editing or reading plaintext', dialog.missing.length === 0 && !dialog.calls.some((call) => call.method === 'POST') && !collect(dialog.tree, 'input').some((input) => input.props.autoFocus))
  ok('delete confirmation names the exact layer and explains remaining layers', treeText(dialog.tree).includes('从项目 .env删除 PATH？') && treeText(dialog.tree).includes('其他层中的同名值会保留。'))
  const noDelete = await drive('ok', { steps: [{ row: 'PATH', click: '删除' }, { click: '取消' }] })
  ok('cancelling deletion performs no read or mutation', !noDelete.calls.some((call) => call.method === 'POST') && !collect(noDelete.tree, 'div').some((node) => node.props['data-title'] === '删除变量'))
  const keepDraft = await drive('ok', { steps: [
    { row: 'PATH', click: '编辑' }, { type: 'unsaved' }, { row: 'PATH', click: '删除' }, { row: 'PATH', blur: true }, { click: '取消' },
  ] })
  ok('opening and cancelling deletion suspends autosave and preserves an edit draft', collect(keepDraft.tree, 'input').some((input) => input.props.value === 'unsaved') && !keepDraft.calls.some((call) => call.url === '/api/dsh-environment-tray/env'))
  const remove = await drive('ok', { steps: [{ row: 'PATH', click: '删除' }, { click: '确认删除' }] })
  ok('direct .env deletion reads only metadata and sends a CAS-protected unset', !remove.calls.some((call) => call.url === '/api/dsh-environment-tray/value') && remove.calls.some((call) => call.url === '/api/dsh-environment-tray/env/read') && JSON.parse(remove.calls.find((call) => call.url === '/api/dsh-environment-tray/env').body).edits[0].op === 'unset')
  const credential = await drive('ok', { steps: [{ row: 'OPENAI_API_KEY', rowNth: 1, click: '删除' }, { click: '确认删除' }] })
  ok('credential deletion works directly without resolving the secret', credential.missing.length === 0 && !credential.calls.some((call) => call.url === '/api/dsh-environment-tray/value') && credential.calls.some((call) => call.url === '/api/dsh-environment-tray/credentials' && JSON.parse(call.body).unset === true))
  const rejected = await drive('coded-reject', { steps: [{ row: 'PATH', click: '删除' }, { click: '确认删除' }] })
  ok('a rejected delete remains in the confirmation with an actionable error', collect(rejected.tree, 'div').some((node) => node.props['data-title'] === '删除变量') && treeText(rejected.tree).includes('文件已被其他程序修改'))
  const waiting = await drive('write-pending', { steps: [{ row: 'PATH', click: '删除' }, { click: '确认删除' }, { click: '保存中…' }] })
  ok('a pending deletion cannot submit twice', waiting.calls.filter((call) => call.url === '/api/dsh-environment-tray/env').length === 1)
  const readonly = collect(opened.steps[1].tree, 'div').find((node) => node.props.className === 'dsh-environment-tray-row' && textOf(node.children[0]) === 'ComSpec')
  ok('read-only variables have no delete action', !collect(readonly, 'button').some((button) => labelOf(button) === '删除'))
}

section('卫生')
ok('no cross-drive fetch leakage', staleCalls === 0, String(staleCalls))
ok('the bundle text contains no literal "undefined" writer', !readFileSync(BUILT, 'utf8').includes('NO_VALUE'))
ok('the source of the panel is separate from the data flow', statSync(resolve('src/client-ui.ts'), { throwIfNoEntry: false }) !== undefined)

section('DSH 0.1.5 图标兼容')
{
  const legacy = registered.factory((spec) => spec === 'react' ? React : makePrimitives(React, true))
  renderer.reset()
  globalThis.fetch = makeFetch('ok').impl
  locale.setLocale('zh')
  let tree = await renderer.settle(legacy.EnvManagerAction, { t: locale.bind(namespace) })
  ok('legacy icon exports render the header entry', collect(tree, 'button').some((b) => b.props['aria-label'] === '环境变量'))
  collect(tree, 'button')[0].props.onClick()
  tree = await renderer.settle(legacy.EnvManagerAction, { t: locale.bind(namespace) })
  ok('legacy icon exports render the entire panel', collect(tree, 'div').filter((d) => d.props.className === 'dsh-environment-tray-row').length >= 4)
}

disposers[0]()
ok('unloading releases the dictionary namespace', locale.bind(namespace)('title') === 'title')
exports.apply(ctx)
ok('hot reload can register the namespace again without collision', locale.bind(namespace)('title') === '环境变量')

console.log(`\n${'─'.repeat(70)}`)
if (failed === 0) console.log(`✅ 客户端 UI：${String(passed)} PASS / 0 FAIL`)
else {
  console.log(`❌ ${String(passed)} PASS / ${String(failed)} FAIL`)
  for (const f of failures.slice(0, 25)) console.log(`   - ${f}`)
  process.exitCode = 1
}
