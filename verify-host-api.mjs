/**
 * P4 验证：宿主 HTTP 面投影。
 *
 * 这一层真正的风险是**泄露与过量传输**：把整个环境原样回传会让一次响应
 * 几十 KB（`PATH` 一项就够了），而敏感名回传值等于把密钥送到浏览器。
 * 所以测试重点是"哪些东西**没有**被传出去"。
 *
 * 另外要证明路由注册走的是正确的 cordis 路径（`ctx.inject` 延迟激活 +
 * `ctx.effect` 释放），因为 P0 已经踩过"服务未激活就读取"的坑。
 *
 * 运行：node verify-host-api.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createHostApi,
  projectState,
  summarizeValue,
  runReg,
  STATE_ROUTE,
  HEALTH_ROUTE,
  CREDENTIAL_STATE_ROUTE,
} from './lib/host-api.js'
import { buildEnvironmentModel } from './lib/env-model.js'
import { OsEnvironmentLayer, USER_SCOPE, MACHINE_SCOPE, parseRegQuery, decodeRegOutput } from './lib/registry.js'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 假 req / res ────────────────────────────────────────────────────────────
/** 造一个能捕获响应的假 ServerResponse。 */
function fakeRes() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text
    },
  }
}

/** 造一个假 IncomingMessage。 */
function fakeReq(url, method = 'GET') {
  return { url, method }
}

// ── 1. 值摘要 ───────────────────────────────────────────────────────────────
console.log('--- value summarization ---')
{
  const short = summarizeValue('hello')
  ok('short value is not truncated', short.truncated === false && short.preview === 'hello', JSON.stringify(short))

  const long = 'x'.repeat(500)
  const summarized = summarizeValue(long)
  ok('long value is truncated', summarized.truncated === true)
  ok('long value reports true length', summarized.length === 500, String(summarized.length))
  ok('long value preview is much shorter', summarized.preview.length < 120, String(summarized.preview.length))
  ok('long value preview has an ellipsis', summarized.preview.includes('…'))

  // 关键：一个真实的 PATH 长度不应产生大响应
  const fakePath = Array.from({ length: 80 }, (_, i) => `C:\\tools\\dir${String(i)}`).join(';')
  const pathSummary = summarizeValue(fakePath)
  ok('a realistic PATH is summarized below 120 chars', pathSummary.preview.length < 120, String(pathSummary.preview.length))
  ok('PATH length is still reported', pathSummary.length === fakePath.length)
}

// ── 2. 投影：敏感值必须被抹掉 ───────────────────────────────────────────────
console.log('\n--- projection redaction ---')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-hostapi-'))
const projectDir = join(scratch, 'project')
const homeDir = join(scratch, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })
writeFileSync(join(projectDir, '.env'), 'MY_PLAIN_VAR="visible-value"\n')
writeFileSync(join(homeDir, '.env'), 'MY_TOKEN_SECRET="super-secret-token"\n')

const SECRET = 'super-secret-token'
const PLAIN = 'visible-value'

const model = buildEnvironmentModel({
  cwd: projectDir,
  home: homeDir,
  env: { PATH: '/usr/bin', PLAIN_ONLY: 'plain-env-value' },
})
const projected = projectState(model)

ok('model actually contains the secret', model.variables.find((v) => v.name === 'MY_TOKEN_SECRET') !== undefined)
ok(
  'projected state NEVER contains the secret value',
  !JSON.stringify(projected).includes(SECRET),
  'secret leaked into projection',
)
ok(
  'projected state still contains non-sensitive values',
  JSON.stringify(projected).includes(PLAIN),
  'plain value missing',
)
ok(
  'sensitive variable is flagged',
  projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.sensitive === true,
)
ok(
  'sensitive layer is marked redacted',
  projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]?.redacted === true,
)
ok(
  'redacted layer reports only the value length',
  projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]?.valueLength === SECRET.length,
  String(projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]?.valueLength),
)
ok(
  'redacted layer carries NO summary at all',
  projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]?.valueSummary === undefined,
  JSON.stringify(projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]),
)
ok(
  'redacted layer has no value key at all',
  !('value' in (projected.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0] ?? {})),
)

