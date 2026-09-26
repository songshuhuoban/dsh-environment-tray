/**
 * 客户端半边的**运行时等价门禁**：旧的手写 bundle（`src/client.legacy.js`）
 * 与从 `src/client.ts` 构建出的 `lib/client.js` 必须表现完全一致。
 *
 * ── 为什么不是文本 diff ─────────────────────────────────────────────────────
 *
 * 迁移要加类型标注，正文必然逐行变化，文本对比没有意义。而"看着一样"也不是
 * 证据。所以这里把两个 bundle 都**真的跑起来**，在同一个迷你渲染器里走同一串
 * 交互，逐步比对渲染结果。
 *
 * 覆盖面（每一步 legacy 与 new 都必须给出同一个快照）：
 *
 *   1. 注册形态：惰性（注册时不执行工厂体）、id、只 require `react`
 *   2. 导出面：`apply` / `inject` / `EnvManagerTab` 的名字与类型
 *   3. `apply()`：注入的槽位名、register 的 options、组件
 *   4. 初始渲染（加载中）→ 数据到达后的渲染 → 过滤 → 刷新
 *   5. 逐个点击树里的**每一个按钮**（编辑 / 展开各层 / 保存 / 取消 / 删除 /
 *      撤销删除 / 刷新 / 替换 / 设置），写请求分别按「成功」与「被拒绝」两种
 *      响应各跑一遍 —— 这样 try/catch 两侧的分支都会走到
 *   6. 逐个触发树里的每一个 `input` 的 onChange（过滤框、草稿框）
 *
 * 迷你渲染器只实现这个文件用到的 React 子集：`createElement`、`useState`、
 * `useEffect`、`useCallback`（含依赖比较 —— 不做记忆化的话
 * `useEffect(…, [load])` 会每轮重跑，直接把测试跑成死循环）。
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LEGACY = resolve('src/client.legacy.js')
const BUILT = resolve('lib/client.js')
const SOURCE = resolve('src/client.ts')

let passed = 0
let failed = 0
const failures = []

/**
 * 断言。
 *
 * **逐条打印 `PASS` / `FAIL` 行**是仓库里其他套件的约定，不是装饰：
 * `audit-readme.mjs` 就是靠数 `^(PASS|FAIL)` 行来核对 README 声明的断言数的。
 * 只打一行"169 PASS"的汇总，README 里的数字就没人能核对了。
 */
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

function section(title) {
  console.log(`\n--- ${title} ---`)
}

