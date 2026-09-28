/**
 * 写路由验证。
 *
 * 这是全插件风险最高的端点（能写文件、能改注册表），所以测试重点是
 * **爆炸半径**而不是功能：
 *   - 路径注入是否真的被挡住（声明路径与推导路径不一致 → 拒绝）
 *   - 层标识是否被限制成白名单
 *   - 请求体是否有上限、非法 JSON 是否被转述
 *   - CAS 冲突是否回 409（可重试）而校验失败回 400
 *   - 密钥写入的响应里**绝不能出现密钥**
 *
 * 运行：node verify-write-routes.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createWriteRoutes,
  createRequestGuard,
  readJsonBody,
  resolveLayerPath,
  toWriteRejected,
  WriteRejected,
  ENV_ROUTE,
  CREDENTIAL_ROUTE,
  REGISTRY_ROUTE,
} from './lib/write-routes.js'
import { EnvEditRejected, readDotEnvFile } from './lib/env-write.js'
import { CredentialAccess, CredentialShadowed, CredentialRejected } from './lib/credentials.js'
import { USER_SCOPE, MACHINE_SCOPE } from './lib/registry.js'
import { parseDotEnv } from './lib/env-model.js'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 假 req / res ────────────────────────────────────────────────────────────
/** 把对象变成一个可 async-iterate 的请求体流。 */
function bodyStream(text) {
  const buffer = Buffer.from(text, 'utf8')
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer
    },
  }
}

/** 造一个带 JSON body 的假请求。 */
function postReq(url, body) {
  const stream = bodyStream(body === undefined ? '' : JSON.stringify(body))
  return { url, method: 'POST', [Symbol.asyncIterator]: stream[Symbol.asyncIterator] }
}

/**
 * 从捕获到的响应里读 JSON。
 *
 * **刻意不用 `?.` 吞掉失败**：先前写法在响应还没写出时返回 undefined，
 * 于是断言只报"值不对"，掩盖了真正的时序问题。这里缺失 body 就直接抛，
 * 让问题在第一次出现时就炸出来。
 */
function json(res) {
  if (res.captured.body === undefined) {
    throw new Error(`响应体尚未写出（status=${String(res.captured.status)}）—— 处理器可能没有 await 响应链`)
  }
  return JSON.parse(res.captured.body)
}

function fakeRes() {
  const captured = {}
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text
      captured.json = (() => {
        try {
          return JSON.parse(text)
        } catch {
          return undefined
        }
      })()
    },
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-writeroutes-'))
const projectDir = join(scratch, 'project')
const homeDir = join(scratch, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })

// ── 1. 请求体读取 ───────────────────────────────────────────────────────────
console.log('--- body reading ---')
{
  const parsed = await readJsonBody(bodyStream('{"a":1}'))
  ok('parses a JSON object', parsed.a === 1, JSON.stringify(parsed))

  const empty = await readJsonBody(bodyStream('   '))
  ok('empty body becomes an empty object', JSON.stringify(empty) === '{}', JSON.stringify(empty))

  let badJson
  try {
    await readJsonBody(bodyStream('{not json'))
  } catch (error) {
    badJson = error
  }
  ok('malformed JSON is reported, not thrown raw', badJson !== undefined && String(badJson.message).includes('JSON'), String(badJson))

  // 超过上限必须被拒绝，而不是把内存吃光
  const huge = `{"v":"${'x'.repeat(300 * 1024)}"}`
  let tooBig
  try {
    await readJsonBody(bodyStream(huge))
  } catch (error) {
    tooBig = error
  }
  ok('oversized body is rejected', tooBig !== undefined && String(tooBig.message).includes('上限'), String(tooBig?.message).slice(0, 60))
}

