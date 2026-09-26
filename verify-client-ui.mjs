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
      pending.push(fn)
    }
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
      rendered = tree(createElement(component, props), 'root')
      const effects = pending.splice(0)
      for (const fn of effects) fn()
      await flush()
      if (effects.length === 0 && !dirty) return rendered
    }
    throw new Error('component did not settle')
  }

  return { createElement, useState, useEffect, useCallback, settle, reset: () => { hookStore.clear(); pending.length = 0 } }
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
function makePrimitives(React) {
  const h = React.createElement
  const passthrough = (tag) => (props) => {
    const { icon, children, ...rest } = props
    return h(tag, rest, icon ?? null, children ?? null)
  }
  return {
    Button: passthrough('button'),
    Input: passthrough('input'),
    Modal: ({ open, title, description, closeLabel, children }) =>
      open === true
        ? h('div', { 'data-modal': 'open', 'data-title': title, 'data-close': closeLabel }, h('p', null, description), children)
        : null,
    DisclosureRow: ({ title, open, onToggle, children }) =>
      h('div', null, h('button', { type: 'button', onClick: onToggle }, title), open === true ? children : null),
    IconChevronDownOutline14: () => null,
    IconContextInjectionOutline16: () => null,
    IconEditOutline16: () => null,
    IconRefreshOutline16: () => null,
    IconSearchOutline16: () => null,
    IconTrashOutline16: () => null,
  }
}

const HOME = 'C:\\Users\\probe\\.dsh'
const CWD = 'E:\\probe\\project'
const SECRET_PREVIEW = 'sk-live-MUST-NOT-LEAK-0123456789'

const STATE = {
  cwd: CWD,
  home: HOME,
  counts: { total: 4, shadowed: 1 },
  files: { project: CWD + '\\.env', user: HOME + '\\.env' },
  os: { supported: true, skipped: false, scopes: { 'os-user': { count: 2, error: null }, 'os-machine': { count: 1, error: '拒绝访问' } } },
  warnings: [{ code: 'bom', path: CWD + '\\.env', message: '文件带 UTF-8 BOM' }],
  variables: [
    { name: 'DSH_ENV_MANAGER_LIVE', effective: 'process', runtimeManaged: true, shadowed: false, sensitive: false, forbidden: true, layerCount: 1, layers: [{ layer: 'process', writable: false, blockedCode: 'process-layer', valueLength: 1 }] },
    { name: 'PATH', effective: 'process', runtimeManaged: false, shadowed: true, sensitive: false, forbidden: true, layerCount: 3, layers: [
      { layer: 'process', writable: false, valueSummary: { preview: 'C:\\Windows;C:\\bin', length: 4096, truncated: true } },
      { layer: 'project-env', writable: true, path: CWD + '\\.env', valueSummary: { preview: '/x', length: 2 } },
      { layer: 'os-user', writable: true, registryType: 'REG_EXPAND_SZ', path: 'HKCU\\Environment' },
    ] },
    { name: 'OPENAI_API_KEY', effective: 'user-env', runtimeManaged: false, shadowed: false, sensitive: true, forbidden: false, layerCount: 1, layers: [{ layer: 'user-env', writable: true, redacted: true, valueLength: 51, path: HOME + '\\.env' }] },
    { name: 'MY_TOOL_HOME', effective: 'os-machine', runtimeManaged: false, shadowed: false, sensitive: false, forbidden: false, layerCount: 1, layers: [{ layer: 'os-machine', writable: true, registryType: 'REG_SZ', requiresElevation: true, blockedCode: 'needs-elevation' }] },
  ],
  blockedReasonText: { 'process-layer': '启动环境不可写', 'needs-elevation': '需要管理员权限' },
}

