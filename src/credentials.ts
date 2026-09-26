/**
 * 凭据域适配层 —— 密钥的读写，以及"被遮蔽"的可行动解释。
 *
 * 这一层最容易被写错的地方是**泄露**。`dsh-credentials` 的设计刻意让
 * `describe()` 的返回类型"没有可以搭载值的位置"（契约原文：*The view has no
 * slot a value could ride in*），所以这个模块**只调用 `describe`**，
 * 从不调用 `resolve()` —— 整个文件里没有一处返回值本身。
 * "是否已配置"这个事实由 `describe().configured` 回答，不需要 `resolve`。
 *
 * 第二个关键点是**遮蔽**。契约写明 `set()` 的拒绝理由：
 *
 * > Rejects while a read-only source shadows the reference — the write would
 * > appear to succeed while resolution keeps returning the shadowing value.
 *
 * 也就是说：如果某个名字已经被继承的进程环境提供，凭据库**无法**覆盖它，
 * 而且拒绝是**正确的**——否则用户会以为自己换了 key，实际换了个寂寞。
 * 所以这里把拒绝翻译成 UI 能直接展示、并且能指导下一步动作的信息。
 *
 * 来源层的命名由 provider 决定（local provider 用 `env` / `file` /
 * `project-env` / `user-env`），所以这里做一层人类可读映射，但**保留原始值**
 * 以便诊断。
 *
 * @module dsh-env-manager/credentials
 */

import type {
  CredentialInfo,
  CredentialProvider,
  CredentialSource,
  CredentialView,
} from './types'

/**
 * 内联的引用名正则，与 `dsh-credentials` 的 `REF_PATTERN` 逐字符一致。
 *
 * 为什么不直接 `import { isCredentialRefName }`：那是 `dsh-credentials` 的
 * 运行时导出，而本包并不声明它为依赖（插件由 profile 提供该包）。为了一个
 * 六行正则引入跨包运行时解析风险不值得，所以内联并在测试里断言它与
 * `env-write.mjs` 的环境变量名规则一致。
 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 来源层 → 人类可读说明。未列出的来源原样展示。 */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  env: '启动环境（继承自父进程）',
  file: '凭据库（$DSH_HOME/.credentials.yaml）',
  'project-env': '项目 .env',
  'user-env': '$DSH_HOME/.env',
}

/**
 * 把 `catch` 捕获到的 `unknown` 收口成可展示文本。
 *
 * 与旧写法 `String(error?.message ?? error)` 逐条等价：只有 `message` 既非
 * `undefined` 也非 `null` 时才取它，其余（包括非对象、`null`）一律 `String(error)`。
 *
 * @param error - `catch` 捕获到的值。
 * @returns 人类可读文本。
 */
function messageOf(error: unknown): string {
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined
  return message === undefined || message === null ? String(error) : String(message)
}

/**
 * 把来源层标识翻译成 UI 文案。
 *
 * @param source - provider 给出的来源标识。
 * @returns 人类可读说明。
 */
export function describeSource(source: CredentialSource | undefined): string {
  if (typeof source !== 'string' || source.length === 0) return '未知来源'
  return SOURCE_LABELS[source] ?? source
}

/**
 * 判断一个名字是否可能是合法的凭据引用。
 *
 * 契约要求消费方先问这个再解析：名字不在语法内时"没有可错过的引用"，
 * 应当读作"未设置"，而不是抛错。
 *
 * 参数收 `unknown` 并作为类型谓词 —— 函数体本来就是 `typeof` 判定，
 * 这样调用方既能拿它做布尔判断，也能拿它把请求体里的未校验值收口成 `string`。
 *
 * @param name - 候选名字。
 * @returns 合法时为 true。
 *
 * 为 true 时它一定是字符串（类型谓词），所以调用方可以直接拿它把未校验的
 * 请求体值收口成 `string`，不必再写一次 `typeof`。
 */
export function isPossibleRef(name: unknown): name is string {
  return typeof name === 'string' && REF_PATTERN.test(name)
}

/** 凭据被遮蔽时抛出，带可行动的说明。 */
export class CredentialShadowed extends Error {
  /** 机器可读原因。 */
  readonly code: string
  /** 被遮蔽的引用名。 */
  readonly ref: string
  /** 遮蔽它的来源层。 */
  readonly source: CredentialSource | undefined
  /** provider 报告的当前可写性。 */
  readonly writable: boolean

