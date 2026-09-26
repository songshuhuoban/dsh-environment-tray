/**
 * 敌意输入审计：把畸形请求砸向所有 HTTP 处理器。
 *
 * 此前所有测试用的都是**我自己构造的合法输入**（加上少量已知攻击）。
 * 这个脚本系统性地投喂畸形输入，看是否有处理器崩溃、抛未捕获异常、
 * 或把内部细节（堆栈、路径、绝对路径）泄露到响应里。
 *
 * 判据不是"它拒绝了"，而是"它**结构化地**拒绝了，且没有泄露内部信息"。
 *
 * 运行：node audit-hostile-input.mjs
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createHostApi, STATE_ROUTE, HEALTH_ROUTE, CREDENTIAL_STATE_ROUTE } from './lib/host-api.mjs'
import { createWriteRoutes, ENV_ROUTE, CREDENTIAL_ROUTE, REGISTRY_ROUTE } from './lib/write-routes.mjs'

/**
 * 是否泄露了堆栈帧。
 *
 * **不能用朴素的 `includes('at ')`**：Node 的 JSON 解析错误消息里就有
 * `"at position 22"`，那会误报（实际踩过）。真正的堆栈帧长得像：
 * `    at fn (file:///E:/.../x.mjs:12:34)` 或 `    at E:\...\x.mjs:12:34`。
 * 所以匹配的是"at + 路径或带扩展名的文件 + 行列号"。
 */
const STACK_FRAME = /(?:^|\n)\s*at\s+(?:[^\n(]*\()?(?:file:\/\/|[A-Za-z]:[\\/]|\/)[^\n)]*:\d+:\d+/m

/** 插件自身的源码路径。出现在任何响应里都是泄露。 */
const PLUGIN_SOURCE = /[A-Za-z]:\\[^\s"\\]*dsh-environment-tray\\lib\\/i

/**
 * 是否泄露了**内部实现细节**。
 *
 * 只能对**错误响应**用这个判据。成功响应里出现 `node_modules` 是正常的 ——
 * `PATH` 变量的值里本来就有它，而展示环境正是本工具的目的。
 * 先前把两者混在一起检测，导致 14 项误报。
 *
 * @param body - 响应体。
 * @returns 泄露类型；无泄露时 undefined。
 */
function leaksInternals(body) {
  const text = String(body ?? '')
  if (STACK_FRAME.test(text)) return 'stack frame'
  if (PLUGIN_SOURCE.test(text)) return 'plugin source path'
  return undefined
}

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-hostile-'))
const projectDir = join(scratch, 'p')
const homeDir = join(scratch, 'h')
mkdirSync(projectDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })

// ── 测试替身 ────────────────────────────────────────────────────────────────
function fakeRes() {
  const c = { headers: undefined, status: undefined, body: undefined }
  return {
    c,
    writeHead(status, headers) {
      c.status = status
      c.headers = headers
    },
    end(text) {
      c.body = text
    },
  }
}

/** 造一个畸形的请求体流：可指定抛错时机与分片形状。 */
function streamReq({ url, method = 'GET', chunks = [], throwAfter = Infinity, headers = {} }) {
  return {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const [i, chunk] of chunks.entries()) {
        if (i >= throwAfter) throw new Error('simulated transport failure')
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      }
      if (throwAfter <= chunks.length) throw new Error('simulated transport failure')
    },
  }
}

const okLayer = {
  supported: true,
  async readAll() {
    return { 'os-user': { scope: 'os-user', entries: [] }, 'os-machine': { scope: 'os-machine', entries: [] } }
  },
  async write() {
    return { ok: true, type: 'REG_SZ' }
  },
  async remove() {
    return { ok: true, removed: { name: 'X', value: 'v', type: 'REG_SZ' } }
  },
}

function buildRoutes(credentialProvider) {
  const ctx = {
    credentials: credentialProvider,
    connection: { requestRejection: () => undefined },
    effect: (f) => f(),
    logger: () => ({ info: () => {}, warn: () => {} }),
    get: () => undefined,
    inject: (_d, cb) => {
      cb({ ...ctx, webServer: { register: () => () => {} } })
      return { then: () => {} }
    },
  }
  const host = createHostApi({ ctx, osLayer: okLayer })
  const write = createWriteRoutes({ ctx, osLayer: okLayer, homeOf: () => homeDir })
  return { host, write }
}

const { host, write } = buildRoutes(undefined)