/** 深比较两个 JSON 化的值，返回 null 或差异描述。 */
function diff(a, b, path = '$') {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b) return `${path}: ${typeof a} vs ${typeof b}`
  if (a === null || b === null) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
  if (typeof a !== 'object') return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.join(',') !== kb.join(',')) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`
  for (const key of ka) {
    const inner = diff(a[key], b[key], `${path}.${key}`)
    if (inner !== null) return inner
  }
  return null
}

/* ────────────────────────────── 迷你渲染器 ────────────────────────────── */

const SAME = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

/**
 * 每轮渲染的 hook 轨迹。
 *
 * 不直接打到控制台 —— 一次驱动有几十轮、每轮几十个 hook，会把输出淹掉。
 * 每个渲染器自己留一份，**只在快照不一致时**附在失败详情里。
 */
function createRenderer() {
  const hookStore = new Map()
  const pending = []
  let current = null
  let dirty = false
  let trace = []
  const debug = []

  const note = (text) => {
    if (debug.length < 400) debug.push(text)
  }

  function slot(kind) {
    const list = hookStore.get(current.path) ?? []
    const index = current.cursor
    current.cursor += 1
    while (list.length <= index) list.push({})
    const entry = list[index]
    if (entry.kind === undefined) entry.kind = kind
    else if (entry.kind !== kind) {
      throw new Error(`hook order changed at ${current.path}#${index}: ${entry.kind} → ${kind}`)
    }
    hookStore.set(current.path, list)
    trace.push(`${current.path}#${String(index)}:${kind}`)
    return { entry, index }
  }

  function useState(initial) {
    const { entry } = slot('state')
    if (!('value' in entry)) entry.value = typeof initial === 'function' ? initial() : initial
    const setState = (update) => {
      entry.value = typeof update === 'function' ? update(entry.value) : update
      dirty = true
    }
    return [entry.value, setState]
  }

  function useEffect(fn, deps) {
    const { entry, index } = slot('effect')
    const shouldRun = entry.first !== true || deps === undefined || !SAME(entry.deps, deps)
    if (shouldRun) {
      entry.first = true
      entry.deps = deps === undefined ? undefined : [...deps]
      pending.push([`${current.path}#${index}`, fn])
    }
  }

  function useCallback(fn, deps) {
    const { entry } = slot('callback')
    if (entry.first !== true || deps === undefined || !SAME(entry.deps, deps)) {
      entry.first = true
      entry.deps = deps === undefined ? undefined : [...deps]
      entry.fn = fn
    }
    return entry.fn
  }

  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })

  const keyOf = (node) =>
    node !== null && typeof node === 'object' && !Array.isArray(node) && node.props?.key != null
      ? String(node.props.key)
      : null

  function tree(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)

    if (Array.isArray(node)) {
      const out = []
      node.forEach((child, i) => {
        const key = keyOf(child)
        const rendered = tree(child, `${path}#${key ?? String(i)}`)
        if (rendered === null) return
        if (Array.isArray(rendered)) out.push(...rendered)
        else out.push(rendered)
      })
      return out
    }

    if (typeof node.type === 'function') {
      const key = keyOf(node)
      const name = node.type.name || 'Anonymous'
      const childPath = `${path}/${name}${key === null ? '' : `#${key}`}`
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

  /**
   * 放行一轮异步工作。
   *
   * 用 `setImmediate` 而不是若干个 `await Promise.resolve()`：Node 在两个宏任务
   * 之间会把**微任务队列彻底清空**，所以一条纯 promise 的链（本文件 mock 出来的
   * `fetch` 就是）一轮就能跑完。之前用固定次数的微任务让"保存中…"这类中间态
   * 被当成终态快照，也让未跑完的链泄漏到了下一轮驱动里。
   */
  const flush = async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r))
  }

  /**
   * 渲染到静止。
   *
   * 关键点：**只有在"渲染后无事可做、且放行一轮异步后仍无状态变化"时才返回**。
   * 否则点到「保存」这类异步处理器时，会在 `busy=true` 的中间态就收工 ——
   * 快照对比于是变成比较"处理到一半"的树。
   */
  async function settle(component, props = {}) {
    let rendered = null
    for (let round = 0; round < 60; round += 1) {
      dirty = false
      pending.length = 0
      trace = []
      rendered = tree(createElement(component, props), 'root')
      note(`round ${String(round)}: pending=${String(pending.length)} dirty=${String(dirty)} hooks=${trace.join(' ')}`)

      const effects = pending.splice(0)
      for (const [key, fn] of effects) {
        note(`  run effect ${key}`)
        fn()
      }

      await flush()
      if (effects.length === 0 && !dirty) return rendered
    }
    throw new Error('component did not settle after 60 rounds')
  }

  /** 丢掉所有实例状态，让下一次 `settle` 等价于"重新挂载这个页签"。 */
  function reset() {
    hookStore.clear()
    pending.length = 0
    current = null
    dirty = false
    trace = []
    debug.length = 0
  }

  /** 取出（并清空）这一轮的 hook 轨迹。 */
  function takeDebug() {
    const out = debug.slice()
    debug.length = 0
    return out
  }

  return { createElement, useState, useEffect, useCallback, settle, flush, reset, takeDebug }
}