const CRED_REFS = {
  OPENAI_API_KEY: { configured: true, editable: true, sourceLabel: '$DSH_HOME/.env' },
  GITHUB_TOKEN: { configured: false, editable: true },
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
    if (url === '/api/env-manager/state') return mode === 'error' ? json(500, { message: '内部错误' }) : json(200, STATE)
    if (url.startsWith('/api/env-manager/credential-state')) return json(200, { available: true, refs: CRED_REFS })
    if (mode === 'reject') return json(409, { ok: false, problems: [{ name: 'PATH', message: '文件已被其他程序改动（revision 过期）' }] })
    if (url === '/api/env-manager/registry') return json(200, { ok: true, removed: true, undo: { name: 'MY_TOOL_HOME', value: 'C:\\old-tools', type: 'REG_EXPAND_SZ' } })
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
ok('bundle id is the package name', registered?.id === 'dsh-env-manager', String(registered?.id))
ok('factory is lazy (body not run at registration)', factoryRanAtRegistration === false)

const renderer = createRenderer()
const React = {
  createElement: renderer.createElement,
  Fragment: Symbol('Fragment'),
  useState: renderer.useState,
  useEffect: renderer.useEffect,
  useCallback: renderer.useCallback,
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
ok('exports inject = ["slots"]', JSON.stringify(exports.inject) === '["slots"]', JSON.stringify(exports.inject))
ok('exports EnvManagerAction (the header entry)', typeof exports.EnvManagerAction === 'function')

section('入口位置')
const ctx = {
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
ok('entry id is env-manager', registrations[0]?.options?.id === 'env-manager', JSON.stringify(registrations[0]?.options ?? {}))
ok('entry carries an order', typeof registrations[0]?.options?.order === 'number', String(registrations[0]?.options?.order))
delete globalThis.window

/* ────────────────────────────── 驱动 ────────────────────────────── */

const ACTIONS = [
  { id: 'filter', steps: [{ type: 'path' }] },
  { id: 'env-write', steps: [{ click: '编辑' }, { type: 'typed-value' }, { click: '保存' }] },
  { id: 'env-remove', steps: [{ click: '编辑' }, { click: '删除' }] },
  { id: 'registry-remove-undo', steps: [{ click: '编辑', nth: 2 }, { click: '删除' }, { click: '撤销删除' }] },
  { id: 'credential-write', steps: [{ click: '替换' }, { type: 'sk-typed' }, { click: '保存' }] },
  { id: 'notes', steps: [{ click: '说明与生效时机' }] },
]

/**
 * 打开入口 → 可选地走一段脚本，每一步产出一份渲染快照。
 *
 * 每一步都记下"当时的树"，断言用的是树本身而不是文本 diff —— 排版是可度量的
 * 属性（字号、opacity、DOM 顺序），不是"看起来对"。
 */
async function drive(mode, action) {
  const { impl, calls } = makeFetch(mode)
  globalThis.fetch = impl
  renderer.reset()

  const component = registrations[0]?.component
  const steps = []
  const missing = []

  const record = async (label) => {
    const rendered = await renderer.settle(component)
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
  for (const step of action?.steps ?? []) {
    if (step.click !== undefined) {
      const candidates = collect(tree, 'button').filter((b) => labelOf(b) === step.click)
      const target = candidates[step.nth ?? 0]
      if (target === undefined) {
        missing.push(`click:${step.click}（只有 ${collect(tree, 'button').map(labelOf).join('/')}）`)
        continue
      }
      target.props.onClick()
      tree = await record(`click:${step.click}`)
      continue
    }
    if (step.type !== undefined) {
      // 优先往"刚打开的行内编辑框"输入（它有 autoFocus），否则用过滤框
      const inputs = collect(tree, 'input')
      const target = inputs.find((i) => i.props.autoFocus === true) ?? inputs[0]
      if (target?.props?.onChange === undefined) {
        missing.push(`type:${step.type}（没有可输入的框）`)
        continue
      }
      target.props.onChange({ target: { value: step.type } })
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
  const rows = collect(tree, 'div').filter((d) => typeof d.props.style?.gridTemplateColumns === 'string')
  ok('every variable row uses the 3-column key/value grid', rows.length >= 4, String(rows.length))
  const pathRow = rows.find((r) => textOf(r.children[0]) === 'PATH')
  ok('PATH has a row with KEY first', pathRow !== undefined)
  const cells = pathRow?.children ?? []
  ok('the row has exactly 3 cells', cells.length === 3, String(cells.length))
  ok('cell 2 is the VALUE (its text is the value preview)', textOf(cells[1]) === 'C:\\Windows;C:\\bin', JSON.stringify(textOf(cells[1])))
  ok('cell 3 is the annotations', textOf(cells[2]).includes('遮蔽 3 层'), JSON.stringify(textOf(cells[2])))

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
  ok('VALUE uses a monospace stack', String(cells[1]?.props.style?.fontFamily ?? '').includes('monospace'))

  // 注解里带上次要事实，且**不是**彩色胶囊（没有 border/背景色）
  ok('the annotations carry the effective layer', textOf(cells[2]).includes('启动环境'), JSON.stringify(textOf(cells[2])))
  ok('the annotations are not boxed chips', cells[2]?.children?.every((c) => c === null || c.props?.style?.border === undefined) === true)

  // 敏感值绝不外泄，且用点阵表达"有值但看不到"
  const all = treeText(tree)
  ok('the secret preview never reaches the tree', !all.includes(SECRET_PREVIEW))
  const apiRow = rows.find((r) => textOf(r.children[0]) === 'OPENAI_API_KEY')
  ok('a redacted value renders as a mask', textOf(apiRow?.children?.[1]) === '••••••••••', JSON.stringify(textOf(apiRow?.children?.[1])))
  ok('a redacted value still reports its length as an annotation', textOf(apiRow?.children?.[2]).includes('51 字符'), JSON.stringify(textOf(apiRow?.children?.[2])))

  // 说明默认收起：长文案不占首屏
  ok('the long notes are collapsed by default', !all.includes('写入 .env 使用'), '')
  ok('the notes are reachable through one disclosure row', all.includes('说明与生效时机'))
}

/* ────────────────────────────── 交互与请求体 ────────────────────────────── */

section('交互与写请求')
const EXPECTED = {
  'filter': [],
  'env-write': [
    ['POST', '/api/env-manager/env/read', '{"layer":"project-env"}'],
    ['POST', '/api/env-manager/env', '{"layer":"project-env","expectedRevision":"sha256:next","edits":[{"op":"set","name":"PATH","value":"typed-value"}]}'],
  ],
  'env-remove': [
    ['POST', '/api/env-manager/env/read', '{"layer":"project-env"}'],
    ['POST', '/api/env-manager/env', '{"layer":"project-env","expectedRevision":"sha256:next","edits":[{"op":"unset","name":"PATH"}]}'],
  ],
  'registry-remove-undo': [
    ['POST', '/api/env-manager/registry', '{"scope":"os-machine","name":"MY_TOOL_HOME","unset":true}'],
    ['POST', '/api/env-manager/registry', '{"scope":"os-machine","name":"MY_TOOL_HOME","value":"C:\\\\old-tools","type":"REG_EXPAND_SZ"}'],
  ],
  'credential-write': [['POST', '/api/env-manager/credentials', '{"ref":"OPENAI_API_KEY","value":"sk-typed"}']],
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
  const rows = collect(run.tree, 'div').filter((d) => typeof d.props.style?.gridTemplateColumns === 'string')
  const keys = rows.map((r) => textOf(r.children?.[0]))
  ok('filtering by name keeps exactly the matching variable', keys.filter((k) => k === 'PATH').length === 1, JSON.stringify(keys))
  ok('filtering by name drops the non-matching variables', !keys.includes('MY_TOOL_HOME') && !keys.includes('DSH_ENV_MANAGER_LIVE'), JSON.stringify(keys))
}

{
  // 被拒：问题文案逐条落到界面上
  const run = await drive('reject', { steps: [{ click: '编辑' }, { type: 'x' }, { click: '保存' }] })
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

section('卫生')
ok('no cross-drive fetch leakage', staleCalls === 0, String(staleCalls))
ok('the bundle text contains no literal "undefined" writer', !readFileSync(BUILT, 'utf8').includes('NO_VALUE'))
ok('the source of the panel is separate from the data flow', statSync(resolve('src/client-ui.ts'), { throwIfNoEntry: false }) !== undefined)

console.log(`\n${'─'.repeat(70)}`)
if (failed === 0) console.log(`✅ 客户端 UI：${String(passed)} PASS / 0 FAIL`)
else {
  console.log(`❌ ${String(passed)} PASS / ${String(failed)} FAIL`)
  for (const f of failures.slice(0, 25)) console.log(`   - ${f}`)
  process.exitCode = 1
}