// ── 1. state：敌意查询串 ────────────────────────────────────────────────────
console.log('--- hostile query strings on /state ---')
{
  const cases = [
    ['no query at all', STATE_ROUTE],
    ['empty cwd', `${STATE_ROUTE}?cwd=`],
    ['percent-only cwd', `${STATE_ROUTE}?cwd=%`],
    ['invalid percent escape', `${STATE_ROUTE}?cwd=%ZZ`],
    ['nul byte in cwd', `${STATE_ROUTE}?cwd=${encodeURIComponent('\u0000')}`],
    ['path traversal cwd', `${STATE_ROUTE}?cwd=${encodeURIComponent('..\\..\\..\\Windows')}`],
    ['very long cwd', `${STATE_ROUTE}?cwd=${encodeURIComponent('C:\\' + 'a'.repeat(5000))}`],
    ['unicode cwd', `${STATE_ROUTE}?cwd=${encodeURIComponent('C:\\用户\\项目\\emoji🎯')}`],
    ['newline in cwd', `${STATE_ROUTE}?cwd=${encodeURIComponent('C:\\a\nb')}`],
    ['repeated reveal params', `${STATE_ROUTE}?reveal=0&reveal=1&reveal=0`],
    ['unknown params', `${STATE_ROUTE}?evil=1&__proto__=x`],
    ['fragment-like', `${STATE_ROUTE}?cwd=x#frag`],
    ['reveal with junk value', `${STATE_ROUTE}?reveal=NaN`],
    ['os with junk value', `${STATE_ROUTE}?os=maybe`],
  ]

  for (const [label, url] of cases) {
    const res = fakeRes()
    let threw
    try {
      await host.state({ url, method: 'GET', headers: {} }, res)
    } catch (error) {
      threw = error
    }
    const structured = res.c.status === 200 || res.c.status === 500
    const leak = leaksInternals(res.c.body)
    ok(`no throw: ${label}`, threw === undefined, String(threw))
    ok(`structured response: ${label}`, structured, `status=${String(res.c.status)}`)
    // 只看堆栈与插件源码路径：成功响应里的 node_modules 是 PATH 的值，属正常
    ok(`no stack/source leak: ${label}`, leak === undefined, `leaked ${String(leak)} in ${String(res.c.body).slice(0, 70)}`)
    // 畸形 cwd 不应让整个请求失败：state 是只读的诊断视图
    if (res.c.status !== 200) {
      ok(`malformed cwd still yields a usable status: ${label}`, res.c.status === 500, `status=${String(res.c.status)}`)
    }
  }
}

// ── 2. 写路由：畸形 JSON 与截断传输 ─────────────────────────────────────────
console.log('\n--- hostile bodies on write routes ---')
{
  const cwdQ = `?cwd=${encodeURIComponent(projectDir)}`
  const bodies = [
    ['empty body', []],
    ['whitespace only', ['   ']],
    ['truncated json', ['{"layer":"project-env"']],
    ['json null', ['null']],
    ['json array', ['[]']],
    ['json string', ['"just a string"']],
    ['json number', ['42']],
    ['nested too deep', [JSON.stringify({ layer: 'project-env', edits: [[[[[[[[[[1]]]]]]]]]] })]],
    ['edits not an array', [JSON.stringify({ layer: 'project-env', edits: 'nope' })]],
    ['edits with null entries', [JSON.stringify({ layer: 'project-env', edits: [null] })]],
    ['edits with no op', [JSON.stringify({ layer: 'project-env', edits: [{ name: 'A' }] })]],
    ['edit name is a number', [JSON.stringify({ layer: 'project-env', edits: [{ op: 'set', name: 5, value: 'v' }] })]],
    ['edit value is an object', [JSON.stringify({ layer: 'project-env', edits: [{ op: 'set', name: 'A', value: { a: 1 } }] })]],
    ['prototype pollution attempt', [JSON.stringify({ layer: 'project-env', __proto__: { polluted: true }, edits: [{ op: 'set', name: 'A', value: 'v' }] })]],
    ['layer is a number', [JSON.stringify({ layer: 7, edits: [{ op: 'set', name: 'A', value: 'v' }] })]],
    ['layer with traversal', [JSON.stringify({ layer: '../user-env', edits: [{ op: 'set', name: 'A', value: 'v' }] })]],
    ['expectedRevision wrong type', [JSON.stringify({ layer: 'project-env', expectedRevision: {}, edits: [{ op: 'set', name: 'A', value: 'v' }] })]],
    ['json with BOM prefix', ['\uFEFF' + JSON.stringify({ layer: 'project-env', edits: [{ op: 'set', name: 'A', value: 'v' }] })]],
    ['binary-ish garbage', [Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02])]],
    ['many small chunks', ['{"layer":"pro', 'ject-env","edit', 's":[{"op":"set","na', 'me":"A","value":"v"}]}']],
  ]

  for (const [label, chunks] of bodies) {
    const res = fakeRes()
    let threw
    try {
      await write.env(streamReq({ url: ENV_ROUTE + cwdQ, method: 'POST', chunks }), res)
    } catch (error) {
      threw = error
    }
    ok(`no throw: ${label}`, threw === undefined, String(threw))
    ok(`structured response: ${label}`, res.c.status !== undefined, `status=${String(res.c.status)}`)
    ok(`no internal leakage: ${label}`, leaksInternals(res.c.body) === undefined, `leaked ${String(leaksInternals(res.c.body))} in ${String(res.c.body).slice(0, 80)}`)
  }

  // 传输中途失败：必须被转述为结构化错误，而不是未捕获异常
  {
    const res = fakeRes()
    let threw
    try {
      await write.env(streamReq({ url: ENV_ROUTE + cwdQ, method: 'POST', chunks: ['{"a":'], throwAfter: 1 }), res)
    } catch (error) {
      threw = error
    }
    ok('transport failure does not escape the handler', threw === undefined, String(threw))
    ok('transport failure yields a structured error', res.c.status === 500, String(res.c.status))
  }

  // 原型污染：全局对象必须未被污染
  ok('Object.prototype was not polluted', {}.polluted === undefined, String({}.polluted))
  ok('global polluted flag absent', globalThis.polluted === undefined)

  // 超大 body 必须被拒（不是把内存吃光）
  {
    const res = fakeRes()
    const huge = `{"layer":"project-env","edits":[{"op":"set","name":"A","value":"${'x'.repeat(300 * 1024)}"}]}`
    await write.env(streamReq({ url: ENV_ROUTE + cwdQ, method: 'POST', chunks: [huge] }), res)
    ok('oversized body is rejected', res.c.status === 500, String(res.c.status))
    const parsed = JSON.parse(res.c.body)
    ok('oversized rejection names the limit', String(parsed.message).includes('上限'), String(parsed.message).slice(0, 80))
  }
}