// ── 2. 路径注入防线（最关键的一组）──────────────────────────────────────────
console.log('\n--- path allowlisting (the critical defence) ---')
{
  const fakeHome = homeDir

  const projectPath = resolveLayerPath('project-env', projectDir, fakeHome)
  ok('project-env resolves under cwd', projectPath === resolve(projectDir, '.env'), projectPath)

  const userPath = resolveLayerPath('user-env', projectDir, fakeHome)
  ok('user-env resolves under home', userPath === resolve(homeDir, '.env'), userPath)

  // 声明一致 → 允许
  ok(
    'matching claimed path is accepted',
    resolveLayerPath('project-env', projectDir, fakeHome, projectPath) === projectPath,
  )

  // 声明不一致 → 拒绝（这是防注入的核心断言）
  const attacks = [
    '/etc/passwd',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    join(projectDir, '..', '..', 'evil.env'),
    join(homeDir, 'other.env'),
    'relative.env',
  ]
  for (const attack of attacks) {
    let rejected
    try {
      resolveLayerPath('project-env', projectDir, fakeHome, attack)
    } catch (error) {
      rejected = error
    }
    ok(`path injection blocked: ${attack.slice(0, 34)}`, rejected !== undefined, String(rejected?.message).slice(0, 80))
  }

  // 层标识白名单
  for (const badLayer of ['os-user', 'os-machine', 'credential', '', undefined, 'project-env/../..']) {
    let rejected
    try {
      resolveLayerPath(badLayer, projectDir, fakeHome)
    } catch (error) {
      rejected = error
    }
    ok(`invalid layer rejected: ${JSON.stringify(badLayer)}`, rejected !== undefined)
  }
}

// ── 3. 异常 → HTTP 状态码映射 ───────────────────────────────────────────────
console.log('\n--- error status mapping ---')
{
  ok('stale revision maps to 409', toWriteRejected(new EnvEditRejected('stale-revision', 'x')).status === 409)
  ok('validation failure maps to 400', toWriteRejected(new EnvEditRejected('validation-failed', 'x')).status === 400)
  ok('shadowed credential maps to 409', toWriteRejected(new CredentialShadowed('R', 'env', false)).status === 409)
  ok('credential rejection maps to 400', toWriteRejected(new CredentialRejected('empty-value', 'x')).status === 400)
  ok('unknown failure maps to 500', toWriteRejected(new Error('boom')).status === 500)
  ok('problems survive the mapping', toWriteRejected(new EnvEditRejected('validation-failed', 'x', [{ code: 'a' }])).problems.length === 1)
  ok('already-normalised rejection passes through', toWriteRejected(new WriteRejected('c', 'm', [], 418)).status === 418)
}

// ── 4. `.env` 写路由 ────────────────────────────────────────────────────────
console.log('\n--- .env write route ---')
const osLayer = {
  supported: true,
  async write(scope, name, value, type) {
    return { ok: true, type: type ?? 'REG_SZ' }
  },
  async remove() {
    return { ok: true }
  },
}

const routes = createWriteRoutes({
  ctx: { credentials: undefined },
  osLayer,
  homeOf: () => homeDir,
  // 这些用例测的是业务语义，不是请求策略；用一个放行闸门把策略那层隔离掉。
  // 策略本身有专门的一组用例（下面第 7 节）。
  guard: () => true,
})

const envFile = join(projectDir, '.env')

