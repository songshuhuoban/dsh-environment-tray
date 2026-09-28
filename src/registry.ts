/**
 * OS 用户级 / 系统级环境变量层。
 *
 * 这是设计文档 §2 里"权威 E"的落地。三个必须讲清楚的事实：
 *
 *  1. **Windows 上权威只有一个：注册表。** 没有 profile 文件这一层
 *     （PowerShell profile 只对 PowerShell 生效，不是 OS 环境）。
 *  2. **重启前不会改变生效值。** 注册表的值在 DSH 启动时已被继承进
 *     `process` 层，而 `process` 层的信任顺序更高（`SOURCE_ORDER`）。
 *     所以 UI 里会看到"注册表说 X，进程说 Y（生效）" —— 这正是遮蔽展示
 *     最有价值的场景，也是最容易被误判成"改了没用"的地方。
 *  3. **PATH 是唯一会合并的变量。** 最终 PATH = 系统 PATH + `;` + 用户 PATH
 *     （**系统在前**）。其他变量都是用户级覆盖系统级。
 *
 * 读写走 `reg.exe`，因为它能给出**原始类型**（`REG_SZ` vs `REG_EXPAND_SZ`），
 * 而 PowerShell 的 `Get-ItemProperty` 会隐式展开并附带 `PSPath` 等元数据。
 * 保留类型是必须的：把 `REG_EXPAND_SZ` 写回成 `REG_SZ` 会破坏
 * `%USERPROFILE%` 这类引用。
 *
 * ⚠️ 注意：`reg.exe` 的输出是**控制台代码页**编码（本机实测 GBK 系），
 * 所以解码必须走 `cmd /c chcp 65001` 或按 UTF-8 宽松解码。见 `decodeRegOutput`。
 *
 * @module dsh-environment-tray/registry
 */

import type { CompositeVariable, EnvironmentModel } from './types'

/** `reg.exe query` 输出里解析出的一条值。 */
export interface RegistryValue {
  /** 变量名；`(Default)` 已归一为空串。 */
  name: string
  /** 注册表原始类型（`REG_SZ` / `REG_EXPAND_SZ` …）；白名单外的类型已被丢弃。 */
  type: string
  /** 原始数据文本；`%VAR%` 引用**不会**被展开。 */
  value: string
}

/** 一次作用域读取的结果。 */
export interface RegistryScopeRead {
  /** 被读取的作用域（原样回传，便于调用方对号入座）。 */
  scope: string
  /** 解析出的值；失败时为空数组。 */
  entries: RegistryValue[]
  /** 失败原因（平台不支持 / 作用域未知 / `reg.exe` 报错）；成功时不出现。 */
  error?: string
}

/** `reg.exe` 执行器：把 stdout 作为**原始字节**返回（同步或异步都可）。 */
export type RegistryRunner = (args: string[]) => Uint8Array | Promise<Uint8Array>

/** `OsEnvironmentLayer` 的依赖。 */
export interface OsEnvironmentLayerOptions {
  /** 执行 `reg.exe` 并把 stdout 作为 Buffer 返回。 */
  run?: RegistryRunner
  /** 平台标识；默认 `process.platform`。 */
  platform?: string
}

/** `write()` 的结果。 */
export interface RegistryWriteResult {
  ok: boolean
  /** 实际写入的类型（未知类型已降级为 `REG_SZ`）。 */
  type?: string
  error?: string
}

/** 被删除的原值 —— 删除注册表值没有回收站，这是撤销的唯一依据。 */
export interface RegistryRemovedValue {
  name: string
  value: string
  type: string
}

/** `remove()` 的结果。 */
export interface RegistryRemoveResult {
  ok: boolean
  /** 被删掉的原值与类型，供 UI 撤销。 */
  removed?: RegistryRemovedValue
  /** 读不到原值时如实报告"没有备份"。 */
  backupUnavailable?: boolean
  error?: string
}