console.log('\n--- projection shape ---')
{
  ok('projection reports cwd', projected.cwd === projectDir, projected.cwd)
  ok('projection reports home', projected.home === homeDir, projected.home)
  ok('projection reports both env file paths', projected.files.project === join(projectDir, '.env') && projected.files.user === join(homeDir, '.env'))
  ok('counts.total matches variable count', projected.counts.total === projected.variables.length)
  ok('counts.sensitive counts the token', projected.counts.sensitive >= 1, String(projected.counts.sensitive))
  ok('PATH is flagged forbidden in projection', projected.variables.find((v) => v.name === 'PATH')?.forbidden === true)
  ok('DSH_* runtime flag survives projection', projected.variables.some((v) => v.runtimeManaged) === (model.variables.some((v) => v.runtimeManaged)))

  // reveal=0 不应包含任何值
  const noValues = projectState(model, { revealValues: false })
  ok('reveal=0 omits plain values', !JSON.stringify(noValues).includes(PLAIN))
  ok('reveal=0 keeps structure', noValues.variables.length === projected.variables.length)
  ok('reveal=0 still marks redaction', noValues.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]?.redacted === true)
}

// ── 2b. 显式放开敏感名（`revealSensitive`）───────────────────────────────────
// 这条路径**默认关闭**，且只能由调用方显式打开。所以这里的断言分两半：
// 默认仍然遮蔽（与上一节逐字节相同），以及打开后的形状。
console.log('\n--- opt-in reveal of sensitive names ---')
{
  /** 取某个变量在投影里的层；找不到就返回 undefined，让断言直接失败而不是抛错。 */
  const layerOf = (state, name, index = 0) => state.variables.find((v) => v.name === name)?.layers?.[index]

  const secretProjected = (state) => JSON.stringify(state).includes(SECRET)

  // (a) 显式传 false 必须与"什么都不传"逐字节相同 —— 这是"默认不变"的最强形式
  ok(
    'revealSensitive:false is byte-identical to the default',
    JSON.stringify(projectState(model, { revealSensitive: false })) === JSON.stringify(projected),
  )
  // 非布尔取值也必须留在遮蔽路径上（`=== true` 而不是真值判定）
  const truthyNonBoolean = projectState(model, { revealSensitive: 'true' })
  ok(
    'a truthy non-boolean revealSensitive still redacts',
    truthyNonBoolean.variables.find((v) => v.name === 'MY_TOKEN_SECRET')?.layers?.[0]?.redacted === true &&
      !JSON.stringify(truthyNonBoolean).includes(SECRET),
  )
  // 默认路径本身：遮蔽标记在，摘要不在（这一条与上一节重复是刻意的 ——
  // 它是本改动唯一不许回归的行为）
  const defaultSensitiveLayer = layerOf(projected, 'MY_TOKEN_SECRET')
  ok(
    'the default path still redacts with no summary',
    defaultSensitiveLayer?.redacted === true && defaultSensitiveLayer?.valueSummary === undefined,
    JSON.stringify(defaultSensitiveLayer),
  )

  // (b) 打开 + 有值 → 敏感层拿到 valueSummary，且**不再**标 redacted
  const opened = projectState(model, { revealSensitive: true })
  const openedLayer = layerOf(opened, 'MY_TOKEN_SECRET')
  ok(
    'revealSensitive:true sends a summary for a sensitive name',
    openedLayer?.valueSummary?.preview === SECRET,
    JSON.stringify(openedLayer),
  )
  ok('revealSensitive:true drops the redacted mark', openedLayer?.redacted === undefined)
  ok(
    'revealSensitive:true still carries no raw value key',
    !('value' in (openedLayer ?? {})),
    JSON.stringify(Object.keys(openedLayer ?? {})),
  )
  ok('the revealed secret appears exactly once in the payload', opened.variables.filter((v) => JSON.stringify(v).includes(SECRET)).length === 1)

  // (c) 打开 + reveal=0 → 只给长度。**摘要绝不能出现**，否则 reveal=0 就名不副实
  const openedNoValues = projectState(model, { revealSensitive: true, revealValues: false })
  const openedNoValuesLayer = layerOf(openedNoValues, 'MY_TOKEN_SECRET')
  ok(
    'revealSensitive:true + revealValues:false gives only the length',
    openedNoValuesLayer?.valueLength === SECRET.length,
    JSON.stringify(openedNoValuesLayer),
  )
  ok(
    'revealSensitive:true + revealValues:false carries NO summary',
    openedNoValuesLayer?.valueSummary === undefined,
    JSON.stringify(openedNoValuesLayer),
  )
  ok('revealSensitive + reveal=0 omits the secret text', !secretProjected(openedNoValues))
  ok(
    'revealSensitive + reveal=0 does not resurrect the redacted mark',
    openedNoValuesLayer?.redacted === undefined,
    JSON.stringify(openedNoValuesLayer),
  )

  // (d) 凭据域在**两种**模式下都必须完全没有值可给。
  //     它不是"不愿意给"，而是物理上没有承载值的字段：模型里根本不存在
  //     `credential` 层（`SOURCE_ORDER` 只含 process/project-env/user-env），
  //     所以任何投影里都不该出现这一层，也就没有任何字段能搭载密钥。
  const credentialLayersOf = (state) =>
    state.variables.flatMap((v) => v.layers.filter((l) => l.layer === 'credential'))
  ok('NO CREDENTIAL LAYER in the model', !model.variables.some((v) => v.layers.some((l) => l.layer === 'credential')))
  ok(
    'NO CREDENTIAL LAYER in either mode (default / revealed / revealed-without-values)',
    credentialLayersOf(projected).length === 0 &&
      credentialLayersOf(opened).length === 0 &&
      credentialLayersOf(openedNoValues).length === 0,
    [
      credentialLayersOf(projected).length,
      credentialLayersOf(opened).length,
      credentialLayersOf(openedNoValues).length,
    ].join('/'),
  )
  ok('the revealed payload still contains no credential secret', !secretProjected(openedNoValues))
}