{
  // 读 → 写 → 冲突 的完整链路
  const readRes = fakeRes()
  await routes.envRead(postReq(`${ENV_ROUTE}/read?cwd=${encodeURIComponent(projectDir)}`, { layer: 'project-env' }), readRes)
  ok('envRead reports absence for a missing file', readRes.captured.json?.exists === false, JSON.stringify(readRes.captured.json))
  ok('envRead gives the absent revision', readRes.captured.json?.revision === 'absent')

  const writeRes = fakeRes()
  await routes.env(
    postReq(`${ENV_ROUTE}?cwd=${encodeURIComponent(projectDir)}`, {
      layer: 'project-env',
      expectedRevision: 'absent',
      edits: [{ op: 'set', name: 'CREATED_BY_ROUTE', value: 'yes' }],
    }),
    writeRes,
  )
  ok('env write returns 200', writeRes.captured.status === 200, JSON.stringify(writeRes.captured.json))
  ok('env write reports ok', writeRes.captured.json?.ok === true)
  ok('env write returns the new revision', typeof writeRes.captured.json?.revision === 'string')
  ok('env write returns the key list', writeRes.captured.json?.keys?.includes('CREATED_BY_ROUTE'))
  ok('file was actually written', parseDotEnv(readFileSync(envFile, 'utf8')).CREATED_BY_ROUTE === 'yes')

  // 陈旧 revision → 409
  const conflictRes = fakeRes()
  await routes.env(
    postReq(`${ENV_ROUTE}?cwd=${encodeURIComponent(projectDir)}`, {
      layer: 'project-env',
      expectedRevision: 'absent',
      edits: [{ op: 'set', name: 'X', value: '1' }],
    }),
    conflictRes,
  )
  ok('stale revision yields 409', conflictRes.captured.status === 409, String(conflictRes.captured.status))
  ok('conflict response names the code', conflictRes.captured.json?.error === 'stale-revision', String(conflictRes.captured.json?.error))
  ok('conflict did not modify the file', parseDotEnv(readFileSync(envFile, 'utf8')).X === undefined)

  // 禁止名单 → 400 且带 problems
  const current = await readDotEnvFile(envFile)
  const forbiddenRes = fakeRes()
  await routes.env(
    postReq(`${ENV_ROUTE}?cwd=${encodeURIComponent(projectDir)}`, {
      layer: 'project-env',
      expectedRevision: current.revision,
      edits: [
        { op: 'set', name: 'FINE_ONE', value: 'a' },
        { op: 'set', name: 'DSH_HOME', value: 'evil' },
      ],
    }),
    forbiddenRes,
  )
  ok('forbidden name yields 400', forbiddenRes.captured.status === 400, String(forbiddenRes.captured.status))
  ok('forbidden name is reported structurally', Array.isArray(forbiddenRes.captured.json?.problems), JSON.stringify(forbiddenRes.captured.json?.problems))
  ok('the whole batch was rejected (nothing written)', parseDotEnv(readFileSync(envFile, 'utf8')).FINE_ONE === undefined)

  // 路径注入经真实路由被挡住
  const injectionRes = fakeRes()
  await routes.env(
    postReq(`${ENV_ROUTE}?cwd=${encodeURIComponent(projectDir)}`, {
      layer: 'project-env',
      path: join(scratch, 'evil.env'),
      expectedRevision: 'absent',
      edits: [{ op: 'set', name: 'PWNED', value: '1' }],
    }),
    injectionRes,
  )
  ok('path injection through the route is rejected', injectionRes.captured.status === 500, String(injectionRes.captured.status))
  // 断言"文件不存在"时必须用 existsSync —— 先前直接 readFileSync 会抛 ENOENT，
  // 而那正是期望结果，等于测试把自己炸了
  ok('injection attempt created no file', !existsSync(join(scratch, 'evil.env')), join(scratch, 'evil.env'))
  ok(
    'injection rejection explains the mismatch',
    String(json(injectionRes).message).includes('不一致'),
    String(json(injectionRes).message),
  )

  // GET 必须被拒
  const methodRes = fakeRes()
  await routes.env({ url: ENV_ROUTE, method: 'GET' }, methodRes)
  ok('GET on a write route yields 405', methodRes.captured.status === 405, String(methodRes.captured.status))
  ok('405 advertises POST', methodRes.captured.headers.allow === 'POST')
}