/**
 * `readOne()` 的结果。
 *
 * 写成可辨识联合是刻意的：`found` 为 true 时**一定有**完整原值，调用方
 * （`remove()` 的备份路径）据此收窄，不需要任何断言。
 */
export type RegistryOneRead =
  | { found: true; name: string; value: string; type: string }
  | { found: false; error?: string }

/** `mergePath()` 的结果。 */
export interface PathMerge {
  /** 合并后的 PATH 文本（**系统段在前**）。 */
  combined: string
  /** 参与合并的层，按拼接顺序。 */
  order: string[]
}

/** 用户级作用域：优先级更高。 */
export const USER_SCOPE = 'os-user'

/** 系统级作用域。 */
export const MACHINE_SCOPE = 'os-machine'

/** 注册表路径。 */
const KEYS: Readonly<Partial<Record<string, string>>> = {
  [USER_SCOPE]: 'HKCU\\Environment',
  [MACHINE_SCOPE]: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
}

/**
 * `readAll()` 的结果：两个作用域各一份。
 *
 * 键直接取自上面两个作用域常量，避免调用方再手写一遍字符串字面量。
 */
export type OsScopeReads = Record<typeof USER_SCOPE | typeof MACHINE_SCOPE, RegistryScopeRead>

/** `reg.exe` 报告的类型 → 我们的规范化类型。 */
const VALUE_TYPES = new Set([
  'REG_SZ',
  'REG_EXPAND_SZ',
  'REG_MULTI_SZ',
  'REG_DWORD',
  'REG_QWORD',
  'REG_BINARY',
  'REG_NONE',
])

/**
 * 宽松解码 `reg.exe` 输出。
 *
 * `reg.exe` 写的是控制台代码页（中文 Windows 上是 GBK），而 Node 默认按 UTF-8
 * 解。`TextDecoder` 的 `fatal: false` 会把无法解释的字节替换成 U+FFFD 而**不抛错**，
 * 所以能拿到可用的 ASCII 部分（类型名与变量名都是 ASCII），代价是非 ASCII 的
 * **值**可能带替换字符。这是已知限制，不是可以悄悄忽略的问题：UI 展示注册表里
 * 的非 ASCII 值时应标注可能不精确。
 *
 * @param buffer - 原始字节。
 * @returns 解码后的文本。
 */