  /**
   * @param ref - 被遮蔽的引用名。
   * @param source - 遮蔽它的来源层。
   * @param writable - provider 报告的当前可写性。
   */
  constructor(ref: string, source: CredentialSource | undefined, writable: boolean) {
    super(
      `"${ref}" 由「${describeSource(source)}」提供，凭据库无法覆盖它。` +
        `请先在那一层修改，或移除它之后再写入凭据库。`,
    )
    this.name = 'CredentialShadowed'
    this.code = 'credential-shadowed'
    this.ref = ref
    this.source = source
    this.writable = writable
  }
}

/** 凭据写入被拒绝（非遮蔽类）。 */
export class CredentialRejected extends Error {
  /** 机器可读原因。 */
  readonly code: string

  /**
   * @param code - 机器可读原因。
   * @param message - 人类可读说明。
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CredentialRejected'
    this.code = code
  }
}

/**
 * 把一个引用的状态翻译成 UI 可直接渲染的视图。
 *
 * **返回值里永远没有密钥本身** —— 这是本模块的存在意义。
 *
 * @param info - provider 的 `describe()` 结果。
 * @returns UI 视图，含可行动提示。
 */
export function toCredentialView(info: CredentialInfo | undefined): CredentialView {
  const view: CredentialView = {
    configured: info?.configured === true,
    writable: info?.writable === true,
    source: typeof info?.source === 'string' ? info.source : undefined,
    sourceLabel: info?.source === undefined ? undefined : describeSource(info.source),
    /** 是否可以呈现一个可编辑输入框。 */
    editable: info?.writable === true,
    /** 无法编辑时的原因与下一步动作。 */
    blockedReason: undefined,
  }

  if (!view.configured) {
    view.blockedReason = view.writable ? undefined : '当前没有可写的凭据存储'
    return view
  }

  if (view.writable) return view

  // 已配置但不可写：唯一已知成因是只读来源遮蔽
  if (view.source === 'env') {
    view.blockedReason =
      `已由「${describeSource(view.source)}」提供，凭据库无法覆盖。` +
      `要改这个值，需要修改启动环境（导出该变量）后重启 DSH。`
  } else if (view.source !== undefined) {
    view.blockedReason = `当前由「${describeSource(view.source)}」提供，凭据库不可写`
  } else {
    view.blockedReason = '当前凭据存储不可写'
  }

  return view
}

/** `listRecordSummary()` 的结果：只有记录数量与种类，**不含任何值**。 */
export interface CredentialRecordSummary {
  /** 已存记录总数。 */
  total: number
  /** `kind -> 条数`。 */
  byKind: Record<string, number>
}

/**
 * 凭据适配器。围绕 `ctx.credentials` 的薄封装，**只暴露安全操作**。
 *
 * 刻意不导出任何返回值本身的方法 —— 从类型层面就杜绝泄露。
 *
 * `ref` / `value` 如实声明成 `unknown`：调用方（HTTP 写路由）拿到的是请求体里
 * **未校验**的值，而本类的守卫本来就是按"可能是任何值"写的 —— `isPossibleRef()`
 * 做语法判定、`set()` 另判空值，非法输入得到的是结构化拒绝
 * （`invalid-ref` / `empty-value`），而不是 `TypeError`。收口点就是那两处守卫，
 * 不新增任何拒绝条件。
 */
export class CredentialAccess {
  /**
   * `ctx.credentials` 服务。**声明成私有**：外部只能经本类的方法访问它，
   * 也就没有路径能绕到 provider 的 `resolve()` 上。
   */
  private readonly provider: CredentialProvider

  /**
   * @param provider - `ctx.credentials` 服务。
   */
  constructor(provider: CredentialProvider) {
    this.provider = provider
  }

  /**
   * 描述一个引用，不含值。
   *
   * @param ref - 引用名。
   * @returns UI 视图。
   */
  async describe(ref: unknown): Promise<CredentialView> {
    if (!isPossibleRef(ref)) {
      // 名字不在引用语法内：读作"未设置"，而不是抛错
      return toCredentialView({ configured: false, writable: false })
    }
    const info = await this.provider.describe(ref)
    return toCredentialView(info)
  }

  /**
   * 批量描述。
   *
   * @param refs - 引用名数组。
   * @returns `ref -> 视图` 的映射。
   */
  async describeMany(refs: readonly string[]): Promise<Record<string, CredentialView>> {
    const out: Record<string, CredentialView> = {}
    for (const ref of refs) {
      // 逐个执行：一个失败不应让整批读不到
      try {
        out[ref] = await this.describe(ref)
      } catch (error) {
        out[ref] = {
          configured: false,
          writable: false,
          editable: false,
          error: messageOf(error),
        }
      }
    }
    return out
  }