// ── 5. 凭据写路由（响应绝不能含密钥）────────────────────────────────────────
console.log('\n--- credential write route ---')
{
  const SECRET = 'sk-live-secret-abc123'
  const state = new Map([['SHADOWED_KEY', { source: 'env', writable: false, value: 'x' }]])
  const provider = {
    async describe(ref) {
      const e = state.get(ref)
      return e === undefined ? { configured: false, writable: true } : { configured: true, source: e.source, writable: e.writable }
    },
    async set(ref, value) {
      const e = state.get(ref)
      if (e !== undefined && !e.writable) throw new Error('shadowed')
      state.set(ref, { source: 'file', writable: true, value })
    },
    async unset(ref) {
      const e = state.get(ref)
      if (e !== undefined && !e.writable) throw new Error('shadowed')
      state.delete(ref)
    },
    async resolve() {
      throw new Error('resolve must never be called by the write route')
    },
    async listRecords() {
      return []
    },
  }

  const credRoutes = createWriteRoutes({
    ctx: { credentials: provider },
    osLayer,
    homeOf: () => homeDir,
    guard: () => true,
  })

  const setRes = fakeRes()
  await credRoutes.credentials(postReq(CREDENTIAL_ROUTE, { ref: 'NEW_KEY', value: SECRET }), setRes)
  ok('credential set returns 200', setRes.captured.status === 200, JSON.stringify(setRes.captured.json))
  ok('credential set reports configured', setRes.captured.json?.view?.configured === true)
  ok('SECRET IS NOT IN THE RESPONSE', !String(setRes.captured.body).includes(SECRET), 'secret leaked!')
  ok('response carries no value field', !('value' in (setRes.captured.json?.view ?? {})))

  // 遮蔽 → 409 且说明可行动
  const shadowRes = fakeRes()
  await credRoutes.credentials(postReq(CREDENTIAL_ROUTE, { ref: 'SHADOWED_KEY', value: 'sk-x' }), shadowRes)
  ok('shadowed credential yields 409', shadowRes.captured.status === 409, String(shadowRes.captured.status))
  ok('shadowed response explains the source', String(shadowRes.captured.json?.message).includes('启动环境'), String(shadowRes.captured.json?.message))

  // 空值 → 400
  const emptyRes = fakeRes()
  await credRoutes.credentials(postReq(CREDENTIAL_ROUTE, { ref: 'K', value: '' }), emptyRes)
  ok('empty value yields 400', emptyRes.captured.status === 400, String(emptyRes.captured.status))
  ok('empty value names its code', emptyRes.captured.json?.error === 'empty-value', String(emptyRes.captured.json?.error))

  // unset
  const unsetRes = fakeRes()
  await credRoutes.credentials(postReq(CREDENTIAL_ROUTE, { ref: 'NEW_KEY', unset: true }), unsetRes)
  ok('credential unset returns 200', unsetRes.captured.status === 200, JSON.stringify(unsetRes.captured.json))
  ok('credential is gone after unset', unsetRes.captured.json?.view?.configured === false)

  // 凭据域缺失 → 501（明确告知不支持，而不是假装成功）
  const noCredRoutes = createWriteRoutes({ ctx: { credentials: undefined }, osLayer, homeOf: () => homeDir, guard: () => true })
  const noCredRes = fakeRes()
  await noCredRoutes.credentials(postReq(CREDENTIAL_ROUTE, { ref: 'K', value: 'v' }), noCredRes)
  ok('absent credential domain yields 501', noCredRes.captured.status === 501, String(noCredRes.captured.status))
  ok('absent credential domain explains itself', noCredRes.captured.json?.message === '凭据服务不可用', String(noCredRes.captured.json?.message))
}

