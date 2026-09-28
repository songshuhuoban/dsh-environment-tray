/**
 * 宿主 API —— 把复合环境模型投影成一个**适合经 HTTP 传输**的视图。
 *
 * 三个刻意的约束：
 *
 *  1. **不原样回传整个环境。** 否则一次响应几十 KB，绝大部分是 `PATH` 这种
 *     既长又无展示价值的值。默认只给长度与前后缀摘要，客户端要详情再单取。
 *  2. **敏感名默认不给值。** 名字命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 的条目，
 *     只报"已配置"与来源 —— 与 `dsh-subprocess` 的 `scrubbedParentEnv`
 *     用同一条规则，也与凭据域的掩码约定一致。
 *  3. **错误要能到达客户端。** `dsh-host-webserver` 对抛出异常的处理器回
 *     一个空的 400，所以这里自己捕获并回结构化错误，让 UI 能说明原因。
 *
 * @module dsh-environment-tray/host-api
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { buildEnvironmentModel, BLOCKED_REASON_TEXT } from './env-model'
import { credentialAccessOf, isPossibleRef } from './credentials'
import { readDotEnvFile } from './env-write'
import { mergeOsLayers, OsEnvironmentLayer, USER_SCOPE, MACHINE_SCOPE } from './registry'
import { createRequestGuard, readJsonBody, resolveLayerPath, CREDENTIAL_ROUTE, ENV_ROUTE, REGISTRY_ROUTE } from './write-routes'

import type { OsScopeReads } from './registry'
import type { WriteRouteHandlers } from './write-routes'
import type {
  ConnectionService,
  CredentialProvider,
  EnvLayerId,
  EnvParseWarning,
  EnvironmentModel,
  IncomingRequest,
  Logger,
  ServerResponse,
  WebServerService,
} from './types'

const execFileAsync = promisify(execFile)

/* ────────────────────────── 传输视图（响应体的形状）────────────────────────── */

/** 值摘要（`summarizeValue()` 的结果）。 */
export interface ValueSummary {
  /** 展示用文本；长值只给首尾片段。 */
  preview: string
  /** **真实**长度（不是 `preview` 的长度）。 */
  length: number
  truncated: boolean
}

/**
 * 传输视图里的一个层。
 *
 * ⚠️ `redacted` 与 `valueSummary` **互斥**，这是安全约束而不是风格问题：
 * 默认路径下敏感名的层只允许带 `valueLength`，任何能还原出值的字段都不许出现
 * （见 `projectState()`；verify-host-api.mjs 有 "NO VALUE FIELD" 断言守着）。
 * 唯一的例外是调用方显式传入 `revealSensitive: true` —— 那时该层走普通分支，
 * `redacted` 与 `valueSummary` 依然不会同时出现。
 */
export interface ProjectedLayer {
  layer: EnvLayerId | string
  writable: boolean
  /** 值的来源文件绝对路径。 */
  path?: string
  /** 不可写的机器可读原因码；文案由客户端查 `blockedReasonText`。 */
  blockedCode?: string
  /** 注册表原始类型；`REG_EXPAND_SZ` 必须原样带回。 */
  registryType?: string
  /** 写系统级注册表需要提权。 */
  requiresElevation?: true
  /** 敏感名标记：值为敏感名且未被显式放开时只有长度，绝无值。 */
  redacted?: true
  /** 值的长度（敏感名与 `reveal=0` 时只有它）。 */
  valueLength?: number
  /**
   * 值摘要；敏感名**只有**在 `revealSensitive` 显式打开时才会有它
   * （见 `projectState()` 的信任论证）。
   */
  valueSummary?: ValueSummary
}

/** 传输视图里的一个变量。 */
export interface ProjectedVariable {
  name: string
  effective?: EnvLayerId | string
  shadowed: boolean
  forbidden: boolean
  sensitive: boolean
  runtimeManaged: boolean
  /** 该变量的层数：>1 表示存在遮蔽竞争。 */
  layerCount: number
  layers: ProjectedLayer[]
}

/** 单个作用域的读取状态。 */
export interface OsScopeStatus {
  /** 失败原因；成功时为 null（客户端按 `null` 判断"这一层没问题"）。 */
  error: string | null
  count: number
}