/* ────────────────────────────── 树上的查询工具 ────────────────────────────── */

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
  if (node === null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return node.children.map(textOf).join('')
}

function buttons(node) {
  const found = []
  walk(node, (n) => {
    if (n.tag === 'button') found.push({ label: textOf(n).trim(), handler: n.props.onClick, disabled: n.props.disabled })
  })
  return found
}

function inputs(node) {
  const found = []
  walk(node, (n) => {
    if (n.tag === 'input') found.push({ props: n.props })
  })
  return found
}

/** 可比较的快照：函数位替换成占位符，其余原样。 */
function snapshot(node) {
  if (node === null) return null
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(snapshot)
  const props = {}
  for (const key of Object.keys(node.props).sort()) {
    const value = node.props[key]
    if (typeof value === 'function') props[key] = '[fn]'
    else if (value === undefined) props[key] = '[undefined]'
    else props[key] = value
  }
  return { tag: node.tag, props, children: node.children.map(snapshot) }
}

const snap = (node) => JSON.stringify(snapshot(node))

/* ────────────────────────────── 假数据 ────────────────────────────── */

const HOME = 'C:\\Users\\probe\\.dsh'
const CWD = 'E:\\probe\\project'

/** 覆盖所有渲染分支的合成数据（形状对齐 src/host-api.ts 的投影）。 */
const STATE = {
  cwd: CWD,
  home: HOME,
  counts: { total: 4, shadowed: 1 },
  files: { project: CWD + '\\.env', user: HOME + '\\.env' },
  os: {
    supported: true,
    skipped: false,
    scopes: {
      'os-user': { count: 2, error: null },
      'os-machine': { count: 1, error: '拒绝访问' },
    },
  },
  warnings: [
    { code: 'bom', path: CWD + '\\.env', message: '文件带 UTF-8 BOM' },
    { code: 'colon-line' },
  ],
  variables: [
    {
      name: 'DSH_ENV_MANAGER_LIVE',
      effective: 'process',
      runtimeManaged: true,
      shadowed: false,
      sensitive: false,
      forbidden: true,
      layerCount: 1,
      layers: [{ layer: 'process', writable: false, blockedCode: 'process-layer', valueLength: 1 }],
    },
    {
      name: 'PATH',
      effective: 'process',
      runtimeManaged: false,
      shadowed: true,
      sensitive: false,
      forbidden: true,
      layerCount: 3,
      layers: [
        {
          layer: 'process',
          writable: false,
          valueSummary: { preview: 'C:\\Windows;C:\\bin', length: 4096, truncated: true },
        },
        { layer: 'project-env', writable: true, path: CWD + '\\.env', valueSummary: { preview: '/x', length: 2 } },
        {
          layer: 'os-user',
          writable: true,
          registryType: 'REG_EXPAND_SZ',
          requiresElevation: false,
          path: 'HKCU\\Environment',
        },
      ],
    },
    {
      name: 'OPENAI_API_KEY',
      effective: 'user-env',
      runtimeManaged: false,
      shadowed: false,
      sensitive: true,
      forbidden: false,
      layerCount: 1,
      layers: [{ layer: 'user-env', writable: true, redacted: true, valueLength: 51, path: HOME + '\\.env' }],
    },
    {
      name: 'MY_TOOL_HOME',
      effective: 'os-machine',
      runtimeManaged: false,
      shadowed: false,
      sensitive: false,
      forbidden: false,
      layerCount: 1,
      layers: [
        {
          layer: 'os-machine',
          writable: true,
          registryType: 'REG_SZ',
          requiresElevation: true,
          blockedCode: 'needs-elevation',
        },
      ],
    },
  ],
  blockedReasonText: { 'process-layer': '启动环境不可写', 'needs-elevation': '需要管理员权限' },
}