// ── 6. 注册表写路由 ─────────────────────────────────────────────────────────
console.log('\n--- registry write route ---')
{
  const calls = []
  const recordingLayer = {
    supported: true,
    async write(scope, name, value, type) {
      calls.push({ kind: 'write', scope, name, value, type })
      return { ok: true, type: type ?? 'REG_SZ' }
    },
    async remove(scope, name) {
      calls.push({ kind: 'remove', scope, name })
      return { ok: true }
    },
  }
  const regRoutes = createWriteRoutes({ ctx: { credentials: undefined }, osLayer: recordingLayer, homeOf: () => homeDir, guard: () => true })

  const writeRes = fakeRes()
  await regRoutes.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, name: 'MY_VAR', value: 'v', type: 'REG_EXPAND_SZ' }), writeRes)
  ok('registry write returns 200', writeRes.captured.status === 200, JSON.stringify(writeRes.captured.json))
  ok('registry type is passed through', calls[0]?.type === 'REG_EXPAND_SZ', JSON.stringify(calls[0]))
  ok(
    'response warns that it applies after restart',
    writeRes.captured.json?.restartRequired === true,
    JSON.stringify(writeRes.captured.json),
  )

  const machineRes = fakeRes()
  await regRoutes.registry(postReq(REGISTRY_ROUTE, { scope: MACHINE_SCOPE, name: 'SYS', value: 'v' }), machineRes)
  ok('machine scope accepted', machineRes.captured.status === 200 && calls[1]?.scope === MACHINE_SCOPE, JSON.stringify(calls[1]))

  const badScopeRes = fakeRes()
  await regRoutes.registry(postReq(REGISTRY_ROUTE, { scope: 'os-evil', name: 'X', value: 'v' }), badScopeRes)
  ok('invalid scope yields 400', badScopeRes.captured.status === 400, String(badScopeRes.captured.status))

  const noNameRes = fakeRes()
  await regRoutes.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, value: 'v' }), noNameRes)
  ok('missing name yields 400', noNameRes.captured.status === 400, String(noNameRes.captured.status))

  const unsetRes = fakeRes()
  await regRoutes.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, name: 'MY_VAR', unset: true }), unsetRes)
  ok('registry unset returns 200', unsetRes.captured.status === 200)
  ok('registry unset called remove', calls.some((c) => c.kind === 'remove' && c.name === 'MY_VAR'))
  ok('registry unset warns when no runtime synchronizer exists', unsetRes.captured.json?.restartRequired === true)

  // 撤销能力：宿主必须回传被删的原值与类型（删除注册表值没有回收站）
  {
    const undoLayer = {
      supported: true,
      async write() {
        return { ok: true, type: 'REG_SZ' }
      },
      async remove() {
        return { ok: true, removed: { name: 'MY_VAR', value: '%USERPROFILE%\\bin', type: 'REG_EXPAND_SZ' } }
      },
    }
    const undoRoutes = createWriteRoutes({ ctx: { credentials: undefined }, osLayer: undoLayer, homeOf: () => homeDir, guard: () => true })
    const res = fakeRes()
    await undoRoutes.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, name: 'MY_VAR', unset: true }), res)
    const body = json(res)
    ok('unset returns an undo record', body.undo !== undefined, JSON.stringify(body))
    ok('undo carries the exact original value', body.undo?.value === '%USERPROFILE%\\bin', JSON.stringify(body.undo))
    ok('undo carries the original type', body.undo?.type === 'REG_EXPAND_SZ', String(body.undo?.type))
    ok('undo carries the original name', body.undo?.name === 'MY_VAR', String(body.undo?.name))
    ok('no backupUnavailable flag when a backup exists', body.backupUnavailable === undefined)
  }

  // 取不到备份时必须如实报告，而不是假装可撤销
  {
    const noBackupLayer = {
      supported: true,
      async write() {
        return { ok: true, type: 'REG_SZ' }
      },
      async remove() {
        return { ok: true, backupUnavailable: true }
      },
    }
    const noBackupRoutes = createWriteRoutes({ ctx: { credentials: undefined }, osLayer: noBackupLayer, homeOf: () => homeDir, guard: () => true })
    const res = fakeRes()
    await noBackupRoutes.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, name: 'MY_VAR', unset: true }), res)
    const body = json(res)
    ok('missing backup is reported', body.backupUnavailable === true, JSON.stringify(body))
    ok('missing backup produces no undo record', body.undo === undefined)
  }

  // 不支持平台 → 501
  const unsupported = createWriteRoutes({
    ctx: { credentials: undefined },
    osLayer: { supported: false },
    homeOf: () => homeDir,
    guard: () => true,
  })
  const unsupRes = fakeRes()
  await unsupported.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, name: 'X', value: 'v' }), unsupRes)
  ok('unsupported platform yields 501', unsupRes.captured.status === 501, String(unsupRes.captured.status))
  ok('unsupported platform explains why', String(unsupRes.captured.json?.message).includes('不支持'), String(unsupRes.captured.json?.message))

  // 写入失败必须被转述
  const failing = createWriteRoutes({
    ctx: { credentials: undefined },
    osLayer: { supported: true, write: async () => ({ ok: false, error: 'ERROR: Access is denied.' }) },
    homeOf: () => homeDir,
    guard: () => true,
  })
  const failRes = fakeRes()
  await failing.registry(postReq(REGISTRY_ROUTE, { scope: MACHINE_SCOPE, name: 'X', value: 'v' }), failRes)
  ok('registry failure yields 500', failRes.captured.status === 500, String(failRes.captured.status))
  ok('registry failure preserves the OS message', String(failRes.captured.json?.message).includes('Access is denied'), String(failRes.captured.json?.message))
}

