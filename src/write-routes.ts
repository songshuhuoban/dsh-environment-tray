/**
 * 写路由 —— 把三层写入能力暴露成 HTTP。
 *
 * **这是整个插件风险最高的地方**：一个签了名的 HTTP 端点，能写磁盘文件、
 * 能改注册表。所以本模块的每一条设计都围绕"限制爆炸半径"：
 *
 *  1. **绝不接受任意路径。** 请求里给的是**层标识**（`project-env` / `user-env`），
 *     路径由宿主自己算出来。请求里若带 `path`，必须与算出来的完全一致，否则拒绝。
 *     没有这一条，任何能访问该端点的人都能覆盖任意文件。
 *  2. **写前必校验。** `.env` 走 `applyEnvEdits`（含禁止名单 + 有损值 + CAS），
 *     密钥走 `CredentialAccess`（含遮蔽预检），注册表走 `OsEnvironmentLayer`
 *     （含类型保留）。路由层不自己发明规则。
 *  3. **响应里不出现密钥。** 密钥写入后只回 `describe()` 的结果。
 *  4. **错误必须结构化到达客户端。** webserver 会把抛出的异常变成**空的** 400，
 *     所以这里自己捕获并回 `{ error, message, problems }`。
 *
 * @module dsh-env-manager/write-routes
 */

import { resolve } from 'node:path'

import { applyEnvEdits, EnvEditRejected, readDotEnvFile } from './env-write'
import { resolveDshHome } from './env-model'
import { CredentialAccess, CredentialRejected, CredentialShadowed } from './credentials'
import { USER_SCOPE, MACHINE_SCOPE } from './registry'
import type {
  ConnectionService,
  CredentialInfo,
  CredentialProvider,
  CredentialView,
  EnvEdit,
  EnvEditProblem,
  IncomingRequest,
  RouteHandler,
  ServerResponse,
  WebServerService,
} from './types'

/** 请求体上限。环境变量的值不该有几百 KB。 */
const MAX_BODY_BYTES = 256 * 1024

/** 路由路径。 */
export const ENV_ROUTE = '/api/env-manager/env'
export const CREDENTIAL_ROUTE = '/api/env-manager/credentials'
export const REGISTRY_ROUTE = '/api/env-manager/registry'

/**
 * 请求策略闸门。
 *
 * **这是必须的一层。** `dsh-host-webserver` 的文档明确说明它自身
 * "carries no TLS, authentication, or origin policy of its own"，并警告
 * "Binding a non-loopback address still exposes unprotected routes" ——
 * 鉴权由**路由所有者**负责，而 `dsh-client-connection` 只为它自己注册的
 * 路由做了这件事。
 *
 * 我们直接把路由注册在 webserver 上，因此**默认绕过了那道闸门**。实测确证过
 * 这个缺口的后果：一个带 `Sec-Fetch-Site: cross-site` 与外部 `Origin` 的
 * 请求能成功写入 `.env`，而第一方 `/api/gateway` 在同样条件下回 401。
 *
 * 所以这里**复用 DSH 自己的权威实现**（`connection.requestRejection`），
 * 而不是自己重新实现一套安全策略 —— 自研的策略迟早会与上游漂移。
 *
 * 策略内容（来自 `dsh-client-connection` 的 `isTrustedApiRequest` +
 * `browserAuth`）：
 *   - Host 头必须是回环或部署声明的 trustedHosts（挡 DNS rebinding）
 *   - `Sec-Fetch-Site: cross-site` 直接拒（挡跨站请求）
 *   - `Origin`（若存在）必须与 Host 同源
 *   - 之后还要通过浏览器会话认证（cookie / process launch token）
 *
 * @param options - 依赖。
 * @param options.connection - `ctx.connection` 服务；缺失时**失败关闭**。
 * @returns 一个 `(req, res) => boolean` 闸门：返回 true 表示可以继续。
 */