const CRED_REFS = {
  OPENAI_API_KEY: { configured: true, editable: true, sourceLabel: '$DSH_HOME/.env', source: 'env' },
  AWS_SECRET_ACCESS_KEY: { configured: true, editable: false, sourceLabel: '系统环境', blockedReason: '被只读来源遮蔽' },
  GITHUB_TOKEN: { configured: false, editable: true },
}

/**
 * 取出调用栈里属于被测 bundle 的那一帧。
 *
 * 比整个 hook 轨迹有用得多：fetch 序列不一致时，要回答的是"**谁**多发了一次"，
 * 而不是"渲染了多少轮"。
 */
function callerFrame() {
  const stack = new Error().stack ?? ''
  const frame = stack
    .split('\n')
    .slice(2)
    .find((line) => line.includes('client.js') || line.includes('client.legacy.js'))
  if (frame === undefined) return '?'
  const m = /\(?(.+?):(\d+):(\d+)\)?\s*$/.exec(frame.trim())
  return m === null ? frame.trim() : `${m[1].split(/[\\/]/).slice(-2).join('/')}:${m[2]}`
}

/**
 * 当前"活跃"的驱动令牌。
 *
 * 一轮驱动结束后，上一轮还挂在 promise 链上的代码仍可能调到 `fetch`（它读的是
 * `globalThis.fetch`，此时已经换成下一轮的 mock）。这类调用如果被记进下一轮的
 * 请求列表，就会伪装成"新 bundle 多发了一次请求" —— 这正是本门禁第一版踩的坑：
 * legacy 的一次迟到 `GET /state` 记到了新 bundle 头上，看起来像真实差异。
 *
 * 所以每轮驱动有自己的令牌，非本轮的调用一律**不记录**、并返回一个永不 resolve
 * 的 promise（让迟到的代码安静地停在那里）。同时计数，作为诊断信息打出来。
 */
let activeToken = null
let staleCalls = 0

/**
 * 造一个可记录、可切换响应模式的 fetch。
 *
 * 五种模式各自点亮客户端的不同分支：
 *   - `ok`       —— 正常成功路径
 *   - `nobackup` —— 同 `ok`，但注册表删除回 `backupUnavailable`（"无法撤销"那条分支）
 *   - `reject`   —— 写请求被拒（`problems` 要逐条翻译成文案）
 *   - `error`    —— `GET /state` 回 500（错误分支 + 「重试」按钮）
 *   - `pending`  —— 永不 resolve（**只有这档能观察到「正在读取环境…」**，
 *                   因为其他档里 fetch 都在 settle 期间就完成了）
 *
 * 注册表删除的响应键是 `{ removed: true, undo: { name, value, type } }` ——
 * 与 `src/write-routes.ts` 的 registry 处理器一致（客户端读的是 `res.undo`）。
 */
function makeFetch(mode) {
  const calls = []
  const token = Symbol(mode)
  activeToken = token
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  const impl = async (url, init) => {
    if (token !== activeToken) {
      staleCalls += 1
      return new Promise(() => {})
    }
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null, at: callerFrame() })
    if (mode === 'pending') return new Promise(() => {})
    if (url === '/api/env-manager/state') {
      if (mode === 'error') return json(500, { message: '内部错误' })
      return json(200, STATE)
    }
    if (url.startsWith('/api/env-manager/credential-state')) return json(200, { available: true, refs: CRED_REFS })
    if (mode === 'reject') {
      return json(409, { ok: false, problems: [{ name: 'PATH', message: '文件已被其他程序改动（revision 过期）' }] })
    }
    if (url === '/api/env-manager/registry') {
      if (mode === 'nobackup') return json(200, { ok: true, removed: true, backupUnavailable: true })
      return json(200, {
        ok: true,
        removed: true,
        undo: { name: 'MY_TOOL_HOME', value: 'C:\\old-tools', type: 'REG_EXPAND_SZ' },
      })
    }
    return json(200, { ok: true, path: CWD + '\\.env', revision: 'sha256:next', keys: ['PATH'] })
  }
  return { impl, calls }
}