// ── 7. 请求策略闸门（安全层，独立于业务语义）────────────────────────────────
// 背景（实测确证）：`dsh-host-webserver` 自身不带鉴权，鉴权由路由所有者负责；
// 我们直接注册在 webserver 上，因此默认绕过了 `dsh-client-connection` 的闸门。
// 未加闸门时，一个带 `Sec-Fetch-Site: cross-site` + 外部 Origin 的请求能成功
// 写入 `.env`，而第一方 `/api/gateway` 在同样条件下回 401。
console.log('\n--- request policy guard ---')
{
  /** 复刻 `isTrustedApiRequest` + 认证的判定，用于验证闸门接线是否正确。 */
  const policyConnection = {
    requestRejection(req) {
      const host = req.headers?.host
      if (host === undefined) return 403
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return 403
      if (req.headers['sec-fetch-site'] === 'cross-site') return 403
      const origin = req.headers.origin
      if (origin !== undefined) {
        try {
          if (new URL(origin).host !== host) return 403
        } catch {
          return 403
        }
      }
      return String(req.headers.cookie ?? '').includes('dsh-auth-') ? undefined : 401
    },
  }

  const guard = createRequestGuard({ connection: policyConnection })
  const authedHeaders = { host: '127.0.0.1:3180', cookie: 'dsh-auth-x=1' }

  ok('loopback + authenticated is allowed', guard({ headers: authedHeaders }, fakeRes()) === true)

  // 跨站：必须 403
  {
    const res = fakeRes()
    const allowed = guard({ headers: { ...authedHeaders, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } }, res)
    ok('cross-site request is rejected', allowed === false)
    ok('cross-site rejection is 403', res.captured.status === 403, String(res.captured.status))
    ok('cross-site rejection names the reason', res.captured.json?.error === 'untrusted-origin', String(res.captured.json?.error))
  }

  // Host 指向外部域（DNS rebinding 形状）：必须 403
  {
    const res = fakeRes()
    const allowed = guard({ headers: { ...authedHeaders, host: 'attacker.example' } }, res)
    ok('foreign Host header is rejected', allowed === false)
    ok('foreign Host rejection is 403', res.captured.status === 403, String(res.captured.status))
  }

  // 未认证：必须 401（而不是放行）
  {
    const res = fakeRes()
    const allowed = guard({ headers: { host: '127.0.0.1:3180' } }, res)
    ok('unauthenticated request is rejected', allowed === false)
    ok('unauthenticated rejection is 401', res.captured.status === 401, String(res.captured.status))
    ok('unauthenticated rejection names the reason', res.captured.json?.error === 'unauthenticated', String(res.captured.json?.error))
  }

  // 缺 connection 必须失败关闭（503），绝不能静默放行
  {
    const res = fakeRes()
    const allowed = createRequestGuard({ connection: undefined })({ headers: authedHeaders }, res)
    ok('missing connection fails closed', allowed === false)
    ok('fail-closed status is 503', res.captured.status === 503, String(res.captured.status))
    ok('fail-closed explains itself', res.captured.json?.message === '无法验证请求，请重新连接 DSH', String(res.captured.json?.message))
  }

  ok('connection without requestRejection also fails closed', createRequestGuard({ connection: {} })({ headers: authedHeaders }, fakeRes()) === false)

  // 闸门必须真的接在**每一个**路由上：用严格闸门跑业务合法的请求，应全被 403 拦下
  {
    const denyingGuard = (_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'untrusted-origin' }))
      return false
    }
    const guarded = createWriteRoutes({
      ctx: { credentials: undefined },
      osLayer,
      homeOf: () => homeDir,
      guard: denyingGuard,
    })

    // 每个处理器配一个"业务上本该成功"的请求
    const cases = [
      ['env', `${ENV_ROUTE}?cwd=${encodeURIComponent(projectDir)}`, { layer: 'project-env', expectedRevision: 'absent', edits: [{ op: 'set', name: 'GUARD_TEST', value: '1' }] }],
      ['envRead', `${ENV_ROUTE}/read?cwd=${encodeURIComponent(projectDir)}`, { layer: 'project-env' }],
      ['credentials', CREDENTIAL_ROUTE, { ref: 'GUARD_TEST_KEY', value: 'v' }],
      ['registry', REGISTRY_ROUTE, { scope: USER_SCOPE, name: 'GUARD_TEST', value: 'v' }],
    ]

    for (const [name, url, body] of cases) {
      const res = fakeRes()
      await guarded[name](postReq(url, body), res)
      ok(`guard gates the ${name} handler`, res.captured.status === 403, `${name} status=${String(res.captured.status)}`)
    }

    // 闸门拦下后绝不能落盘：注意 projectDir/.env 在本节之前已被第 4 节创建过，
    // 所以只能断言"这个键没被写进去"，不能断言文件不存在
    const envText = existsSync(join(projectDir, '.env')) ? readFileSync(join(projectDir, '.env'), 'utf8') : ''
    ok('guarded request wrote no new key', !envText.includes('GUARD_TEST'), JSON.stringify(envText))
  }
}