  /**
   * 写入一个密钥。
   *
   * 写入前先 `describe` 做**前置判断**，避免让用户填完才失败；但真正的权威
   * 判定仍是 `set()` 自身的拒绝 —— provider 可能在两次调用之间改变状态
   * （另一个进程改了文件、外部编辑被 watcher 观察到）。所以这里同时做前置
   * 判断和拒绝捕获，两者互补而不是二选一。
   *
   * 空值是明确拒绝的：契约规定空值等同未设置，`set` 会拒绝，应当用 `unset`。
   *
   * @param ref - 引用名。
   * @param value - 非空的密钥值。
   * @returns 写入后的视图。
   * @throws {CredentialShadowed} 被只读来源遮蔽时。
   * @throws {CredentialRejected} 其他拒绝（空值、非法名、存储不可写等）。
   */
  async set(ref: unknown, value: unknown): Promise<CredentialView> {
    if (typeof ref !== 'string' || !isPossibleRef(ref)) {
      throw new CredentialRejected('invalid-ref', `"${String(ref)}" 不是合法的凭据引用名（必须是环境变量形式的标识符）`)
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new CredentialRejected('empty-value', '密钥不能为空；要移除请使用删除操作（凭据库把空值视为未设置）')
    }

    // 前置判断：能给出比 provider 错误更好的文案
    const before = await this.describe(ref)
    if (before.configured && !before.writable) {
      throw new CredentialShadowed(ref, before.source, before.writable)
    }

    try {
      await this.provider.set(ref, value)
    } catch (error) {
      // 权威判定：provider 拒绝了。区分遮蔽与其他原因，给出可行动信息。
      const after = await this.describe(ref).catch(() => undefined)
      if (after !== undefined && after.configured && !after.writable) {
        throw new CredentialShadowed(ref, after.source, after.writable)
      }
      throw new CredentialRejected('set-failed', messageOf(error))
    }

    return this.describe(ref)
  }

  /**
   * 移除一个密钥。
   *
   * @param ref - 引用名。
   * @returns 移除后的视图。
   * @throws {CredentialShadowed} 被只读来源遮蔽时（移除同样无效）。
   */
  async unset(ref: unknown): Promise<CredentialView> {
    if (typeof ref !== 'string' || !isPossibleRef(ref)) {
      throw new CredentialRejected('invalid-ref', `"${String(ref)}" 不是合法的凭据引用名`)
    }

    try {
      await this.provider.unset(ref)
    } catch (error) {
      const after = await this.describe(ref).catch(() => undefined)
      if (after !== undefined && after.configured && !after.writable) {
        throw new CredentialShadowed(ref, after.source, after.writable)
      }
      throw new CredentialRejected('unset-failed', messageOf(error))
    }

    return this.describe(ref)
  }

  /**
   * 枚举已存记录（授权 grant 等），供 UI 展示"我授权了什么"。
   *
   * @returns 记录的数量与种类，不含值。
   */
  async listRecordSummary(): Promise<CredentialRecordSummary> {
    const records = await this.provider.listRecords()
    const byKind: Record<string, number> = {}
    for (const entry of records) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    }
    return { total: records.length, byKind }
  }
}

/**
 * `credentialAccessOf` 需要的**最小上下文接口**。
 *
 * 刻意只要求它真正用到的两个成员，而不是 `PluginContext`：调用方各有更窄的
 * 上下文类型（如 `host-api.ts` 的 `HostApiContext`），参数收窄后它们**天然兼容**，
 * 不必为了类型相容去放宽各自的声明。结构式类型在这里正合适。
 */
export interface CredentialContextPort {
  credentials?: CredentialProvider | undefined
  get?(name: string): unknown
}

/**
 * 从 cordis 上下文取凭据适配器。
 *
 * @param ctx - 任何提供 `credentials` 或 `get()` 的上下文。
 * @returns 适配器；服务不存在时为 undefined。
 */
export function credentialAccessOf(ctx: CredentialContextPort): CredentialAccess | undefined {
  // `ctx.get()` 的契约是 `unknown`（types.ts 只声明"用到什么"，不复制宿主类型），
  // 所以这里的断言是宿主服务查找的**唯一收口点**：宿主保证 `'credentials'`
  // 取到的是凭据服务。行为不变 —— 两处都取不到时仍然返回 undefined。
  const provider = (ctx.credentials ?? ctx.get?.('credentials')) as CredentialProvider | undefined
  if (provider === undefined) return undefined
  return new CredentialAccess(provider)
}