// ── 3. 凭据路由：畸形 ref 与值 ──────────────────────────────────────────────
console.log('\n--- hostile input on /credentials ---')
{
  const secretProvider = {
    async describe() {
      return { configured: false, writable: true }
    },
    async set() {},
    async unset() {},
    async resolve() {
      throw new Error('must not be called')
    },
    async listRecords() {
      return []
    },
  }
  const { write: credWrite } = buildRoutes(secretProvider)

  const cases = [
    ['ref missing', { value: 'v' }],
    ['ref is a number', { ref: 5, value: 'v' }],
    ['ref is null', { ref: null, value: 'v' }],
    ['ref with space', { ref: 'A B', value: 'v' }],
    ['ref with dash', { ref: 'A-B', value: 'v' }],
    ['ref with slash', { ref: 'a/b', value: 'v' }],
    ['ref with newline', { ref: 'A\nB', value: 'v' }],
    ['ref empty', { ref: '', value: 'v' }],
    ['value is a number', { ref: 'K', value: 5 }],
    ['value is null', { ref: 'K', value: null }],
    ['value is an array', { ref: 'K', value: ['a'] }],
    ['value very long', { ref: 'K', value: 'x'.repeat(200000) }],
    ['unset with junk value', { ref: 'K', unset: 'yes' }],
  ]

  for (const [label, body] of cases) {
    const res = fakeRes()
    let threw
    try {
      await credWrite.credentials(streamReq({ url: CREDENTIAL_ROUTE, method: 'POST', chunks: [JSON.stringify(body)] }), res)
    } catch (error) {
      threw = error
    }
    ok(`no throw: ${label}`, threw === undefined, String(threw))
    ok(`structured: ${label}`, res.c.status !== undefined, `status=${String(res.c.status)}`)
    // 关键：无论输入多畸形，响应里都绝不能出现"值"字段
    const parsed = res.c.body === undefined ? {} : JSON.parse(res.c.body)
    ok(`no value echoed: ${label}`, !JSON.stringify(parsed).includes('"value"'), JSON.stringify(parsed).slice(0, 80))
  }
}

