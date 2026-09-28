/**
 * 共享类型：本插件对外的契约，以及它依赖的宿主服务的**最小结构**。
 *
 * ── 为什么这些类型是"结构式"而不是从 host 包 import ──────────────────────────
 *
 * 本插件以 bundle 形式装进用户的 profile，运行时的 `ctx` 由宿主提供。若直接
 * `import type { Context } from '@deepseek-ai/cordis'` 并声明完整的服务类型，
 * 就会把宿主的内部版本绑死。这里只声明**本插件实际用到的成员**，并按
 * `unknown` 收口 —— 一处声明、一处断言，比到处 `any` 更可审。
 *
 * ── 为什么凭证相关类型是手写的 ──────────────────────────────────────────────
 *
 * `dsh-credentials` 的契约刻意让 `describe()` 的返回类型"没有可以搭载值的位置"。
 * 状态描述不含值；显式逐项查看通过独立的 resolve 调用读取。
 *
 * @module dsh-environment-tray/types
 */

/* ────────────────────────── HTTP 面 ────────────────────────── */

/** 请求策略闸门用的最小请求视图（`connection.requestRejection` 只读 headers）。 */
export interface GuardableRequest {
  readonly headers?: Record<string, string | string[] | undefined>
  readonly method?: string
  readonly url?: string
}

/** 处理器能读到的请求：既是可迭代体（请求体），也带方法/URL/headers。 */
export interface IncomingRequest extends AsyncIterable<Uint8Array> {
  readonly method?: string
  readonly url?: string
  readonly headers?: Record<string, string | string[] | undefined>
}

/** 处理器写响应用的响应视图。 */
export interface ServerResponse {
  writeHead(status: number, headers?: Record<string, string | number>): void
  end(body?: string): void
}

/** 一个已注册路由的处理器。 */
export type RouteHandler = (req: IncomingRequest, res: ServerResponse) => void | Promise<void>

/** 宿主 webserver 暴露给本插件的最小接口。 */
export interface WebServerService {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: RouteHandler }): () => void
}

/**
 * 请求策略闸门。`dsh-host-webserver` 自身不带鉴权，鉴权由**路由所有者**负责，
 * 所以本插件必须自己调用这个权威实现。
 */
export interface ConnectionService {
  requestRejection(request: GuardableRequest): number | undefined
}

/* ────────────────────────── 宿主服务 ────────────────────────── */

/** 一个 `DSH_*` 变量声明。契约要求 `resolve` 廉价、同步、无网络。 */
export interface ShellEnvVariable {
  description: string
}

/** 插件对每次 shell 调用的环境贡献。 */
export interface ShellEnvContributor {
  name: string
  variables: Readonly<Record<string, ShellEnvVariable>>
  resolve(execution: unknown): Readonly<Partial<Record<string, string>>>
}

/** `ctx.shellEnv` 的最小接口。 */
export interface ShellEnvService {
  register(contributor: ShellEnvContributor): () => void
  collect?(execution: unknown): Record<string, string>
  list?(): readonly { key: string; contributor: string; description: string }[]
}

/** 凭据引用名的**来源层**标识（provider 定义，local provider 用这四个）。 */
export type CredentialSource = 'env' | 'file' | 'project-env' | 'user-env' | string

/**
 * `describe()` 的结果 —— 与 `dsh-credentials` 契约一致：
 * **没有可以搭载值的槽位**，这是"绝不泄露"的类型层保证。
 */
export interface CredentialInfo {
  configured: boolean
  source?: CredentialSource
  writable: boolean
}

/** 已存记录的枚举项（只给地址与种类，不含值）。 */
export interface CredentialRecordEntry {
  key: string
  kind: string
}

/** 默认状态只读 describe；用户逐项查看时才调用 resolve。 */
export interface CredentialProvider {
  resolve?(ref: string): Promise<{ value: string; source?: CredentialSource } | undefined>
  describe(ref: string): Promise<CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  listRecords(): Promise<readonly CredentialRecordEntry[]>
}

/* ────────────────────────── 复合环境模型 ────────────────────────── */