/** 逐作用域的状态；键与 `USER_SCOPE` / `MACHINE_SCOPE` 一致。 */
export type OsScopeStatuses = Record<typeof USER_SCOPE | typeof MACHINE_SCOPE, OsScopeStatus>

/** OS 环境层的状态（由 `/state` 处理器附上）。 */
export interface OsStatus {
  supported: boolean
  /** `os=0`：本次刻意跳过了注册表读取。 */
  skipped?: true
  /** 读取过注册表时才有。 */
  scopes?: OsScopeStatuses
}

/** `projectState()` 的结果 —— `/state` 的响应体。 */
export interface ProjectedState {
  cwd: string
  home: string
  files: { project: string | null; user: string | null }
  warnings: EnvParseWarning[]
  blockedReasonText: typeof BLOCKED_REASON_TEXT
  counts: {
    total: number
    shadowed: number
    forbidden: number
    sensitive: number
    runtimeManaged: number
  }
  variables: ProjectedVariable[]
  /** OS 层状态；只有 `/state` 处理器会补上它。 */
  os?: OsStatus
}

/** `projectState()` 的选项。 */
export interface ProjectStateOptions {
  /**
   * 是否包含值。默认 true；敏感名另由 {@link ProjectStateOptions.revealSensitive} 决定。
   */
  revealValues?: boolean
  /**
   * 是否**也**给名字看起来敏感的条目发值。默认 **false**（与旧行为逐字节相同）。
   *
   * 打开后敏感名走普通条目的处理分支：`revealValues` 为 true 时给 `valueSummary`，
   * 为 false 时只给 `valueLength` —— 即 "`reveal=0` 绝不携带摘要" 这条不变式
   * 不受本选项影响。
   *
   * 这是一道**用户显式打开**的开关，不是默认放宽：默认路径下敏感名仍然只回长度。
   * 信任论证见 `projectState()` 里的展开说明。
   */
  revealSensitive?: boolean
}

/**
 * 真实的 `reg.exe` 执行器。
 *
 * 刻意用 `execFile` 而不是 shell：参数数组不会被 shell 解释，变量名里的特殊
 * 字符不会被注入。返回值必须是 **Buffer**（原始字节），因为 `reg.exe` 写的是
 * 控制台代码页而非 UTF-8。
 *
 * @param args - `reg.exe` 参数。
 * @returns stdout 原始字节。
 */
export async function runReg(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('reg.exe', args, {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer',
  })
  // `encoding: 'buffer'` 时 Node 保证 stdout 是 Buffer，但 `promisify()` 的
  // CustomPromisify 只按 `execFile.__promisify__` 的**最后一个重载**推导类型
  // （`string | Buffer`），所以这里显式断言。这一条由 verify-host-api.mjs 的
  // `Buffer.isBuffer(buffer)` 守着。
  return stdout as Buffer
}

/** 值的展示上限：超过就摘要化。 */
const VALUE_PREVIEW_LIMIT = 120

/** 路由路径。命名成 `/api/` 前缀以贴合 Web 端的既有约定。 */
export const STATE_ROUTE = '/api/env-manager/state'

/** 探活路由。 */
export const HEALTH_ROUTE = '/api/env-manager/health'

/** 密钥状态路由（只报"是否已配置"，永不回值）。 */
export const CREDENTIAL_STATE_ROUTE = '/api/env-manager/credential-state'
export const VALUE_ROUTE = '/api/env-manager/value'

/**
 * 摘要素值以便展示。
 *
 * 长值（例如 `PATH`）只给长度与首尾片段 —— 它们的信息量在结构而不在全文。
 *
 * @param value - 原始值。
 * @returns 展示视图 `{ preview, length, truncated }`。
 */
export function summarizeValue(value: unknown): ValueSummary {
  const text = String(value)
  if (text.length <= VALUE_PREVIEW_LIMIT) {
    return { preview: text, length: text.length, truncated: false }
  }
  const head = text.slice(0, 60)
  const tail = text.slice(-30)
  return { preview: `${head}…${tail}`, length: text.length, truncated: true }
}