// ── 4. 注册表路由：畸形 scope / name / type ─────────────────────────────────
console.log('\n--- hostile input on /registry ---')
{
  const cases = [
    ['scope missing', { name: 'X', value: 'v' }],
    ['scope is a number', { scope: 1, name: 'X', value: 'v' }],
    ['scope is os-user-ish', { scope: 'os_user', name: 'X', value: 'v' }],
    ['scope uppercase', { scope: 'OS-USER', name: 'X', value: 'v' }],
    ['name with nul', { scope: 'os-user', name: 'A\u0000B', value: 'v' }],
    ['name with newline', { scope: 'os-user', name: 'A\nB', value: 'v' }],
    ['name with quote', { scope: 'os-user', name: 'A"B', value: 'v' }],
    ['name with percent', { scope: 'os-user', name: '%PATH%', value: 'v' }],
    ['name very long', { scope: 'os-user', name: 'N'.repeat(5000), value: 'v' }],
    ['type is unknown', { scope: 'os-user', name: 'X', value: 'v', type: 'REG_EVIL' }],
    ['type is a number', { scope: 'os-user', name: 'X', value: 'v', type: 7 }],
    ['value is an array', { scope: 'os-user', name: 'X', value: ['a'] }],
    ['unset missing name', { scope: 'os-user', unset: true }],
  ]

  for (const [label, body] of cases) {
    const res = fakeRes()
    let threw
    try {
      await write.registry(streamReq({ url: REGISTRY_ROUTE, method: 'POST', chunks: [JSON.stringify(body)] }), res)
    } catch (error) {
      threw = error
    }
    ok(`no throw: ${label}`, threw === undefined, String(threw))
    ok(`structured: ${label}`, res.c.status !== undefined, `status=${String(res.c.status)}`)
    ok(`no internal leakage: ${label}`, leaksInternals(res.c.body) === undefined, `leaked ${String(leaksInternals(res.c.body))} in ${String(res.c.body).slice(0, 80)}`)
  }
}

// ── 5. 内部路径不得泄露到响应里 ─────────────────────────────────────────────
console.log('\n--- no internal detail leakage ---')
{
  // 故意让 state 失败：传一个不可能作为目录的 cwd 不一定会失败，
  // 所以改用"非法层"让 envRead 失败，检查消息里不出现服务器文件系统的绝对路径
  const res = fakeRes()
  await write.envRead(streamReq({ url: `${ENV_ROUTE}/read`, method: 'POST', chunks: [JSON.stringify({ layer: 'nope' })] }), res)
  const body = String(res.c.body)
  ok('invalid layer is refused', res.c.status === 500, String(res.c.status))
  ok('invalid layer message does not leak the plugin source path', !body.includes('env-manager-tray\\lib'), body.slice(0, 120))
  ok('invalid layer message does not leak node_modules', !body.includes('node_modules'), body.slice(0, 120))
}

// ── 6. 路径限制的真实边界（如实记录，不假装更强）────────────────────────────
// 审计暴露的事实：`cwd` 被解析后**可以是任意目录**，路径白名单只保证
// "文件名一定是 `.env`"，不保证"目录在允许范围内"。
//
// 为什么判定为可接受：写端点已有请求策略闸门（§21），能通过闸门的调用者
// 本就是持有会话 cookie 的用户，而该用户可以直接改文件 —— 限制 cwd 只增加
// 误伤合法用法的风险，不增加真实防护。这里把它**写成断言**，
// 免得日后有人以为这个端点做了目录限制。
console.log('\n--- documented limit: cwd is resolved, not sandboxed ---')
{
  const traversal = streamReq({
    url: `${ENV_ROUTE}?cwd=${encodeURIComponent('..\\..\\..\\Windows')}`,
    method: 'POST',
    chunks: [JSON.stringify({ layer: 'project-env', expectedRevision: 'absent', edits: [] })],
  })
  const res = fakeRes()
  await write.env(traversal, res)
  const parsed = JSON.parse(res.c.body)
  // 它接受 cwd，但拒绝空编辑列表 —— 证明 cwd 被解析而非被限制
  ok('cwd is resolved rather than rejected', parsed.error === 'no-edits', JSON.stringify(parsed).slice(0, 100))

  // 而"文件名"始终由层标识推导，这一点无论 cwd 是什么都成立
  const layered = streamReq({
    url: `${ENV_ROUTE}?cwd=${encodeURIComponent('..\\..\\..\\Windows')}`,
    method: 'POST',
    chunks: [JSON.stringify({ layer: 'project-env', path: join(scratch, 'evil.env'), expectedRevision: 'absent', edits: [{ op: 'set', name: 'A', value: '1' }] })],
  })
  const res2 = fakeRes()
  await write.env(layered, res2)
  const parsed2 = JSON.parse(res2.c.body)
  ok('an explicit path is still rejected regardless of cwd', parsed2.error === 'write-failed', JSON.stringify(parsed2).slice(0, 120))
  ok('the rejection names the derived path', String(parsed2.message).includes('.env'), String(parsed2.message).slice(0, 120))
}

rmSync(scratch, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