export function createRequestGuard(options: {
  /** `ctx.connection`；缺失时闸门**失败关闭**。 */
  connection?: ConnectionService | undefined
}): (req: IncomingRequest, res: ServerResponse) => boolean {
  const { connection } = options

  return (req, res) => {
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      // 失败关闭：拿不到权威策略时宁可拒绝，也不放过一个未鉴权的写端点。
      // （本插件的路由只注册在 web 组合里，而 web 组合的 base bundle 必定
      //  提供 `connection`，所以这条分支正常不会走到。）
      writeJson(res, 503, {
        ok: false,
        error: 'request-policy-unavailable',
        message: '宿主未提供请求策略服务（ctx.connection），无法校验请求来源；已拒绝以失败关闭',
      })
      return false
    }

    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return true

    writeJson(res, rejection, {
      ok: false,
      error: rejection === 403 ? 'untrusted-origin' : 'unauthenticated',
      message:
        rejection === 403
          ? '请求未通过 Host/Origin 校验（可能是跨站请求或 DNS rebinding）'
          : '请求未通过浏览器会话认证',
    })
    return false
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 上限是必须的：没有上限的话一个超大 body 会一直堆在内存里。
 *
 * @param req - IncomingMessage。
 * @returns 解析后的对象。
 * @throws 当 body 过大或不是合法 JSON 时。
 */
export async function readJsonBody(req: IncomingRequest): Promise<Record<string, unknown>> {
  // 用 `Uint8Array` 而不是 `Buffer`：`IncomingRequest` 的迭代元素是 `Uint8Array`，
  // 而 `Buffer.concat` 接受 `Uint8Array[]`（Buffer 是其子类）。
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      throw new Error(`请求体超过上限 ${String(MAX_BODY_BYTES)} 字节`)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${String((error as { message?: string } | undefined)?.message ?? error)}`)
  }
}

/**
 * 解析请求目标层对应的 `.env` 路径。
 *
 * **路径完全由宿主推导**，只接受层标识。请求里若给了 `path`，必须与推导结果
 * 一致 —— 这条比对是防止路径注入的关键。
 *
 * @param layer - `project-env` 或 `user-env`。
 * @param cwd - 项目目录（`project-env` 用）。
 * @param home - DSH home（`user-env` 用）。
 * @param claimed - 请求里声明的路径；可选。
 * @returns `.env` 的绝对路径。
 * @throws 层非法或声明路径与推导结果不一致时。
 */
export function resolveLayerPath(
  layer: unknown,
  cwd: string,
  home: string,
  claimed?: unknown,
): string {
  let derived: string
  if (layer === 'project-env') {
    derived = resolve(cwd, '.env')
  } else if (layer === 'user-env') {
    derived = resolve(home, '.env')
  } else {
    throw new Error(`不支持的层 "${String(layer)}"；只接受 project-env 与 user-env`)
  }

  if (claimed !== undefined && claimed !== null) {
    // 用 resolve 归一后再比，避免 `..` 或大小写差异绕过
    const claimedResolved = resolve(String(claimed))
    if (claimedResolved !== derived) {
      throw new Error(
        `拒绝写入：请求声明的路径 "${claimedResolved}" 与 ${layer} 层推导出的路径 "${derived}" 不一致。` +
          `本端点只接受层标识，不接受任意路径`,
      )
    }
  }

  return derived
}

/** 写操作被拒绝。 */
export class WriteRejected extends Error {
  /** 机器可读原因。 */
  readonly code: string
  /** 结构化问题列表（禁止名单、有损值等），供 UI 逐条展示。 */
  readonly problems: EnvEditProblem[]
  /** 建议的 HTTP 状态码。 */
  readonly status: number

  /**
   * @param code - 机器可读原因。
   * @param message - 人类可读说明。
   * @param problems - 结构化问题列表。
   * @param status - 建议的 HTTP 状态码。
   */
  constructor(code: string, message: string, problems: EnvEditProblem[] = [], status = 400) {
    super(message)
    this.name = 'WriteRejected'
    this.code = code
    this.problems = problems
    this.status = status
  }
}

/**
 * 把内部异常翻译成 `WriteRejected`，保住状态码与结构化问题。
 *
 * @param error - 原始异常。
 * @returns 规范化后的拒绝对象。
 */
export function toWriteRejected(error: unknown): WriteRejected {
  if (error instanceof WriteRejected) return error
  if (error instanceof EnvEditRejected) {
    // CAS 冲突是 409（可重试），校验失败是 400
    const rejected = error as EnvEditRejected & { code: string; problems?: EnvEditProblem[] }
    const status = rejected.code === 'stale-revision' ? 409 : 400
    return new WriteRejected(rejected.code, rejected.message, rejected.problems ?? [], status)
  }
  if (error instanceof CredentialShadowed) {
    return new WriteRejected('credential-shadowed', error.message, [], 409)
  }
  if (error instanceof CredentialRejected) {
    const rejected = error as CredentialRejected & { code?: string }
    return new WriteRejected(rejected.code ?? 'credential-rejected', error.message, [], 400)
  }
  const message = (error as { message?: string } | undefined)?.message
  return new WriteRejected('write-failed', String(message ?? error), [], 500)
}

/** 本模块用到的 OS 环境层最小接口（真实实现见 `./registry`）。 */
export interface OsLayerPort {
  readonly supported: boolean
  write(scope: string, name: string, value: string, type?: string): Promise<{ ok: boolean; type?: string; error?: string }>
  remove(scope: string, name: string): Promise<{ ok: boolean; removed?: { name: string; value: string; type: string }; backupUnavailable?: boolean; error?: string }>
}

/** `createWriteRoutes` 的依赖。 */
export interface WriteRoutesOptions {
  /** cordis 上下文（只用到 credentials / connection）。 */
  ctx: {
    credentials?: CredentialProvider | undefined
    connection?: ConnectionService | undefined
  }
  /** OS 层适配器。 */
  osLayer: OsLayerPort
  /** 覆盖闸门（测试注入用）。 */
  guard?: (req: IncomingRequest, res: ServerResponse) => boolean
  /** 覆盖凭据适配器工厂（测试注入用）。 */
  credentialAccessOf?: () => CredentialAccess | undefined
  /** 覆盖 home 解析（测试注入用）。 */
  homeOf?: () => string
  /** 覆盖 connection（测试注入用）。 */
  connection?: ConnectionService | undefined
}

/** 四个写处理器的集合。 */
export interface WriteRouteHandlers {
  env: RouteHandler
  envRead: RouteHandler
  credentials: RouteHandler
  registry: RouteHandler
}

/**
 * 构造写路由处理器。
 *
 * @param options - 依赖。
 * @param options.ctx - cordis 上下文。
 * @param options.osLayer - OS 层适配器。
 * @param options.credentialAccess - 凭据适配器工厂；便于测试注入。
 * @param options.homeOf - DSH home 解析器；便于测试注入。
 * @returns 三个处理器。
 */
export function createWriteRoutes(options: WriteRoutesOptions): WriteRouteHandlers {
  const { ctx, osLayer } = options
  const homeOf = options.homeOf ?? (() => resolveDshHome())
  const credentialAccessOfFn: () => CredentialAccess | undefined =
    options.credentialAccessOf ??
    (() => {
      const provider = ctx.credentials
      return provider === undefined ? undefined : new CredentialAccess(provider)
    })

  // 请求策略闸门：**每个处理器都必须先过它**。见 createRequestGuard 的说明。
  const guard =
    options.guard ?? createRequestGuard({ connection: options.connection ?? ctx.connection })

  /** 只接受 POST。 */
  const requirePost = (req: IncomingRequest, res: ServerResponse): boolean => {
    if (req.method === 'POST') return true
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return false
  }

  /**
   * 统一写出结果或拒绝。
   *
   * **必须返回这个 promise 并让处理器 await 它。** 先前版本只启动链条就返回，
   * 于是 `await routes.env(...)` 在响应真正写出**之前**就 resolve 了 ——
   * 调用方读到的是未定义的 status/body。这个 bug 在测试里表现为"路由没反应"，
   * 但根因是实现异步语义不完整。
   *
   * @param res - 响应对象。
   * @param fn - 产生响应体的异步工作。
   * @returns 写出完成后的 promise。
   */
  const respond = (res: ServerResponse, fn: () => Promise<Record<string, unknown>>): Promise<void> =>
    Promise.resolve()
      .then(fn)
      .then((result) => writeJson(res, 200, { ok: true, ...result }))
      .catch((error) => {
        const rejected = toWriteRejected(error)
        writeJson(res, rejected.status, {
          ok: false,
          error: rejected.code,
          message: rejected.message,
          ...rejected.problems.length > 0 ? { problems: rejected.problems } : {},
        })
      })

  const cwdOf = (req: IncomingRequest): string => {
    try {
      return new URL(req.url ?? '/', 'http://localhost').searchParams.get('cwd') ?? process.cwd()
    } catch {
      return process.cwd()
    }
  }

  return {
    /**
     * POST /api/env-manager/env —— 批量编辑某个 `.env` 层。
     *
     * 请求体：`{ layer, expectedRevision, edits: [{op:'set'|'unset', name, value?}] }`
     * 可带 `path` 作断言，但必须与推导结果一致。
     */
    async env(req, res) {
      if (!guard(req, res)) return
      if (!requirePost(req, res)) return
      const cwd = cwdOf(req)
      await respond(res, async () => {
        const body = await readJsonBody(req)
        // `readJsonBody` 的返回是 `Record<string, unknown>`（请求体不可信），
        // 所以这里逐项校验而不是强转。校验通过后 `resolveLayerPath` 还会再验一次
        // 层标识本身（那里才是权威的层白名单）。
        if (typeof body.layer !== 'string') {
          throw new WriteRejected('invalid-layer', 'layer 必须是字符串', [], 400)
        }
        if (!Array.isArray(body.edits)) {
          throw new WriteRejected('invalid-edits', 'edits 必须是数组', [], 400)
        }
        if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'string') {
          throw new WriteRejected('invalid-revision', 'expectedRevision 必须是字符串', [], 400)
        }
        const path = resolveLayerPath(body.layer, cwd, homeOf(), body.path)
        const after = await applyEnvEdits({
          path,
          layer: body.layer,
          edits: body.edits as EnvEdit[],
          expectedRevision: body.expectedRevision,
        })
        // 只回结构与新 revision，不回全部值（values 可能含敏感项）
        return {
          path: after.path,
          revision: after.revision,
          keys: Object.keys(after.values),
        }
      })
    },

    /**
     * GET 不支持；POST /api/env-manager/env/read 用 POST 语义读一个层。
     *
     * 之所以不做成 GET：读也需要 `layer` 参数且要回 revision，放在同一族里
     * 更好对齐。仍然只接受层标识。
     */
    async envRead(req, res) {
      if (!guard(req, res)) return
      if (!requirePost(req, res)) return
      const cwd = cwdOf(req)
      await respond(res, async () => {
        const body = await readJsonBody(req)
        const path = resolveLayerPath(body.layer, cwd, homeOf(), body.path)
        const current = await readDotEnvFile(path)
        return {
          path: current.path,
          exists: current.exists,
          revision: current.revision,
          keys: Object.keys(current.values),
        }
      })
    },

    /**
     * POST /api/env-manager/credentials —— 写入或移除密钥。
     *
     * 请求体：`{ ref, value }` 写入；`{ ref, unset: true }` 移除。
     * **响应里永远不会出现密钥本身** —— 只回 `describe()` 的结果。
     */
    async credentials(req, res) {
      if (!guard(req, res)) return
      if (!requirePost(req, res)) return
      await respond(res, async () => {
        const access = credentialAccessOfFn()
        if (access === undefined) {
          throw new WriteRejected('credentials-unavailable', '本 composition 未挂载凭据域，无法管理密钥', [], 501)
        }
        const body = await readJsonBody(req)
        // 与 `env` 处理器同样的理由：请求体不可信，逐项校验后再交给凭据域。
        // 引用名必须是字符串；`value` 允许 `undefined`（表示清空），但给了就必须是字符串。
        if (typeof body.ref !== 'string' || body.ref.length === 0) {
          throw new WriteRejected('invalid-ref', 'ref 必须是非空字符串', [], 400)
        }
        if (body.value !== undefined && typeof body.value !== 'string') {
          throw new WriteRejected('invalid-value', 'value 必须是字符串', [], 400)
        }
        const ref = body.ref
        if (body.unset === true) {
          return { ref, view: await access.unset(ref) }
        }
        return { ref, view: await access.set(ref, body.value as string | undefined) }
      })
    },

    /**
     * POST /api/env-manager/registry —— 写入或修改 OS 层变量。
     *
     * 请求体：`{ scope, name, value, type? }`；`{ scope, name, unset: true }` 删除。
     * `type` 必须显式给出（客户端从读取结果里带回），否则 `REG_EXPAND_SZ`
     * 会被降级成 `REG_SZ`，破坏 `%VAR%` 引用。
     */
    async registry(req, res) {
      if (!guard(req, res)) return
      if (!requirePost(req, res)) return
      await respond(res, async () => {
        if (!osLayer.supported) {
          throw new WriteRejected(
            'unsupported-platform',
            '当前平台不支持通过本插件写 OS 环境变量（Linux/macOS 没有单一可靠的写入点）',
            [],
            501,
          )
        }
        const body = await readJsonBody(req)
        const scope = body.scope
        if (scope !== USER_SCOPE && scope !== MACHINE_SCOPE) {
          throw new WriteRejected('invalid-scope', `不支持的 scope "${String(scope)}"`, [], 400)
        }
        if (typeof body.name !== 'string' || body.name.length === 0) {
          throw new WriteRejected('invalid-name', '变量名不能为空', [], 400)
        }
        // 值必须是字符串。非字符串（数字/对象/数组）一律拒绝，而不是强转 ——
        // 静默 `String(x)` 会让 `{a:1}` 变成 "[object Object]" 写进注册表。
        if (body.value !== undefined && typeof body.value !== 'string') {
          throw new WriteRejected('invalid-value', 'value 必须是字符串', [], 400)
        }
        const value = typeof body.value === 'string' ? body.value : ''
        // 类型也必须显式是字符串；未知类型交由 OsEnvironmentLayer 降级为 REG_SZ。
        if (body.type !== undefined && typeof body.type !== 'string') {
          throw new WriteRejected('invalid-type', 'type 必须是字符串', [], 400)
        }
        const type = typeof body.type === 'string' ? body.type : undefined

        if (body.unset === true) {
          const removed = await osLayer.remove(scope, body.name)
          if (!removed.ok) throw new WriteRejected('registry-failed', String(removed.error), [], 500)
          // 把被删的原值回传，UI 才能提供撤销。删除注册表值没有回收站，
          // 这是让用户能挽回的唯一途径；取不到备份时如实报告而不是假装可撤销。
          return {
            scope,
            name: body.name,
            removed: true,
            ...removed.removed === undefined
              ? { backupUnavailable: true }
              : { undo: { name: removed.removed.name, value: removed.removed.value, type: removed.removed.type } },
            appliesAfterRestart: true,
          }
        }

        const wrote = await osLayer.write(scope, body.name, value, type)
        if (!wrote.ok) throw new WriteRejected('registry-failed', String(wrote.error), [], 500)
        return {
          scope,
          name: body.name,
          type: wrote.type,
          // 如实告知：注册表改动在 DSH 重启前不改变生效值（见设计文档 §17.1）
          appliesAfterRestart: true,
        }
      })
    },
  }
}

/**
 * 写一个 JSON 响应。与 host-api 的同名helper 保持一致的头。
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
