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
 * @module dsh-env-manager/host-api
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { buildEnvironmentModel, BLOCKED_REASON_TEXT } from './env-model.mjs'
import { credentialAccessOf } from './credentials.mjs'
import { mergeOsLayers, OsEnvironmentLayer, USER_SCOPE, MACHINE_SCOPE } from './registry.mjs'
import { createRequestGuard, CREDENTIAL_ROUTE, ENV_ROUTE, REGISTRY_ROUTE } from './write-routes.mjs'

const execFileAsync = promisify(execFile)

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
export async function runReg(args) {
  const { stdout } = await execFileAsync('reg.exe', args, {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer',
  })
  return stdout
}

/** 值的展示上限：超过就摘要化。 */
const VALUE_PREVIEW_LIMIT = 120

/** 路由路径。命名成 `/api/` 前缀以贴合 Web 端的既有约定。 */
export const STATE_ROUTE = '/api/env-manager/state'

/** 探活路由。 */
export const HEALTH_ROUTE = '/api/env-manager/health'

/** 密钥状态路由（只报"是否已配置"，永不回值）。 */
export const CREDENTIAL_STATE_ROUTE = '/api/env-manager/credential-state'

/**
 * 摘要素值以便展示。
 *
 * 长值（例如 `PATH`）只给长度与首尾片段 —— 它们的信息量在结构而不在全文。
 *
 * @param value - 原始值。
 * @returns 展示视图 `{ preview, length, truncated }`。
 */
export function summarizeValue(value) {
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
 * @param options.revealValues - 是否包含值。默认 true；敏感名永远不含。
 * @returns 可 JSON 序列化的视图。
 */
export function projectState(model, options = {}) {
  const revealValues = options.revealValues !== false

  const variables = model.variables.map((variable) => ({
    name: variable.name,
    effective: variable.effective,
    shadowed: variable.shadowed,
    forbidden: variable.forbidden,
    sensitive: variable.sensitive,
    runtimeManaged: variable.runtimeManaged,
    /** 该变量的层数：>1 表示存在遮蔽竞争。 */
    layerCount: variable.layers.length,
    layers: variable.layers.map((layer) => {
      const entry = {
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

      if (variable.sensitive) {
        // 敏感名**只回长度**。绝不能回摘要 —— 摘要里就是真实值的前 60 字符，
        // 那等于把密钥送到浏览器。（这个漏洞是被 verify-host-api.mjs 抓出来的：
        // 先前版本标了 redacted 却仍附带 valueSummary。）
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
    /**
     * 解析诊断（当前只有 BOM）。UI **必须**显示它们：带 BOM 的文件里第一个
     * 变量名对 DSH 而言与界面显示的不同，静默处理等于隐瞒。
     */
    warnings: model.warnings ?? [],
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
 * 构造宿主 API 处理器集合。
 *
 * @param options - 依赖。
 * @param options.ctx - cordis 上下文。
 * @param options.osLayer - OS 环境层适配器；默认用真实 `reg.exe`。
 * @returns 路由处理器与注册函数。
 */
export function createHostApi(options) {
  const { ctx } = options
  const osLayer = options.osLayer ?? new OsEnvironmentLayer({ run: runReg })

  // 读路由同样要过请求策略闸门：`/state` 会回传完整环境结构（含敏感名与其
  // 长度），`/credential-state` 会回传密钥的存在性 —— 都不该让跨站页面读到。
  const guard =
    options.guard ?? createRequestGuard({ connection: options.connection ?? ctx.connection })

  /** 从查询串取工作目录；未指定则用进程 cwd。 */
  const cwdOf = (req) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return url.searchParams.get('cwd') ?? process.cwd()
    } catch {
      return process.cwd()
    }
  }

  /** 只接受 GET/HEAD；其余明确回 405，而不是让处理器假装成功。 */
  const requireGet = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return true
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return false
  }

  return {
    /** GET /api/env-manager/state —— 复合模型视图。 */
    async state(req, res) {
      if (!guard(req, res)) return
      if (!requireGet(req, res)) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        // `reveal=0` 让客户端只要结构不要值（用于先渲染骨架）
        const reveal = url.searchParams.get('reveal') !== '0'
        // `os=0` 跳过注册表读取：读 HKLM 要起一次进程，客户端可以先不要这层
        const includeOs = url.searchParams.get('os') !== '0'

        const model = buildEnvironmentModel({ cwd: cwdOf(req) })

        let osStatus
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

        const body = projectState(model, { revealValues: reveal })
        body.os = osStatus
        writeJson(res, 200, body)
      } catch (error) {
        // 自己捕获：webserver 会把抛出的异常变成一个**空的** 400，UI 就失去了原因
        writeJson(res, 500, {
          error: 'state-failed',
          message: String(error?.message ?? error),
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
        writeJson(res, 500, { error: 'credential-state-failed', message: String(error?.message ?? error) })
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

      return ctx.inject(['webServer'], (scope) => {
        scope.effect(() => {
          const disposers = [
            scope.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: stateHandler }),
            scope.webServer.register({ kind: 'exact', path: HEALTH_ROUTE, handler: healthHandler }),
            scope.webServer.register({ kind: 'exact', path: CREDENTIAL_STATE_ROUTE, handler: credentialStateHandler }),
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
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text, 'utf8'),
  })
  res.end(text)
}