/* ────────────────────────────── 装载一个 bundle ────────────────────────────── */

let loadCounter = 0

/**
 * 把一个 bundle 文件在受控环境里装载并物化。
 *
 * 每个 bundle 都拿到**独立**的 React 假实现（hooks 绑定到自己的渲染器上），
 * 因为工厂体在 materialize 时会 `const { useState, … } = React` 把 hooks 捕获掉。
 */
async function loadBundle(file) {
  const requireCalls = []
  const registrations = []
  const injections = []
  let registered = null

  globalThis.window = {
    __ModuleLoader__: {
      load(record) {
        if (registered !== null) throw new Error('bundle called __ModuleLoader__.load twice')
        registered = record
      },
    },
  }

  loadCounter += 1
  await import(`${pathToFileURL(file).href}?probe=${String(loadCounter)}`)

  const lazy = registered !== null && requireCalls.length === 0
  if (registered === null) throw new Error(`${file}: bundle did not register a factory`)

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
    throw new Error(`unknown module: ${spec}`)
  }

  const exports = registered.factory(factoryRequire)

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

  // 真实 runner 在启动时就 `ctx.plugin()`（即调用 `apply`），远早于任何渲染。
  // 这里照做，于是"注册了什么"可以在渲染之前就被单独断言。
  exports.apply(ctx)

  return { file, registered, lazy, requireCalls, exports, ctx, renderer, registrations, injections }
}

/* ────────────────────────────── 驱动一串交互 ────────────────────────────── */

/**
 * 一个交互脚本：按**标签**找按钮，而不是按位置。
 *
 * 位置会随渲染变化，标签不会；而且按标签写出来的脚本能自我说明它想覆盖哪条分支。
 * 每一步：
 *   - `{ click: '保存' }`  —— 点第一个文本为「保存」的按钮
 *   - `{ click: '编辑', nth: 1 }` —— 点第 2 个（0 基）「编辑」
 *   - `{ type: 'typed-value' }` —— 往带 `autoFocus` 的输入框里输入
 *
 * `modes` 限定这个脚本在哪几种响应下有意义：`error` 档只有「重试」，`pending`
 * 档永远停在「正在读取环境…」，它们撑不起整套脚本。
 */
const ACTIONS = [
  { id: 'refresh', steps: [{ click: '刷新' }] },
  { id: 'expand-layers', steps: [{ click: '展开各层' }] },
  { id: 'collapse-layers', steps: [{ click: '展开各层' }, { click: '收起' }] },
  // 项目 .env 那一行（PATH 的生效层是 process，但可写层是 project-env）
  { id: 'env-edit-cancel', steps: [{ click: '编辑' }, { click: '取消' }] },
  { id: 'env-write', steps: [{ click: '编辑' }, { type: 'typed-value' }, { click: '保存' }] },
  { id: 'env-remove', steps: [{ click: '编辑' }, { click: '删除' }] },
  // 注册表层（MY_TOOL_HOME 的生效层是 os-machine）
  { id: 'registry-write', steps: [{ click: '编辑', nth: 2 }, { type: 'C:\\tools' }, { click: '保存' }] },
  // 删除注册表值拿得到原值 → 出现「撤销删除」；拿不到 → 只能如实说无法撤销
  { id: 'registry-remove-undo', modes: ['ok'], steps: [{ click: '编辑', nth: 2 }, { click: '删除' }, { click: '撤销删除' }] },
  { id: 'registry-remove-nobackup', modes: ['nobackup'], steps: [{ click: '编辑', nth: 2 }, { click: '删除' }] },
  // 被拒时停在编辑态并显示问题文案
  { id: 'registry-remove-rejected', modes: ['reject'], steps: [{ click: '编辑', nth: 2 }, { click: '删除' }] },
  // 凭据域（宿主永不回传值，所以草稿必须重输）
  { id: 'credential-write', steps: [{ click: '替换' }, { type: 'sk-typed' }, { click: '保存' }] },
  { id: 'credential-remove', steps: [{ click: '替换' }, { click: '删除' }] },
  // 只有错误档才有的分支
  { id: 'retry', modes: ['error'], steps: [{ click: '重试' }] },
]