/**
 * 把复合模型投影成传输视图。
 *
 * @param model - `buildEnvironmentModel()` 的结果。
 * @param options - 投影选项。
 * @param options.revealValues - 是否包含值。默认 true。
 * @param options.revealSensitive - 是否连敏感名的值一起给。默认 false。
 * @returns 可 JSON 序列化的视图。
 */
export function projectState(model: EnvironmentModel, options: ProjectStateOptions = {}): ProjectedState {
  const revealValues = options.revealValues !== false
  /**
   * 严格布尔化：`options.revealSensitive` 的公开类型已是 `boolean`，但宿主
   * 里同一份选项可能在未类型化的边界被拼出来（见 `/state` 解析 `reveal` 的
   * 那条注释）。用 `=== true` 而不是真值判断，保证任何非 true 的取值 ——
   * 包括 `"true"`、`1`、`undefined` —— 都留在默认的遮蔽路径上。
   */
  const revealSensitive = options.revealSensitive === true

  const variables: ProjectedVariable[] = model.variables.map((variable) => ({
    name: variable.name,
    effective: variable.effective,
    shadowed: variable.shadowed,
    forbidden: variable.forbidden,
    sensitive: variable.sensitive,
    runtimeManaged: variable.runtimeManaged,
    /** 该变量的层数：>1 表示存在遮蔽竞争。 */
    layerCount: variable.layers.length,
    layers: variable.layers.map((layer): ProjectedLayer => {
      const entry: ProjectedLayer = {
        layer: layer.layer,
        writable: layer.writable,
        ...layer.path === undefined ? {} : { path: layer.path },
        // 只传机器可读码；文案由客户端从 BLOCKED_REASON_TEXT 取。
        // 传输 101 份重复的中文说明会白白多出 ~25 KB（实测过）。
        ...layer.blockedCode === undefined ? {} : { blockedCode: layer.blockedCode },
        // OS 层特有：注册表原始类型必须保留（REG_EXPAND_SZ 含 %VAR% 引用）
        ...layer.registryType === undefined ? {} : { registryType: layer.registryType },
        ...layer.requiresElevation === true ? { requiresElevation: true } : {},
      }

      if (variable.sensitive && !revealSensitive) {
        // 默认路径，**逐字节与从前一致**。
        //
        // 敏感名**只回长度**。绝不能回摘要 —— 摘要里就是真实值的前 60 字符，
        // 那等于把密钥送到浏览器。（这个漏洞是被 verify-host-api.mjs 抓出来的：
        // 先前版本标了 redacted 却仍附带 valueSummary。）
        //
        // ── 放开这条遮蔽的信任论证（`revealSensitive: true`）────────────────
        //
        // 前提是**用户在 UI 里显式打开**那个开关；默认 false 就是本分支。
        //
        // 打开后，本路由能读到的值，同一个调用方本来就能经本插件自己的写路由
        // **改写**：`POST /api/env-manager/env` 写 `.env`、
        // `POST /api/env-manager/credentials` 写凭据库。而所有这些路由都注册在
        // 同一道闸门后面 —— `connection.requestRejection`（Host/Origin 栅栏
        // 挡 DNS rebinding 与跨站请求，之后还有浏览器会话认证）。所以
        // "未通过闸门的调用方读不到" 这一条没有被削弱：闸门是路由级的，
        // 与是否放开敏感名无关。
        //
        // 于是泄露面的增量是零：值在传输前多经过一道"能不能覆盖它"的检查，
        // 而能覆盖它的人本来就能把它设成任意值。换句话说，
        // **"已认证的本地 UI 可以读回一个它已经能覆盖的值"** 就是本插件既有的
        // 威胁模型；这里只是把这条既有事实延伸到读回。
        //
        // 唯一刻意留成不透明的是**凭据域**：它不是"不愿意给"，而是物理上没有
        // 可给的东西 —— `EnvLayerValue` 里的 `credential` 层根本不存在（见
        // `SOURCE_ORDER` 只含 process/project-env/user-env），
        // `CredentialProvider` 刻意不声明 `resolve`，`CredentialInfo` 与
        // `CredentialView` 也都没有可以搭载值的字段。所以 `reveal=all`
        // 对凭据域不会、也不能有任何影响。
        entry.redacted = true
        if (layer.value !== undefined) entry.valueLength = String(layer.value).length
        return entry
      }

      if (layer.value === undefined) return entry

      if (revealValues) {
        entry.valueSummary = summarizeValue(layer.value)
      } else {
        // reveal=0 严格表示"不要值"：连摘要都不给，只给长度
        entry.valueLength = String(layer.value).length
      }
      return entry
    }),
  }))

  return {
    cwd: model.cwd,
    home: model.home,
    files: {
      project: model.projectFile?.path ?? null,
      user: model.userFile?.path ?? null,
    },
    /**
     * 解析诊断（当前只有 BOM）。UI **必须**显示它们：
     * 带 BOM 的文件里第一个变量名对 DSH 而言与界面显示的不同，静默处理等于隐瞒。
     */
    warnings: model.warnings ?? [],
    /** 文案表：与层里的 `blockedCode` 配合使用，只传一次而不是每行一份。 */
    blockedReasonText: BLOCKED_REASON_TEXT,
    counts: {
      total: variables.length,
      shadowed: variables.filter((v) => v.shadowed).length,
      forbidden: variables.filter((v) => v.forbidden).length,
      sensitive: variables.filter((v) => v.sensitive).length,
      runtimeManaged: variables.filter((v) => v.runtimeManaged).length,
    },
    variables,
  }
}

