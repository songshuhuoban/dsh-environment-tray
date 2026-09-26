/**
 * P0 探针宿主半边 — DSH 环境变量管理插件。
 *
 * 本文件在 P0 阶段只做两件事：
 *   1. 证明插件能被 web profile 加载并 mount（加载即打日志）
 *   2. 验证设计文档 §11.1 的"档 A"：一个用 `ctx.shellEnv.register()`
 *      贡献的 `DSH_*` 变量，是否**无需重启 DSH** 就能在模型的下一次
 *      shell 调用中生效，且 `resolve()` 是每次调用重新执行（真热重载）。
 *
 * 设计约束（来自 dsh-shell-env 的 register 校验）：
 *   - key 必须是 `DSH_` 前缀 + 合法后缀
 *   - 不能占用保留 key：DSH_HOME / DSH_SHELL / DSH_SESSION_ID
 *   - 同一 key 不能被两个贡献者同时拥有（重复会抛错）
 *
 * @module dsh-env-manager
 */

import { readFileSync } from 'node:fs'

import { credentialAccessOf } from './credentials.mjs'
import { createHostApi, runReg } from './host-api.mjs'
import { OsEnvironmentLayer } from './registry.mjs'
import { createWriteRoutes } from './write-routes.mjs'

/** 贡献者名字，用于诊断与重复检测。 */
export const name = 'env-manager'

/**
 * 依赖的服务名。**必须声明**：cordis 会推迟 `apply` 直到这些服务就绪。
 *
 * 这不是可选的优化，而且比"晚一点再读"更严格：cordis 对**未声明**的服务
 * 直接抛错（`cannot get property "credentials" without inject`），
 * 而不是返回 `undefined`。所以任何想读的服务都必须在这里声明 ——
 * "运行时再探测"这条路走不通（实测结论）。
 *
 * - `shellEnv`：注册 `DSH_*` 贡献者。web profile 的 host plane 明确保留它。
 * - `credentials`：凭据域。web profile 的插件树里有 `dsh-credentials-local`。
 * - `connection`：**请求策略闸门**。`dsh-host-webserver` 自身不带鉴权，
 *   路由所有者必须自己校验来源；`connection.requestRejection` 就是 DSH 的
 *   权威实现。声明它可保证路由注册时闸门一定可用（否则闸门会失败关闭）。
 */
export const inject = ['shellEnv', 'credentials', 'connection']

/** 我们贡献的那个变量名。不属于内置保留 key。 */
const LIVE_KEY = 'DSH_ENV_MANAGER_LIVE'

/** 标记文件路径：外部进程改写它的内容，用来证明 resolve() 读的是实时值。 */
const MARKER_KEY = 'DSH_ENV_MANAGER_MARKER'

/** 日志前缀。 */
const TAG = '[env-manager]'

/**
 * 写一条诊断。**任何日志失败都不得影响插件加载** —— 这个插件会挂进用户
 * 正在运行的 DSH 进程，一次抛出会让整棵插件树启动失败。
 *
 * @param ctx - cordis 上下文（可能缺少 logger）。
 * @param message - 诊断文本。
 */
function announce(ctx, message) {
  try {
    ctx.logger?.('env-manager')?.info?.(`${TAG} ${message}`)
  } catch {
    /* 日志服务不可用不能影响加载 */
  }
  // 同时写 stderr：即使未接日志服务也能在启动输出里看到，便于 P0 判定
  try {
    process.stderr.write(`${TAG} ${message}\n`)
  } catch {
    /* ignore */
  }
}

/**
 * 载入本插件。**绝不抛错**。所有失败都降级为日志 + 不注册贡献者。
 *
 * @param ctx - cordis 上下文。
 */
export function apply(ctx) {
  const markerPath = process.env[MARKER_KEY]

  announce(
    ctx,
    `plugin loaded (pid=${process.pid}, uptime=${process.uptime().toFixed(1)}s, DSH_SHELL=${process.env.DSH_SHELL ?? 'unset'})`,
  )

  // `shellEnv` 是 dsh-shell-env 提供的注册表；web profile 的 host plane 明确
  // 保留它（dsh-web-app 的 bundle 注释说明了这一点）。`inject` 已保证它就绪，
  // 这里仍然防御性检查：宁可报告也不让整棵树启动失败。
  const shellEnv = ctx.shellEnv ?? ctx.get?.('shellEnv')
  if (shellEnv === undefined) {
    announce(ctx, 'ctx.shellEnv unavailable — contributor NOT registered (is dsh-shell-env mounted in this plane?)')
    return
  }

  try {
    const dispose = shellEnv.register({
      name: 'env-manager-live-probe',
      variables: {
        [LIVE_KEY]: {
          description:
            'P0 probe: proves a plugin-contributed DSH_* variable hot-reloads without restarting DSH.',
        },
      },
      /**
       * 每次 shell 工具调用都会执行一次。这里刻意做**实时**读取：先看标记文件
       * （外部进程可改），拿不到就退化成进程启动时刻的常量。这样一次实验能同时
       * 证明"热生效"与"resolve 每次重跑"。
       *
       * 契约要求它廉价：只计算本次执行可用的值，同步、无网络。
       *
       * @returns 只含已声明 key 的部分映射。
       */
      resolve: () => {
        let live = `static-pid-${String(process.pid)}`
        if (typeof markerPath === 'string' && markerPath.length > 0) {
          try {
            const text = readFileSync(markerPath, 'utf8').trim()
            live = text.length > 0 ? text : 'marker-empty'
          } catch {
            live = 'marker-unreadable'
          }
        }
        return { [LIVE_KEY]: live }
      },
    })

    if (typeof dispose === 'function') {
      ctx.on?.('dispose', () => {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      })
    }

    announce(ctx, `contributor registered: ${LIVE_KEY} (marker=${markerPath ?? 'unset'})`)
  } catch (error) {
    announce(ctx, `register() failed: ${String(error?.message ?? error)}`)
  }

  // ── 凭据域能力探测 ─────────────────────────────────────────────────────────
  // `credentials` 已在 inject 里声明，所以这里能安全读取。探测只枚举记录数量
  // 与种类，绝不触碰任何值。
  void probeCredentials(ctx)

  // ── HTTP 面 ────────────────────────────────────────────────────────────────
  // 客户端页签的数据来源。用 ctx.inject 延迟到 webServer 就绪再注册。
  try {
    const api = createHostApi({ ctx })
    api.register()
    // 写路由单独注册：爆炸半径大得多，分开让 composition 可以只暴露只读面
    api.registerWriteRoutes(createWriteRoutes({ ctx, osLayer: new OsEnvironmentLayer({ run: runReg }) }))
  } catch (error) {
    announce(ctx, `host API registration failed: ${String(error?.message ?? error)}`)
  }
}

/**
 * 探测凭据服务并记录结论。**绝不抛错、绝不读取任何值。**
 *
 * @param ctx - cordis 上下文（`credentials` 已在 inject 中声明）。
 */
async function probeCredentials(ctx) {
  if (ctx.credentials === undefined) {
    announce(ctx, 'credentials service absent despite inject — key management will be disabled in the UI')
    return
  }

  try {
    // 只枚举记录数量与种类，不触碰任何值
    const summary = await credentialAccessOf(ctx).listRecordSummary()
    announce(
      ctx,
      `credentials service available (${String(summary.total)} stored record(s): ${JSON.stringify(summary.byKind)})`,
    )
  } catch (error) {
    announce(ctx, `credentials service present but unusable: ${String(error?.message ?? error)}`)
  }
}