const modesFor = (action) => action.modes ?? ['ok', 'reject']

/**
 * 在一个 bundle 上跑一段交互脚本，每一步产出一个快照。
 *
 * @param bundle - `loadBundle()` 的返回值。
 * @param postMode - fetch 的响应模式（`ok` / `reject` / `error` / `pending`）。
 * @param action - `ACTIONS` 里的一项，或 `null`（只做初始渲染 + 过滤）。
 */
async function drive(bundle, postMode, action) {
  const steps = []
  const missing = []

  const record = async (label, component) => {
    const rendered = await bundle.renderer.settle(component)
    steps.push([label, snap(rendered)])
    return rendered
  }

  const { impl, calls } = makeFetch(postMode)
  globalThis.fetch = impl

  // 每轮驱动都从"刚挂载"开始：否则上一轮留下的 hook 状态会让 effect 不再重跑，
  // 于是同一段脚本在不同轮次里的 fetch 序列不同 —— 那是探针噪音，不是被测代码的差异。
  bundle.renderer.reset()

  const component = bundle.registrations[0]?.component
  if (component === undefined) throw new Error(`${bundle.file}: apply() registered no component`)

  let tree = await record('initial', component)

  // 过滤框：输入一个只匹配 PATH 的串，再清空 —— 覆盖过滤与恢复两条路径
  const filterInput = inputs(tree)[0]
  if (filterInput?.props?.onChange) {
    filterInput.props.onChange({ target: { value: 'path' } })
    tree = await record('filtered', component)
  }
  const cleared = inputs(tree)[0]
  if (cleared?.props?.onChange) {
    cleared.props.onChange({ target: { value: '' } })
    tree = await record('cleared', component)
  }

  for (const step of action?.steps ?? []) {
    if (step.click !== undefined) {
      const candidates = buttons(tree).filter((b) => b.label === step.click)
      const target = candidates[step.nth ?? 0]
      if (target === undefined) {
        missing.push(`click:${step.click}${step.nth === undefined ? '' : `#${String(step.nth)}`}（树里只有 ${buttons(tree).map((b) => b.label).join('/')}）`)
        continue
      }
      target.handler()
      tree = await record(`click:${step.click}${step.nth === undefined ? '' : `#${String(step.nth)}`}`, component)
      continue
    }
    if (step.type !== undefined) {
      const input = inputs(tree).find((i) => i.props.autoFocus === true)
      if (input?.props?.onChange === undefined) {
        missing.push(`type:${step.type}（没有 autoFocus 输入框）`)
        continue
      }
      input.props.onChange({ target: { value: step.type } })
      tree = await record(`type:${step.type}`, component)
    }
  }

  return { steps, calls, missing, buttonCount: buttons(tree).length }
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

console.log('client-half runtime parity: src/client.legacy.js  vs  lib/client.js')

for (const file of [LEGACY, BUILT]) {
  if (!statSync(file, { throwIfNoEntry: false })) {
    console.error(`missing artifact: ${file}`)
    process.exit(1)
  }
}

// 产物比源码旧就没有比较价值 —— 先报错，避免拿旧 bundle 得出"等价"的假结论。
const builtAt = statSync(BUILT).mtimeMs
const sourceAt = statSync(SOURCE).mtimeMs
ok('lib/client.js is not older than src/client.ts', builtAt >= sourceAt, `built=${new Date(builtAt).toISOString()} source=${new Date(sourceAt).toISOString()}`)

const legacy = await loadBundle(LEGACY)
const built = await loadBundle(BUILT)
delete globalThis.window

section('注册形态')
ok('legacy: factory is lazy (factory body not run at registration)', legacy.lazy)
ok('new: factory is lazy (factory body not run at registration)', built.lazy)
ok('same bundle id', legacy.registered.id === built.registered.id, `${String(legacy.registered.id)} vs ${String(built.registered.id)}`)
ok('bundle id is the package name', built.registered.id === 'dsh-env-manager', String(built.registered.id))

section('导出面')
const legacyKeys = Object.keys(legacy.exports).sort()
const builtKeys = Object.keys(built.exports).sort()
ok('same export names', legacyKeys.join(',') === builtKeys.join(','), `${legacyKeys.join(',')} vs ${builtKeys.join(',')}`)
for (const key of legacyKeys) {
  ok(`export ${key} has the same typeof`, typeof legacy.exports[key] === typeof built.exports[key], `${typeof legacy.exports[key]} vs ${typeof built.exports[key]}`)
}
ok('inject is exactly ["slots"]', JSON.stringify(built.exports.inject) === '["slots"]', JSON.stringify(built.exports.inject))

section('apply() 注册')
ok('same injected slot names', legacy.injections.join(',') === built.injections.join(','), `${legacy.injections.join(',')} vs ${built.injections.join(',')}`)
ok('injects into settings.plugins.tab', built.injections.join(',') === 'settings.plugins.tab', built.injections.join(','))
ok('registers exactly one tab (both)', legacy.registrations.length === 1 && built.registrations.length === 1, `${String(legacy.registrations.length)} vs ${String(built.registrations.length)}`)
{
  const a = legacy.registrations[0]?.options
  const b = built.registrations[0]?.options
  const difference = diff(a ?? null, b ?? null, 'options')
  ok('register options are identical', difference === null, difference ?? '')
  ok('options carry name+id+order+label', b?.name === 'settings.plugins.tab' && b?.id === 'env-manager' && b?.order === 100 && typeof b?.label === 'string', JSON.stringify(b ?? {}))
  ok('component is a function', typeof built.registrations[0]?.component === 'function')
}

/* 逐步交互对比 */
const modes = ['ok', 'nobackup', 'reject', 'error', 'pending']
const probes = []
for (const mode of modes) {
  for (const action of [null, ...ACTIONS.filter((a) => modesFor(a).includes(mode))]) {
    const id = action === null ? 'none' : action.id
    const legacyRun = await drive(legacy, mode, action)
    const builtRun = await drive(built, mode, action)
    probes.push({ mode, action, id, legacy: legacyRun, built: builtRun })
  }
}

section('渲染与交互快照')
console.log(`  无点击探针步骤: ${probes[0].legacy.steps.map(([l]) => l).join(' → ')}`)
console.log(`  按钮数（loaded 树）: ${String(probes[0].legacy.buttonCount)}　响应模式: ${modes.join(' / ')}　脚本: ${String(ACTIONS.length)} 个　驱动次数: ${String(probes.length * 2)}`)
console.log(`  迟到调用（上一轮驱动泄漏、已丢弃）: ${String(staleCalls)}　每模式探针数: ${modes.map((m) => `${m}=${String(probes.filter((p) => p.mode === m).length)}`).join(' ')}`)
{
  // 脚本里按标签找不到按钮 = 脚本本身失效（测试的"假通过"来源之一），必须显式暴露
  const missing = probes.flatMap((p) => p.legacy.missing.map((m) => `${p.mode}/${p.id}: ${m}`))
  ok('every scripted step found its target in the legacy tree', missing.length === 0, missing.slice(0, 6).join('\n      '))
  const missingNew = probes.flatMap((p) => p.built.missing.map((m) => `${p.mode}/${p.id}: ${m}`))
  ok('every scripted step found its target in the new tree', missingNew.length === 0, missingNew.slice(0, 6).join('\n      '))
  console.log(`  脚本步数（ok 模式）: ${probes.filter((p) => p.mode === 'ok').map((p) => `${p.id}(${String(p.legacy.steps.length)})`).join(' ')}`)
}

for (const probe of probes) {
  const tag = `${probe.mode}/${probe.id}`
  const labels = probe.legacy.steps.map(([label]) => label)
  const sameLabels = labels.join('|') === probe.built.steps.map(([label]) => label).join('|')
  ok(`${tag}: same step sequence`, sameLabels, `${labels.join('|')} vs ${probe.built.steps.map(([l]) => l).join('|')}`)
  for (let i = 0; i < probe.legacy.steps.length; i += 1) {
    const [label, value] = probe.legacy.steps[i] ?? ['?', '']
    const other = probe.built.steps[i]
    if (other === undefined) {
      ok(`${tag}/${label}: new bundle produced this step`, false, 'missing')
      continue
    }
    ok(`${tag}/${label}: identical 渲染`, value === other[1], firstDifference(value, other[1]))
  }
}

/** 找出两段 JSON 的第一处差异，便于定位。 */
function firstDifference(a, b) {
  if (a === b) return ''
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  const from = Math.max(0, i - 60)
  return `at ${String(i)}:\n    legacy …${a.slice(from, i + 80)}\n    new    …${b.slice(from, i + 80)}`
}

section('写请求')
{
  const posts = probes.flatMap((p) =>
    p.legacy.calls.filter((c) => c.method === 'POST').map((c) => `${p.mode}/${p.id} → POST ${c.url} ${String(c.body)}`),
  )
  console.log(`  legacy 共发出 ${String(posts.length)} 次写请求：`)
  for (const line of [...new Set(posts)]) console.log(`    ${line}`)
  ok(
    'at least one .env write and one registry write and one credential write were exercised',
    posts.some((l) => l.includes('/api/env-manager/env ')) &&
      posts.some((l) => l.includes('/api/env-manager/registry')) &&
      posts.some((l) => l.includes('/api/env-manager/credentials')),
    `${String(posts.filter((l) => l.includes('/env ')).length)} env / ${String(posts.filter((l) => l.includes('/registry')).length)} registry / ${String(posts.filter((l) => l.includes('/credentials')).length)} credential`,
  )
  ok(
    'reject mode delivered the structured problem text to a handler',
    probes.some((p) => p.mode === 'reject' && JSON.stringify(p.legacy.steps).includes('revision 过期')),
    '',
  )
  // 只比较请求语义（方法 / URL / 体）；调用点是各 bundle 自己的，本来就不同。
  const mismatch = probes.find((p) => seq(p.legacy.calls) !== seq(p.built.calls))
  ok(
    'every probe issued byte-identical fetch sequences',
    mismatch === undefined,
    mismatch === undefined
      ? ''
      : `${mismatch.mode}/${mismatch.id}\n    legacy: ${describeCalls(mismatch.legacy.calls)}\n    new   : ${describeCalls(mismatch.built.calls)}`,
  )
}

/** 请求序列的可比形式（不含调用点）。 */
function seq(calls) {
  return JSON.stringify(calls.map((c) => [c.method, c.url, c.body]))
}

/** 把 fetch 调用列表压成一行，便于看差异。 */
function describeCalls(calls) {
  return calls.map((c) => `${c.method} ${c.url}${c.body === null ? '' : ` ${String(c.body)}`} @ ${c.at}`).join('\n             → ')
}

/* ────────────────────────────── 结论 ────────────────────────────── */

console.log(`\n${'─'.repeat(70)}`)
if (failed === 0) {
  console.log(`✅ 客户端半边运行时等价：${String(passed)} PASS / 0 FAIL`)
}
if (failed > 0) {
  console.log(`❌ ${String(passed)} PASS / ${String(failed)} FAIL`)
  for (const failure of failures.slice(0, 25)) console.log(`   - ${failure}`)
  process.exitCode = 1
}