/**
 * `ctx.inject([...], cb)` 回调拿到的子上下文（本模块只用到这两项）。
 *
 * 刻意**不**复用 `PluginContext`：那里的 `webServer` / `effect` 是可选的，
 * 而在 `inject(['webServer'], …)` 的回调里它们由 cordis 保证存在。用可选类型
 * 会逼着处理器写 `?.`，那等于把"注册失败"从抛错悄悄变成静默跳过。
 */
export interface HostApiScope {
  /** 由 `inject(['webServer'], …)` 保证存在。 */
  webServer: WebServerService
  /** 注册释放函数；cordis 在插件卸载时调用它。 */
  effect(fn: () => () => void): unknown
}

/**
 * 本模块用到的 cordis 上下文最小接口。
 *
 * 只声明实际访问到的成员（不 import 宿主包的完整 `Context`，避免绑死版本）。
 * `types.ts` 的 `PluginContext` 结构上满足它 —— `index.ts` 的
 * `createHostApi({ ctx })` 就是拿 `PluginContext` 调进来的，由类型检查保证。
 */
export interface HostApiContext {
  credentials?: CredentialProvider | undefined
  connection?: ConnectionService | undefined
  get?(name: string): unknown
  /** `ctx.logger('env-manager')`；任何一级缺失都必须能安全跳过。 */
  logger?(name: string): Logger | undefined
  /** 延迟激活；见 `register()` 的说明。 */
  inject?(deps: string[], callback: (scope: HostApiScope) => void): unknown
}

/** 本模块用到的 OS 环境层最小接口（只读面）。真实实现见 `./registry`。 */
export interface OsReadLayerPort {
  readonly supported: boolean
  readAll(): Promise<OsScopeReads>
}

/** 请求策略闸门，与 `createRequestGuard()` 的返回形状一致。 */
export type RequestGuard = (req: IncomingRequest, res: ServerResponse) => boolean

/** `createHostApi()` 的依赖。 */
export interface HostApiOptions {
  /** cordis 上下文。 */
  ctx: HostApiContext
  /** OS 环境层适配器；默认用真实 `reg.exe`。 */
  osLayer?: OsReadLayerPort
  /** 覆盖闸门（测试注入用）。 */
  guard?: RequestGuard
  /** 覆盖 `ctx.connection`（测试注入用）。 */
  connection?: ConnectionService | undefined
}

/** 宿主 API：列表、逐项读取与路由注册。 */
export interface HostApi {
  value(req: IncomingRequest, res: ServerResponse): Promise<void>
  /** GET /api/env-manager/state —— 复合模型视图。 */
  state(req: IncomingRequest, res: ServerResponse): Promise<void>
  /** GET /api/env-manager/credential-state —— 密钥状态（只报"是否已配置"）。 */
  credentialState(req: IncomingRequest, res: ServerResponse): Promise<void>
  /** GET /api/env-manager/health —— 轻量探活。 */
  health(req: IncomingRequest, res: ServerResponse): void
  /** 注册读路由。 */
  register(): unknown
  /** 注册写路由。 */
  registerWriteRoutes(writeRoutes: WriteRouteHandlers): unknown
}