export function decodeRegOutput(buffer: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

/**
 * 把注册表键路径规范化成可比形式。
 *
 * **这是必须的**：`reg query` 接受缩写根（`HKCU\Environment`），但**输出用全名**
 * （`HKEY_CURRENT_USER\Environment`）。不统一两者，scope 判断永远匹配不上，
 * 表现为"解析出 0 个值"这个极具误导性的症状（实测踩过）。
 *
 * @param path - 键路径或输出里的键头。
 * @returns 统一为全名 + 大写的形式。
 */
export function normalizeKeyPath(path: string): string {
  return String(path)
    .trim()
    .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    .toUpperCase()
}

/**
 * 解析 `reg.exe query` 的输出。
 *
 * 输出形如：
 * ```
 * HKEY_CURRENT_USER\Environment
 *     Path    REG_EXPAND_SZ    %USERPROFILE%\bin
 *     TEMP    REG_SZ    C:\Users\x\AppData\Local\Temp
 * ```
 * 子键块（`...\Environment\SubKey` 后面跟自己的值）要被跳过，只取本键的值。
 * `(Default)` 是默认值的显示形式，正式名称为空串。
 *
 * @param text - 解码后的输出。
 * @param keyPath - 被查询的键路径（可用缩写根），用于区分本键与其子键。
 * @returns `{ name, type, value }` 数组。
 */
export function parseRegQuery(text: string, keyPath: string): RegistryValue[] {
  const out: RegistryValue[] = []
  const lines = text.split(/\r?\n/)
  const wantKey = normalizeKeyPath(keyPath)
  let inScope = false

  for (const line of lines) {
    if (line.trim().length === 0) continue

    // 不以空白开头且含反斜杠 → 这是键头
    if (!/^\s/.test(line) && line.includes('\\')) {
      // 只接受**本键**；子键（更长的前缀）会被排除
      inScope = normalizeKeyPath(line) === wantKey
      continue
    }

    if (!inScope) continue

    // 值行：4 空格缩进，名称 4+ 空格 类型 4+ 空格 数据
    const match = /^\s{4}(.*?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line)
    if (match === null) continue

    const rawName = match[1].trim()
    const type = match[2]
    if (!VALUE_TYPES.has(type)) continue

    out.push({
      // `(Default)` 是空名称的显示形式
      name: rawName === '(Default)' ? '' : rawName,
      type,
      value: match[3] ?? '',
    })
  }

  return out
}

/**
 * OS 环境层的读取/写入端口。抽象成类以便测试注入假执行器。
 */
export class OsEnvironmentLayer {
  /** 执行 `reg.exe`；未注入（或平台不支持）时为 undefined。 */
  readonly run: RegistryRunner | undefined

  /** 平台标识；`supported` 的依据之一。 */
  readonly platform: string

  /**
   * @param options - 依赖。
   * @param options.run - 执行 `reg.exe` 并把 stdout 作为 Buffer 返回。
   * @param options.platform - 平台标识；默认 `process.platform`。
   */
  constructor(options: OsEnvironmentLayerOptions = {}) {
    this.run = options.run
    this.platform = options.platform ?? process.platform
  }

  /**
   * 本平台是否支持读写 OS 环境层。
   *
   * Linux 与 macOS **没有**单一可靠的写入点（见设计文档 §2.2 / §2.3：
   * macOS GUI 启动的应用读 launchd 而非 shell profile，而 `launchctl setenv`
   * 不持久；Linux 的 `environment.d` 只影响 systemd 用户会话）。
   * 所以这里如实报告"不支持"，而不是假装读写成功。
   *
   * @returns 支持时为 true。
   */
  get supported(): boolean {
    return this.platform === 'win32' && typeof this.run === 'function'
  }

  /**
   * 读取一个作用域的全部值。
   *
   * @param scope - `os-user` 或 `os-machine`。
   * @returns `{ scope, entries, error }`；失败时 `entries` 为空并带 `error`。
   */
  async read(scope: string): Promise<RegistryScopeRead> {
    // `supported` 已经蕴含"`run` 存在"（见 getter），并列判断一次只是为了
    // 让 TS 把它收窄成函数类型：属性访问不会跨 getter 收窄。语义完全一致。
    const run = this.run
    if (!this.supported || run === undefined) {
      return { scope, entries: [], error: 'unsupported-platform' }
    }
    const keyPath = KEYS[scope]
    if (keyPath === undefined) {
      return { scope, entries: [], error: 'unknown-scope' }
    }

    let stdout: Uint8Array
    try {
      stdout = await run(['query', keyPath])
    } catch (error) {
      // 最常见的失败是权限（读 HKLM 一般可以，写才需要提权）
      return { scope, entries: [], error: errorText(error) }
    }

    return { scope, entries: parseRegQuery(decodeRegOutput(stdout), keyPath) }
  }

  /**
   * 读取两个作用域。
   *
   * @returns `{ 'os-user': [...], 'os-machine': [...] }`。
   */
  async readAll(): Promise<OsScopeReads> {
    const [user, machine] = await Promise.all([this.read(USER_SCOPE), this.read(MACHINE_SCOPE)])
    return { [USER_SCOPE]: user, [MACHINE_SCOPE]: machine }
  }

  /**
   * 写一个值，**保留原有类型**。
   *
   * 为什么必须保留类型：`REG_EXPAND_SZ` 的值含 `%VAR%` 引用，由 Windows 在
   * 进程启动时展开。若写回 `REG_SZ`，`%USERPROFILE%` 就会变成字面量。
   *
   * @param scope - 作用域。
   * @param name - 变量名。
   * @param value - 新值（`REG_EXPAND_SZ` 时应传含 `%VAR%` 的原文）。
   * @param type - 原有类型；省略则按 `REG_SZ` 处理。
   * @returns 写入结果。
   */
  async write(scope: string, name: string, value: string, type = 'REG_SZ'): Promise<RegistryWriteResult> {
    // 同 `read()`：并列判断只为把 `run` 收窄成函数类型。
    const run = this.run
    if (!this.supported || run === undefined) return { ok: false, error: 'unsupported-platform' }
    const keyPath = KEYS[scope]
    if (keyPath === undefined) return { ok: false, error: 'unknown-scope' }

    const effectiveType = VALUE_TYPES.has(type) ? type : 'REG_SZ'
    // DWORD/QWORD 需要 /t 与十进制数据；其余按字符串
    const args = ['add', keyPath, '/v', name, '/t', effectiveType, '/d', String(value), '/f']
    try {
      await run(args)
      return { ok: true, type: effectiveType }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  /**
   * 读取一个作用域里的单个值。
   *
   * 用于"删除前先备份原值"：删除是不可逆的，而 UI 只有摘要（长值被截断），
   * 所以撤销能力必须在**宿主侧**取得完整原值。
   *
   * @param scope - 作用域。
   * @param name - 变量名。
   * @returns `{ found, value?, type? }`。
   */
  async readOne(scope: string, name: string): Promise<RegistryOneRead> {
    const all = await this.read(scope)
    if (all.error !== undefined) return { found: false, error: all.error }
    // Windows 注册表名不区分大小写
    const want = process.platform === 'win32' ? name.toUpperCase() : name
    const hit = all.entries.find((e) =>
      (process.platform === 'win32' ? e.name.toUpperCase() : e.name) === want,
    )
    return hit === undefined ? { found: false } : { found: true, name: hit.name, value: hit.value, type: hit.type }
  }

  /**
   * 删除一个值，并**返回被删的原值与类型**以便撤销。
   *
   * 删除注册表值没有回收站。返回原值是让 UI 至少能提供"撤销"的唯一途径。
   *
   * @param scope - 作用域。
   * @param name - 变量名。
   * @returns `{ ok, removed? }`；`removed` 含 `{ name, value, type }`。
   */
  async remove(scope: string, name: string): Promise<RegistryRemoveResult> {
    // 同 `read()`：并列判断只为把 `run` 收窄成函数类型。
    const run = this.run
    if (!this.supported || run === undefined) return { ok: false, error: 'unsupported-platform' }
    const keyPath = KEYS[scope]
    if (keyPath === undefined) return { ok: false, error: 'unknown-scope' }

    // 先取原值：取不到也继续删（可能是权限只允许写不允许读的极端情况），
    // 但要把"没有备份"这个事实如实报出去
    // 备份读取失败 ⇒ 按"没找到"处理（与原来的 `.catch(() => ({ found: false }))` 同义；
    // 返回类型标注是为了让 TS 保住 `found` 的字面量判别，否则读不到 name/value/type）
    const backup = await this.readOne(scope, name).catch((): RegistryOneRead => ({ found: false }))

    try {
      await run(['delete', keyPath, '/v', name, '/f'])
      return {
        ok: true,
        ...backup.found === true
          ? { removed: { name: backup.name ?? name, value: backup.value, type: backup.type } }
          : { removed: undefined, backupUnavailable: true },
      }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  /**
   * 计算 Windows 的 PATH 合并语义。
   *
   * **系统 PATH 在前**，用户 PATH 追加在后 —— 这是 Windows 上唯一会"两层叠加"
   * 的变量，其他变量都是用户级覆盖系统级。UI 若不显示这个区别，用户在
   * "改了没生效"时会无从判断自己改错了哪一份。
   *
   * @param userPath - 用户级 PATH（可含 `%VAR%`）。
   * @param machinePath - 系统级 PATH。
   * @returns 合并前后的视图。
   */
  static mergePath(userPath?: string, machinePath?: string): PathMerge {
    const hasUser = typeof userPath === 'string' && userPath.length > 0
    const hasMachine = typeof machinePath === 'string' && machinePath.length > 0
    if (!hasUser && !hasMachine) return { combined: '', order: [] }
    // 走到下面两行时对应的 `has*` 必为 true（两个都空的情况上面已经返回），
    // 所以 `?? ''` 不会被取到。加它只是因为 TS 无法把别名条件
    // （`const hasMachine = typeof machinePath === 'string' && …`）的收窄结论
    // 带进这两个分支 —— 不加就通不过类型检查。
    if (!hasUser) return { combined: machinePath ?? '', order: ['os-machine'] }
    if (!hasMachine) return { combined: userPath ?? '', order: ['os-user'] }
    return { combined: `${machinePath};${userPath}`, order: ['os-machine', 'os-user'] }
  }
}

/**
 * 把 OS 层的值合并进复合环境模型。
 *
 * 作为**额外层**加入：`os-user` 与 `os-machine` 在信任顺序上低于 `process`
 * （因为进程启动时已经继承了它们），但在展示上必须与 `project-env` /
 * `user-env` 并列，否则用户看不出"注册表里设了但被进程遮蔽"。
 *
 * @param model - `buildEnvironmentModel()` 的结果。
 * @param osLayers - `readAll()` 的结果。
 * @returns 新的变量数组（不修改入参）。
 */
export function mergeOsLayers(model: EnvironmentModel, osLayers: Partial<OsScopeReads>): CompositeVariable[] {
  const byName = new Map<string, CompositeVariable>()
  for (const variable of model.variables) {
    byName.set(variable.name, { ...variable, layers: [...variable.layers] })
  }

  /** Windows 上名字大小写不敏感。 */
  const fold = (name: string): string => (process.platform === 'win32' ? name.toUpperCase() : name)
  const folded = new Map<string, CompositeVariable>()
  for (const [name, entry] of byName) folded.set(fold(name), entry)

  const addLayer = (scope: string, entries: readonly RegistryValue[] | undefined): void => {
    for (const raw of entries ?? []) {
      if (raw.name.length === 0) continue
      const key = fold(raw.name)
      let entry = folded.get(key)
      if (entry === undefined) {
        entry = {
          name: raw.name,
          layers: [],
          effective: undefined,
          shadowed: false,
          forbidden: false,
          sensitive: /KEY|PASSWORD|SECRET|TOKEN/i.test(raw.name),
          runtimeManaged: raw.name.toUpperCase().startsWith('DSH_'),
        }
        folded.set(key, entry)
        byName.set(raw.name, entry)
      }
      // 已存在同层就不覆盖
      if (entry.layers.some((l) => l.layer === scope)) continue
      entry.layers.push({
        layer: scope,
        value: raw.value,
        registryType: raw.type,
        // 注册表可写；写 HKLM 需要提权，这一层由调用方转述
        writable: true,
        ...scope === MACHINE_SCOPE ? { requiresElevation: true } : {},
      })
    }
  }

  addLayer(USER_SCOPE, osLayers[USER_SCOPE]?.entries)
  addLayer(MACHINE_SCOPE, osLayers[MACHINE_SCOPE]?.entries)

  // 重算生效层与遮蔽标记（顺序与 SOURCE_ORDER 一致：process 最高）
  const order = ['process', 'project-env', 'user-env', USER_SCOPE, MACHINE_SCOPE]
  const variables: CompositeVariable[] = []
  for (const entry of byName.values()) {
    entry.layers.sort((a, b) => order.indexOf(a.layer) - order.indexOf(b.layer))
    entry.effective = entry.layers[0]?.layer
    entry.shadowed = entry.layers.length > 1
    entry.layerCount = entry.layers.length
    variables.push(entry)
  }

  variables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return variables
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