// ── 3. 路由注册走 ctx.inject + ctx.effect ──────────────────────────────────
console.log('\n--- route registration path ---')
const registeredRoutes = []
const effectDisposers = []
const logLines = []

const fakeWebServer = {
  register(route) {
    registeredRoutes.push(route)
    return () => {
      registeredRoutes.splice(registeredRoutes.indexOf(route), 1)
    }
  },
}

const apiCtx = {
  inject(deps, callback) {
    ok('inject declares webServer', Array.isArray(deps) && deps.join(',') === 'webServer', JSON.stringify(deps))
    callback({ ...apiCtx, webServer: fakeWebServer })
    return { then: () => {} }
  },
  effect(fn) {
    const disposer = fn()
    effectDisposers.push(disposer)
    return disposer
  },
  webServer: fakeWebServer,
  logger: () => ({ info: (m) => logLines.push(m), warn: (m) => logLines.push(m) }),
  get: () => undefined,
}

const api = createHostApi({ ctx: apiCtx, guard: () => true })

/** 一个假的 OS 层，避免测试真的去起 reg.exe 进程。 */
const fakeOsLayer = {
  supported: true,
  async readAll() {
    return {
      [USER_SCOPE]: {
        scope: USER_SCOPE,
        entries: [
          { name: 'OS_ONLY_USER', type: 'REG_SZ', value: 'from-user-registry' },
          // PATH 同时存在于注册表与 process 层 —— 这正是 Windows 上最常见的
          // "注册表改了但没生效"场景，必须能被展示出来
          { name: 'PATH', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\user-bin' },
        ],
      },
      [MACHINE_SCOPE]: {
        scope: MACHINE_SCOPE,
        entries: [
          { name: 'OS_ONLY_MACHINE', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\sys' },
          { name: 'PATH', type: 'REG_EXPAND_SZ', value: '%SystemRoot%\\machine-bin' },
        ],
      },
    }
  },
}
const apiWithOs = createHostApi({ ctx: apiCtx, osLayer: fakeOsLayer, guard: () => true })

api.register()

ok('three routes registered', registeredRoutes.length === 3, String(registeredRoutes.length))
ok('state route path is correct', registeredRoutes.some((r) => r.path === STATE_ROUTE), registeredRoutes.map((r) => r.path).join(','))
ok('health route path is correct', registeredRoutes.some((r) => r.path === HEALTH_ROUTE))
ok('credential-state route path is correct', registeredRoutes.some((r) => r.path === CREDENTIAL_STATE_ROUTE))
ok('all routes are exact kind', registeredRoutes.every((r) => r.kind === 'exact'))
ok('all routes have handlers', registeredRoutes.every((r) => typeof r.handler === 'function'))
ok('registration is wrapped in ctx.effect', effectDisposers.length === 1 && typeof effectDisposers[0] === 'function')
ok('registration logged', logLines.some((l) => l.includes('routes registered')), logLines.join(' | '))

// 释放必须真的反注册
effectDisposers[0]()
ok('disposer removes every route', registeredRoutes.length === 0, String(registeredRoutes.length))

// ── 密钥状态路由 ────────────────────────────────────────────────────────────
{
  /** 造一个只注册路由的假 ctx，可指定凭据 provider。 */
  function makeCredCtx(credentials) {
    const routes = []
    const context = {
      credentials,
      logger: () => ({ info: () => {}, warn: () => {} }),
      get: () => undefined,
      effect: (f) => f(),
      inject: (_deps, callback) => {
        callback({ ...context, webServer: { register: (r) => { routes.push(r); return () => {} } } })
        return { then: () => {} }
      },
    }
    return { context, routes }
  }

  const calls = []
  const provider = {
    async describe(ref) {
      calls.push(ref)
      if (ref === 'SET_KEY') return { configured: true, source: 'file', writable: true }
      if (ref === 'SHADOWED_KEY') return { configured: true, source: 'env', writable: false }
      return { configured: false, writable: true }
    },
  }

  const { context, routes } = makeCredCtx(provider)
  createHostApi({ ctx: context, guard: () => true }).register()
  const credRoute = routes.find((r) => r.path === CREDENTIAL_STATE_ROUTE)
  ok('credential-state route is registered', credRoute !== undefined, routes.map((r) => r.path).join(','))

  const res = fakeRes()
  await credRoute.handler(fakeReq(`${CREDENTIAL_STATE_ROUTE}?refs=SET_KEY,SHADOWED_KEY,ABSENT_KEY`), res)
  const body = JSON.parse(res.captured.body)
  ok('credential-state returns 200', res.captured.status === 200)
  ok('credential-state reports availability', body.available === true)
  ok('credential-state covers every requested ref', Object.keys(body.refs).join(',') === 'SET_KEY,SHADOWED_KEY,ABSENT_KEY', Object.keys(body.refs).join(','))
  ok('configured key reports configured', body.refs.SET_KEY.configured === true)
  ok('configured key is editable', body.refs.SET_KEY.editable === true)
  ok('shadowed key is not editable', body.refs.SHADOWED_KEY.editable === false)
  ok('shadowed key explains why', String(body.refs.SHADOWED_KEY.blockedReason).includes('启动环境'), String(body.refs.SHADOWED_KEY.blockedReason))
  ok('absent key reports unconfigured', body.refs.ABSENT_KEY.configured === false)
  ok('NO VALUE FIELD ANYWHERE', !JSON.stringify(body).includes('"value"'), JSON.stringify(body))

  // 空 refs 不应炸
  const emptyRes = fakeRes()
  await credRoute.handler(fakeReq(CREDENTIAL_STATE_ROUTE), emptyRes)
  ok('empty refs yields an empty map', JSON.parse(emptyRes.captured.body).refs !== undefined, emptyRes.captured.body)

  // GET 之外的方法
  const methodRes = fakeRes()
  await credRoute.handler(fakeReq(CREDENTIAL_STATE_ROUTE, 'POST'), methodRes)
  ok('POST on credential-state yields 405', methodRes.captured.status === 405, String(methodRes.captured.status))

  // 凭据域缺失时必须回 available:false，而不是失败
  const missing = makeCredCtx(undefined)
  createHostApi({ ctx: missing.context, guard: () => true }).register()
  const missingRoute = missing.routes.find((r) => r.path === CREDENTIAL_STATE_ROUTE)
  const missingRes = fakeRes()
  await missingRoute.handler(fakeReq(`${CREDENTIAL_STATE_ROUTE}?refs=A`), missingRes)
  ok('absent credential domain reports available:false', JSON.parse(missingRes.captured.body).available === false, missingRes.captured.body)
  ok('absent credential domain returns 200, not an error', missingRes.captured.status === 200, String(missingRes.captured.status))
}

// ── 4. 处理器行为 ───────────────────────────────────────────────────────────
console.log('\n--- handler behaviour ---')
{
  // state：正常路径
  const res = fakeRes()
  await api.state(fakeReq(`${STATE_ROUTE}?cwd=${encodeURIComponent(projectDir)}`), res)
  ok('state returns 200', res.captured.status === 200, String(res.captured.status))
  ok('state content-type is JSON', String(res.captured.headers['content-type']).includes('application/json'))
  ok('state is not cached', res.captured.headers['cache-control'] === 'no-store')
  ok('state sets content-length', typeof res.captured.headers['content-length'] === 'number')

  const parsed = JSON.parse(res.captured.body)
  ok('state body parses as JSON', typeof parsed === 'object')
  ok('state body has variables', Array.isArray(parsed.variables) && parsed.variables.length > 0)
  ok('state body respects cwd query', parsed.cwd === projectDir, parsed.cwd)

  // 敏感值在**真实 HTTP 响应体**里也不能出现
  ok('HTTP response body contains no secret', !res.captured.body.includes(SECRET))
  ok('HTTP response body contains plain value', res.captured.body.includes(PLAIN))

  // reveal=0
  const res2 = fakeRes()
  await api.state(fakeReq(`${STATE_ROUTE}?reveal=0&cwd=${encodeURIComponent(projectDir)}`), res2)
  ok('reveal=0 returns 200', res2.captured.status === 200)
  ok('reveal=0 body omits plain values', !res2.captured.body.includes(PLAIN))

  // ── reveal 查询参数：`all` 是"含敏感名"，且只认字面量 ────────────────────
  // 默认（缺省 / `1`）与 `reveal=0` 的含义一个字都没变；多出来的只有 `all`。
  // 关键是**拼错不能升级成 all** —— 那等于一个 typo 就把密钥发出去。
  //
  // 这一段用**独立的** api + 假 OS 层：敏感名从假注册表来，既不改动上面那些
  // 断言的响应，也不依赖临时目录里的 `.env`（projectDir 里刻意没有敏感名）。
  const ROUTE_SECRET = 'sk-route-level-secret-value'
  const routeOsLayer = {
    supported: true,
    async readAll() {
      return {
        [USER_SCOPE]: { scope: USER_SCOPE, entries: [{ name: 'ROUTE_TOKEN_SECRET', type: 'REG_SZ', value: ROUTE_SECRET }] },
        [MACHINE_SCOPE]: { scope: MACHINE_SCOPE, entries: [] },
      }
    },
  }
  const revealApi = createHostApi({ ctx: apiCtx, osLayer: routeOsLayer, guard: () => true })
  const callState = async (query) => {
    const res = fakeRes()
    await revealApi.state(fakeReq(`${STATE_ROUTE}?${query}`), res)
    // 返回的是 `captured` 而不是 `res`：断言直接读 status/headers/body，
    // 与上面几节 `.captured.status` 的写法等价，但少一层噪音。
    return res.captured
  }
  const sensitiveLayerOf = (captured) =>
    JSON.parse(captured.body).variables.find((v) => v.name === 'ROUTE_TOKEN_SECRET')?.layers?.[0]

  const plainRoute = await callState('')
  const allRoute = await callState('reveal=all')
  ok(
    'the route fixture really carries a sensitive registry variable',
    sensitiveLayerOf(plainRoute) !== undefined,
    JSON.stringify(sensitiveLayerOf(plainRoute)),
  )
  ok('the default route response redacts the sensitive name', sensitiveLayerOf(plainRoute)?.valueSummary === undefined)
  ok('the default route response keeps the sensitive length', sensitiveLayerOf(plainRoute)?.valueLength === ROUTE_SECRET.length)
  ok(
    'reveal=all returns 200',
    allRoute.status === 200,
    String(allRoute.status),
  )
  ok(
    'reveal=all sends a summary for the sensitive name',
    sensitiveLayerOf(allRoute)?.valueSummary?.preview === ROUTE_SECRET,
    JSON.stringify(sensitiveLayerOf(allRoute)),
  )
  ok('reveal=all drops the redacted mark', sensitiveLayerOf(plainRoute)?.redacted === true && sensitiveLayerOf(allRoute)?.redacted === undefined)

  // 严格性：只有字面量 `all` 才算 all。下面每一个都必须是"默认"，不是 all。
  for (const bogus of ['1', 'yes-please', 'all ', 'ALL', 'al', 'true', '2', 'on', '']) {
    const bogusLayer = sensitiveLayerOf(await callState(`reveal=${encodeURIComponent(bogus)}`))
    ok(
      `reveal=${JSON.stringify(bogus)} is treated as the default, not all`,
      bogusLayer?.valueSummary === undefined && bogusLayer?.valueLength === ROUTE_SECRET.length,
      JSON.stringify(bogusLayer),
    )
  }

  // `reveal=0` 与 `reveal=0&reveal=all` 都不许出现值：后者证明 `all` 不能把
  // `reveal=0` 的"连摘要都不给"改掉（`URLSearchParams` 取第一个值）。
  for (const query of ['reveal=0', 'reveal=0&reveal=all']) {
    const zeroRoute = await callState(query)
    const zeroLayer = sensitiveLayerOf(zeroRoute)
    ok(
      `${query} yields length only, no summary`,
      zeroLayer?.valueSummary === undefined && zeroLayer?.valueLength === ROUTE_SECRET.length,
      JSON.stringify(zeroLayer),
    )
    ok(`${query} never puts the secret on the wire`, !zeroRoute.body.includes(ROUTE_SECRET))
  }

  // 缺省必须与 `reveal=1` **逐字节相同**（`all` 是唯一的增量）
  ok('an absent reveal is byte-identical to reveal=1', plainRoute.body === (await callState('reveal=1')).body)

  // 方式限制
  const res3 = fakeRes()
  await api.state(fakeReq(STATE_ROUTE, 'POST'), res3)
  ok('POST is rejected with 405', res3.captured.status === 405, String(res3.captured.status))
  ok('405 advertises allowed methods', res3.captured.headers.allow === 'GET, HEAD', String(res3.captured.headers.allow))

  // health
  const res4 = fakeRes()
  api.health(fakeReq(HEALTH_ROUTE), res4)
  ok('health returns 200', res4.captured.status === 200)
  const health = JSON.parse(res4.captured.body)
  ok('health reports ok', health.ok === true)
  ok('health reports the pid', health.pid === process.pid)
  ok('health reports uptime', typeof health.uptimeSeconds === 'number')
  ok('health lists the routes it serves', Array.isArray(health.routes) && health.routes.includes(STATE_ROUTE), JSON.stringify(health.routes))
  // 健康响应刻意**不**报告凭据可用性：读 ctx.credentials 需要插件级 inject，
  // 在 HTTP 处理函数里探测会抛错（实测）。凭据可用性由启动时的一次探测记录。

  // 错误路径必须回可达的诊断，而不是空的 400
  const brokenRes = fakeRes()
  await api.state(fakeReq(`${STATE_ROUTE}?cwd=${encodeURIComponent('\u0000invalid\u0000')}`), brokenRes)
  const brokenParsed = brokenRes.captured.body === undefined ? undefined : JSON.parse(brokenRes.captured.body)
  ok(
    'a failing request yields a structured error or a valid 200',
    brokenRes.captured.status === 200 || (brokenParsed !== undefined && typeof brokenParsed.message === 'string'),
    `status=${String(brokenRes.captured.status)} body=${String(brokenRes.captured.body).slice(0, 80)}`,
  )
}

// ── 5. 读路由的请求策略闸门 ─────────────────────────────────────────────────
// `/state` 会回传完整环境结构（含敏感名与长度），`/credential-state` 会回传
// 密钥的存在性 —— 都不该让跨站页面读到。所以读路由与写路由共用同一道闸门。
console.log('\n--- read routes are gated too ---')
{
  const denyingGuard = (_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'untrusted-origin' }))
    return false
  }

  const gatedRoutes = []
  const gatedCtx = {
    ...apiCtx,
    inject: (_d, cb) => {
      cb({ ...apiCtx, webServer: { register: (r) => { gatedRoutes.push(r); return () => {} } } })
      return { then: () => {} }
    },
  }
  createHostApi({ ctx: gatedCtx, guard: denyingGuard }).register()

  for (const path of [STATE_ROUTE, HEALTH_ROUTE, CREDENTIAL_STATE_ROUTE]) {
    const route = gatedRoutes.find((r) => r.path === path)
    const res = fakeRes()
    await route.handler(fakeReq(path), res)
    ok(`guard gates ${path}`, res.captured.status === 403, `status=${String(res.captured.status)}`)
  }
}