console.log('\n--- create-only registry ---')
{
  const values = new Map([['EXISTING', { name: 'Existing', value: 'original', type: 'REG_SZ' }]])
  let writes = 0
  let readError = false
  const creationRoutes = createWriteRoutes({ ctx: {}, guard: () => true, osLayer: {
    supported: true,
    async readAll() { return {
      [USER_SCOPE]: { entries: [...values.values()], error: readError ? 'failed' : undefined },
      [MACHINE_SCOPE]: { entries: [] },
    } },
    async write(scope, name, value, type) {
      await Promise.resolve(); writes++
      values.set(name.toUpperCase(), { name, value, type })
      return { ok: true, type }
    },
    async remove() { return { ok: true } },
  } })
  const create = async (name, value) => {
    const response = fakeRes()
    await creationRoutes.registry(postReq(REGISTRY_ROUTE, { scope: USER_SCOPE, name, value, type: 'REG_SZ', createOnly: true }), response)
    return response
  }
  const duplicate = await create('eXISTING', 'bad')
  ok('registry creation rejects case-insensitive duplicates', duplicate.captured.status === 409 && json(duplicate).error === 'already-exists')
  ok('a duplicate registry create never writes or changes the value', writes === 0 && values.get('EXISTING').value === 'original')
  const created = await create('Fresh', '')
  ok('registry creation accepts a new empty string value', created.captured.status === 200 && values.get('FRESH').value === '')
  ok('new registry entries preserve the requested type', values.get('FRESH').type === 'REG_SZ')
  const race = await Promise.all([create('Race', 'first'), create('rACE', 'second')])
  ok('concurrent registry creates have one winner and one conflict', race.filter((response) => response.captured.status === 200).length === 1 && race.filter((response) => response.captured.status === 409).length === 1)
  ok('a losing registry create never replaces the winner', values.get('RACE').value === 'first' && writes === 2)
  readError = true
  const failed = await create('ReadFailure', 'x')
  ok('registry creation fails closed when the target cannot be read', failed.captured.status === 500 && json(failed).error === 'registry-read-failed' && writes === 2)
  readError = false
  const retry = await create('ReadFailure', 'recovered')
  ok('a failed creation does not poison the creation lock', retry.captured.status === 200 && values.get('READFAILURE').value === 'recovered')
}

rmSync(scratch, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