/**
 * 构造宿主 API 处理器集合。
 *
 * @param options - 依赖。
 * @param options.ctx - cordis 上下文。
 * @param options.osLayer - OS 环境层适配器；默认用真实 `reg.exe`。
 * @returns 路由处理器与注册函数。
 */
export function createHostApi(options: HostApiOptions): HostApi {
  const { ctx } = options
  const osLayer = options.osLayer ?? new OsEnvironmentLayer({ run: runReg })

  // 读路由同样要过请求策略闸门：`/state` 会回传完整环境结构（含敏感名与其
  // 长度），`/credential-state` 会回传密钥的存在性 —— 都不该让跨站页面读到。
  const guard =
    options.guard ?? createRequestGuard({ connection: options.connection ?? ctx.connection })

  /** 从查询串取工作目录；未指定则用进程 cwd。 */
  const cwdOf = (req: IncomingRequest): string => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return url.searchParams.get('cwd') ?? process.cwd()
    } catch {
      return process.cwd()
    }
  }

  /** 只接受 GET/HEAD；其余明确回 405，而不是让处理器假装成功。 */
  const requireGet = (req: IncomingRequest, res: ServerResponse): boolean => {
    if (req.method === 'GET' || req.method === 'HEAD') return true
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return false
  }

  return {
    /** 完整值只按用户选中的名称和层读取，不进入列表响应。 */
    async value(req, res) {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      try {
        const body = await readJsonBody(req)
        if (typeof body.name !== 'string' || body.name.length === 0 || body.name.includes('\0')) {
          writeJson(res, 400, { ok: false, error: 'invalid-name', message: '变量名无效' })
          return
        }
        let value: string | undefined
        let revision: string | undefined
        const equal = (name: string) => process.platform === 'win32'
          ? name.toUpperCase() === (body.name as string).toUpperCase()
          : name === body.name
        if (body.layer === 'credential') {
          if (!isPossibleRef(body.name)) {
            writeJson(res, 400, { ok: false, error: 'invalid-ref', message: '凭据名称无效' })
            return
          }
          if (!ctx.credentials?.resolve) {
            writeJson(res, 501, { ok: false, error: 'credentials-unavailable', message: '无法读取凭据' })
            return
          }
          value = (await ctx.credentials.resolve(body.name))?.value
        } else if (body.layer === 'project-env' || body.layer === 'user-env') {
          const cwd = cwdOf(req)
          const model = buildEnvironmentModel({ cwd })
          const file = await readDotEnvFile(resolveLayerPath(body.layer, cwd, model.home))
          const name = Object.keys(file.values).find(equal)
          value = name === undefined ? undefined : file.values[name]
          revision = file.revision
        } else if (body.layer === 'process') {
          const name = Object.keys(process.env).find(equal)
          value = name === undefined ? undefined : process.env[name]
        } else if (body.layer === USER_SCOPE || body.layer === MACHINE_SCOPE) {
          const layers = await osLayer.readAll()
          const scope = layers[body.layer]
          if (scope.error) throw new Error('无法读取注册表')
          value = scope.entries.find((entry) => equal(entry.name))?.value
        } else {
          writeJson(res, 400, { ok: false, error: 'invalid-layer', message: '环境层无效' })
          return
        }
        if (value === undefined) {
          writeJson(res, 404, { ok: false, error: 'value-missing', message: '值已不存在' })
          return
        }
        writeJson(res, 200, { ok: true, value, ...(revision === undefined ? {} : { revision }) })
      } catch {
        // 原始 provider / parser 错误可能包含值，逐项读取时只给固定错误。
        writeJson(res, 500, { ok: false, error: 'read-failed', message: '读取失败' })
      }
    },
    /** GET /api/env-manager/state —— 复合模型视图。 */
    async state(req, res) {
      if (!guard(req, res)) return
      if (!requireGet(req, res)) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        /**
         * `reveal` 的三个取值，**白名单匹配而不是前缀/宽松匹配**：
         *
         *   - `0`   —— 只要结构不要值（用于先渲染骨架），连摘要都不给
         *   - `all` —— 值**含**敏感名（用户在 UI 里显式打开的开关）
         *   - 其余（含缺省、`1`、以及任何拼错的串）—— 默认：给值，但敏感名仍遮蔽
         *
         * 拼错必须落到默认而不是 `all`。宽松解析（`startsWith('a')`、
         * 真值判定、`!== '0'` 之类的取反）会把 `reveal=al`、`reveal=ALL`、
         * `reveal=true` 静默升级成"把密钥发出去" —— 一个 typo 就是一次泄露。
         * 所以这里写成显式的 `=== 'all'`，且只在**没有**其他解释时才生效。
         */
        const revealParam = url.searchParams.get('reveal')
        const reveal = revealParam !== '0'
        const revealSensitive = revealParam === 'all'
        // `os=0` 跳过注册表读取：读 HKLM 要起一次进程，客户端可以先不要这层
        const includeOs = url.searchParams.get('os') !== '0'

        const model = buildEnvironmentModel({ cwd: cwdOf(req) })

        let osStatus: OsStatus
        if (includeOs) {
          const osLayers = await osLayer.readAll()
          model.variables = mergeOsLayers(model, osLayers)
          osStatus = {
            supported: osLayer.supported,
            scopes: {
              [USER_SCOPE]: { error: osLayers[USER_SCOPE].error ?? null, count: osLayers[USER_SCOPE].entries.length },
              [MACHINE_SCOPE]: { error: osLayers[MACHINE_SCOPE].error ?? null, count: osLayers[MACHINE_SCOPE].entries.length },
            },
          }
        } else {
          osStatus = { supported: osLayer.supported, skipped: true }
        }

        const body = projectState(model, { revealValues: reveal, revealSensitive })
        body.os = osStatus
        writeJson(res, 200, body)
      } catch (error) {
        // 自己捕获：webserver 会把抛出的异常变成一个**空的** 400，UI 就失去了原因
        writeJson(res, 500, {
          error: 'state-failed',
          message: errorText(error),
        })
      }
    },

    /**
     * GET /api/env-manager/credential-state —— 探测一组名字的密钥状态。
     *
     * 用 GET + 查询串而不是把名字塞进主 state 响应，原因有二：
     *  1. 主 state 是环境变量的视图，密钥是另一个键空间；混在一起会含糊。
     *  2. 客户端知道自己关心哪些名字（从 state 里筛出敏感名），按需查询即可，
     *     不必让每个 state 请求都多付一轮凭据读取。
     *
     * 响应里**只有** `{ configured, writable, source, sourceLabel, editable, blockedReason }`，
     * 没有任何可以搭载值的位置。
     */
    async credentialState(req, res) {
      if (!guard(req, res)) return
      if (!requireGet(req, res)) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const refs = (url.searchParams.get('refs') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)

        const access = credentialAccessOf(ctx)
        if (access === undefined) {
          writeJson(res, 200, { available: false, refs: {} })
          return
        }

        writeJson(res, 200, { available: true, refs: await access.describeMany(refs) })
      } catch (error) {
        writeJson(res, 500, { error: 'credential-state-failed', message: errorText(error) })
      }
    },

    /** GET /api/env-manager/health —— 轻量探活，供 P4 目视确认。 */
    health(req, res) {
      if (!guard(req, res)) return
      if (!requireGet(req, res)) return
      // 注意：不能在这里读 `ctx.credentials`。cordis 对未在插件 `inject` 里
      // 声明的服务会**直接抛错**（"cannot get property X without inject"），
      // 而不是返回 undefined —— 这个断言是实测出来的，不是推测。
      // 所以凭据可用性由 `probeCredentials` 在插件级探测后记录，这里只回答
      // 路由层的健康度。
      writeJson(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        routes: [STATE_ROUTE, HEALTH_ROUTE],
      })
    },

    /**
     * 注册两条路由。
     *
     * 用 `ctx.inject([...], cb)` 延迟激活：`webServer` 与本插件行的激活顺序
     * 不保证，直接读会拿到 `undefined`（P0 已经踩过这个坑 —— cordis 的
     * `ReflectService._getImpl` 在 strict 模式下要求服务所属 fiber 已 ACTIVE）。
     *
     * @returns 注册用的 fiber（PromiseLike），可忽略。
     */
    register() {
      // 防御：缺 ctx.inject 的上下文（测试替身、非 cordis 宿主）不应炸掉
      if (typeof ctx.inject !== 'function') {
        ctx.logger?.('env-manager')?.warn?.('[env-manager] ctx.inject unavailable — host API routes not registered')
        return undefined
      }

      // **必须绑定 this**：webserver 会以裸函数形式调用 handler，若直接传
      // `this.state` 则 this 不再指向本对象，处理器抛错 → webserver 回一个
      // 空的 400，症状是"路由像是没注册"，极难定位。
      const stateHandler = this.state.bind(this)
      const healthHandler = this.health.bind(this)
      const credentialStateHandler = this.credentialState.bind(this)
      const valueHandler = this.value.bind(this)

      return ctx.inject(['webServer'], (scope) => {
        scope.effect(() => {
          const disposers = [
            scope.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: stateHandler }),
            scope.webServer.register({ kind: 'exact', path: HEALTH_ROUTE, handler: healthHandler }),
            scope.webServer.register({ kind: 'exact', path: CREDENTIAL_STATE_ROUTE, handler: credentialStateHandler }),
            scope.webServer.register({ kind: 'exact', path: VALUE_ROUTE, handler: valueHandler }),
          ]
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* 卸载顺序不保证，单个失败不影响其余 */
              }
            }
          }
        })
        ctx.logger?.('env-manager')?.info?.(
          `[env-manager] routes registered: ${STATE_ROUTE}, ${HEALTH_ROUTE}, ${CREDENTIAL_STATE_ROUTE}`,
        )
      })
    },

    /**
     * 注册写路由（`.env` / 凭据 / 注册表）。
     *
     * 与读路由分开是刻意的：写端点的爆炸半径大得多，分开注册让 composition
     * 可以选择只暴露只读面。
     *
     * @param writeRoutes - `createWriteRoutes()` 的结果。
     * @returns 注册用的 fiber（PromiseLike）。
     */
    registerWriteRoutes(writeRoutes) {
      if (typeof ctx.inject !== 'function') return undefined

      const bound = {
        env: writeRoutes.env.bind(writeRoutes),
        envRead: writeRoutes.envRead.bind(writeRoutes),
        credentials: writeRoutes.credentials.bind(writeRoutes),
        registry: writeRoutes.registry.bind(writeRoutes),
      }

      return ctx.inject(['webServer'], (scope) => {
        scope.effect(() => {
          const disposers = [
            scope.webServer.register({ kind: 'exact', path: ENV_ROUTE, handler: bound.env }),
            scope.webServer.register({ kind: 'exact', path: `${ENV_ROUTE}/read`, handler: bound.envRead }),
            scope.webServer.register({ kind: 'exact', path: CREDENTIAL_ROUTE, handler: bound.credentials }),
            scope.webServer.register({ kind: 'exact', path: REGISTRY_ROUTE, handler: bound.registry }),
          ]
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* ignore */
              }
            }
          }
        })
        ctx.logger?.('env-manager')?.info?.(
          `[env-manager] write routes registered: ${ENV_ROUTE}, ${CREDENTIAL_ROUTE}, ${REGISTRY_ROUTE}`,
        )
      })
    },
  }
}

/**
 * 写一个 JSON 响应。
 *
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可序列化对象。
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text, 'utf8'),
  })
  res.end(text)
}

/**
 * 从 `unknown` 里安全取出 `message`，取不到就把原值整体字符串化。
 *
 * catch 变量在 strict 下是 `unknown`，直接读 `.message` 过不了类型检查。
 * 这里按**形状**取值而不是 `instanceof Error` —— 宿主与子进程抛出的未必是
 * `Error` 实例，断言的范围也只有这一个属性；结果与原来的
 * `String(error?.message ?? error)` 完全一致（对 null/undefined 与基本类型同样安全）。
 *
 * @param error - 任意抛出的值。
 * @returns 诊断文本。
 */
function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return String(message ?? error)
}