// ── 7. runReg：真实的 reg.exe 执行器 ────────────────────────────────────────
// 这是唯一直接驱动 `reg.exe` 的导出，必须证明它返回**原始字节**且不抛错 ——
// `decodeRegOutput` 依赖 Buffer 输入（控制台代码页不能当 UTF-8 处理）。
console.log('\n--- runReg ---')
if (process.platform !== 'win32') {
  console.log('SKIP  非 Windows 平台')
} else {
  let buffer
  let threw
  try {
    buffer = await runReg(['query', 'HKCU\\Environment'])
  } catch (error) {
    threw = error
  }
  ok('runReg resolves without throwing', threw === undefined, String(threw))
  ok('runReg returns a Buffer (raw bytes, not a decoded string)', Buffer.isBuffer(buffer), buffer?.constructor?.name)
  ok('the buffer has content', (buffer?.length ?? 0) > 0, String(buffer?.length))
  ok('the content names the queried key', buffer.toString('utf8').includes('Environment'))

  // 与 decodeRegOutput 串起来，复现真实的读取链路
  const parsed = parseRegQuery(decodeRegOutput(buffer), 'HKCU\\Environment')
  ok('runReg + decodeRegOutput + parseRegQuery yields entries', parsed.length > 0, String(parsed.length))

  // 不存在的键必须抛（而不是静默返回空）
  let missingThrew
  try {
    await runReg(['query', 'HKCU\\DefinitelyNotAKey_' + String(Date.now())])
  } catch (error) {
    missingThrew = error
  }
  ok('runReg rejects for a nonexistent key', missingThrew !== undefined, String(missingThrew?.code ?? missingThrew))
}