/** 层的标识。信任顺序见设计文档 §1.2。 */
export type EnvLayerId =
  | 'process'
  | 'project-env'
  | 'user-env'
  | 'credential'
  | 'os-user'
  | 'os-machine'

/** 某一层里某个变量的取值与可写性。 */
export interface EnvLayerValue {
  layer: EnvLayerId | string
  /** 该层提供的值；是否出现在传输视图里由 `projectState()` 的选项决定。 */
  value?: string
  /** 值的来源文件绝对路径（`process` 层无）。 */
  path?: string
  writable: boolean
  /** 不可写的机器可读原因码；文案由客户端从 `BLOCKED_REASON_TEXT` 取。 */
  blockedCode?: string
  /** 注册表原始类型（`REG_SZ` / `REG_EXPAND_SZ` …）。 */
  registryType?: string
  /** 写注册表系统级作用域需要提权。 */
  requiresElevation?: boolean
}

/** 一个变量名在所有层的取值与生效层。 */
export interface CompositeVariable {
  name: string
  layers: EnvLayerValue[]
  effective?: EnvLayerId | string
  shadowed: boolean
  forbidden: boolean
  sensitive: boolean
  runtimeManaged: boolean
  layerCount?: number
}

/** `.env` 解析产生的一条诊断。 */
export interface EnvParseWarning {
  code: string
  message: string
  path?: string
}

/** `buildEnvironmentModel()` 的结果。 */
export interface EnvironmentModel {
  cwd: string
  home: string
  projectFile?: { path: string; values: Record<string, string> }
  userFile?: { path: string; values: Record<string, string> }
  variables: CompositeVariable[]
  warnings: EnvParseWarning[]
}

/* ────────────────────────── cordis 上下文 ────────────────────────── */

/** `ctx.logger(name)` 返回的具名日志器。 */
export interface Logger {
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

/**
 * 插件 `apply` 收到的 cordis 上下文 —— **只声明本插件实际用到的成员**。
 *
 * 不 import 宿主包的完整 `Context` 类型，是为了避免把内部版本绑死；
 * 代价是这里要显式列出用到的面，好处是"用了什么"一目了然、可审。
 */
export interface PluginContext {
  shellEnv?: ShellEnvService | undefined
  credentials?: CredentialProvider | undefined
  connection?: ConnectionService | undefined
  webServer?: WebServerService | undefined
  get?(name: string): unknown
  /**
   * `ctx.logger(name)`。**允许返回 `undefined`**：宿主不保证每个组合都接了
   * 日志服务，调用方必须能安全跳过（`ctx.logger?.('x')?.info?.(...)`）。
   */
  logger?(name: string): Logger | undefined
  on?(event: string, handler: (...args: unknown[]) => void): void
  /**
   * 延迟激活：等 `deps` 里的服务就绪后再调 `callback`。
   *
   * 回调作用域**类型由调用方给出**（`Scope` 默认 `PluginContext`）。这一点是
   * `host-api.ts` 的 `HostApiScope` 揭示的：在 `inject(['webServer'], …)` 里
   * `webServer` 由 cordis 保证存在，若把作用域写死成"全部可选"的 `PluginContext`，
   * 就会逼调用方到处写 `?.`，把"注册失败"从抛错悄悄变成静默跳过。
   *
   * @param deps - 需要就绪的服务名。
   * @param callback - 服务就绪后执行，接收更具体的作用域。
   */
  inject?<Scope = PluginContext>(deps: string[], callback: (scope: Scope) => void): unknown
  effect?(fn: () => (() => void) | void): unknown
}

/* ────────────────────────── 编辑与写入 ────────────────────────── */

/** 一次写操作。 */
export interface EnvEdit {
  op: 'set' | 'unset'
  name: string
  value?: string
}

/** 一条校验问题。 */
export interface EnvEditProblem {
  code: string
  message: string
  name?: string
}

/** UI 可直接渲染的凭证视图（**没有任何字段能承载密钥值**）。 */
export interface CredentialView {
  configured: boolean
  writable: boolean
  source?: string
  sourceLabel?: string
  editable: boolean
  blockedReason?: string
  error?: string
}