// ── 8. OS 层并入响应 ────────────────────────────────────────────────────────
console.log('\n--- OS layer integration ---')
{
  // os=0 必须跳过注册表读取（读 HKLM 要起进程）
  const skipped = fakeRes()
  await apiWithOs.state(fakeReq(`${STATE_ROUTE}?os=0&cwd=${encodeURIComponent(projectDir)}`), skipped)
  const skippedBody = JSON.parse(skipped.captured.body)
  ok('os=0 returns 200', skipped.captured.status === 200)
  ok('os=0 reports skipped', skippedBody.os?.skipped === true, JSON.stringify(skippedBody.os))
  ok('os=0 omits registry-only variables', !skipped.captured.body.includes('OS_ONLY_USER'))

  // os=1（默认）必须并入两个作用域
  const withOs = fakeRes()
  await apiWithOs.state(fakeReq(`${STATE_ROUTE}?cwd=${encodeURIComponent(projectDir)}`), withOs)
  const body = JSON.parse(withOs.captured.body)
  ok('default includes OS layers', body.os?.skipped === undefined)
  ok('os status reports support', body.os?.supported === true, JSON.stringify(body.os))
  ok('os status reports per-scope counts', body.os?.scopes?.[USER_SCOPE]?.count === 2, JSON.stringify(body.os?.scopes))

  const userVar = body.variables.find((v) => v.name === 'OS_ONLY_USER')
  const machineVar = body.variables.find((v) => v.name === 'OS_ONLY_MACHINE')
  ok('user-scope registry variable is present', userVar !== undefined)
  ok('machine-scope registry variable is present', machineVar !== undefined)
  ok('user-scope variable effective layer is os-user', userVar?.effective === 'os-user', String(userVar?.effective))
  ok('machine-scope variable effective layer is os-machine', machineVar?.effective === 'os-machine', String(machineVar?.effective))
  ok('registry type is transported', userVar?.layers?.[0]?.registryType === 'REG_SZ', String(userVar?.layers?.[0]?.registryType))
  ok(
    'REG_EXPAND_SZ type is transported for the machine scope',
    machineVar?.layers?.[0]?.registryType === 'REG_EXPAND_SZ',
    String(machineVar?.layers?.[0]?.registryType),
  )
  ok('machine-scope layer is flagged as needing elevation', machineVar?.layers?.[0]?.requiresElevation === true)
  ok('user-scope layer is not flagged for elevation', userVar?.layers?.[0]?.requiresElevation === undefined)

  // 关键语义：注册表的值被 process 层遮蔽时，生效层必须是 process。
  // 注意 Windows 上注册表里这个变量叫 `Path`（首字母大写），所以查找必须
  // 大小写无关 —— 用 `=== 'PATH'` 会找不到，这个坑我踩过一次。
  const pathVar = body.variables.find((v) => v.name.toUpperCase() === 'PATH')
  ok('PATH is present after merging OS layers', pathVar !== undefined, String(pathVar?.name))
  ok('PATH effective layer stays process even with registry layers merged', pathVar?.effective === 'process', String(pathVar?.effective))
  ok('PATH shows all three competing layers', pathVar?.layerCount === 3, String(pathVar?.layerCount))
  ok('PATH is marked shadowed', pathVar?.shadowed === true)
  ok(
    'PATH layers are ordered process > os-user > os-machine',
    pathVar?.layers.map((l) => l.layer).join(',') === 'process,os-user,os-machine',
    pathVar?.layers.map((l) => l.layer).join(','),
  )

  // OS 层读取失败必须被转述，而不是让整个响应失败
  const failingOs = {
    supported: true,
    async readAll() {
      throw new Error('reg.exe exploded')
    },
  }
  const failingApi = createHostApi({ ctx: apiCtx, osLayer: failingOs, guard: () => true })
  const failRes = fakeRes()
  await failingApi.state(fakeReq(`${STATE_ROUTE}?cwd=${encodeURIComponent(projectDir)}`), failRes)
  const failBody = failRes.captured.body === undefined ? undefined : JSON.parse(failRes.captured.body)
  ok(
    'an OS-layer failure yields a structured 500, not an empty 400',
    failRes.captured.status === 500 && typeof failBody?.message === 'string',
    `status=${String(failRes.captured.status)} body=${String(failRes.captured.body).slice(0, 90)}`,
  )
}

rmSync(scratch, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
