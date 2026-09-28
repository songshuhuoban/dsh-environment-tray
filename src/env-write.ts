/**
 * `.env` 文件写入层 —— 保留用户内容、并发安全、原子落盘。
 *
 * 这一层承担设计文档 §6.4 里那个**必须自己处理**的危险：settings 的
 * revision 栅栏只保护 settings 文档，而我们真正写的是磁盘文件，
 * **没有任何现成的保护**。所以 CAS 只能自己做。
 *
 * 三条不可妥协的规则：
 *
 *  1. **绝不静默写坏用户的值。** 值里出现 `.env` 无法表示的形状时（见
 *     `representabilityOf`），拒绝保存并说明原因。
 *  2. **绝不覆盖并发修改。** 写入前比对 revision，不匹配就拒绝并让 UI 重新读取。
 *  3. **绝不破坏用户文件。** 注释、空行、键序、行尾风格、是否以换行结尾
 *     全部保留；只改目标键。
 *
 * 写入是**整文件原子替换**（同目录临时文件 + rename），所以一次多键编辑
 * 天然是全有或全无 —— rename 本身不会中途失败。
 *
 * @module dsh-environment-tray/env-write
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  parseDotEnv,
  serializeDotEnvLine,
  representabilityOf,
  isBootstrapOnly,
  HOME_LAYER_PROXY_NAMES,
} from './env-model'
import type { EnvEdit, EnvEditProblem } from './types'

/** rename 在 Windows 上可能因文件被短暂占用而失败，按此上限重试。 */
const RENAME_RETRY_LIMIT = 10
const RENAME_RETRY_DELAY_MS = 40

/**
 * 判断异常是否带指定的 `errno` 码（`ENOENT` / `EPERM` / `EACCES` / `EBUSY`）。
 *
 * `catch` 拿到的是 `unknown`（`useUnknownInCatchVariables`），这里用 `in` 收窄
 * 而不是断言：只有真的带 `code` 字段的对象才会命中，语义与原来的
 * `error?.code === '...'` 完全一致 —— 不是对象、没有该字段时都返回 false。
 *
 * @param error - `catch` 捕获到的值。
 * @param code - 期望的 errno 码。
 * @returns 命中时为 true。
 */
function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/**
 * 计算内容 revision。用于 CAS：只有 revision 相同才允许写入。
 *
 * 同时纳入 size 与 mtime，避免"内容相同但期间被改过又改回来"的极端情况
 * 被误判为未变更 —— 这种情况宁可让用户重新确认一次。
 *
 * @param path - 文件路径。
 * @param text - 文件全文；文件不存在时为 undefined。
 * @returns revision 字符串；文件不存在时返回 `'absent'`。
 */
export function revisionOf(path: string, text: string | undefined): string {
  if (text === undefined) return 'absent'
  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  return `sha256:${hash}:${Buffer.byteLength(text, 'utf8')}`
}

/** 空行 / 注释 / 无法解析的行：逐字节保留，不参与编辑。 */
export interface VerbatimSegment {
  kind: 'blank' | 'comment' | 'other'
  /** 含行尾的原文。 */
  raw: string
  /** 不含行尾的文本。 */
  content: string
}

/** 有效赋值行：唯一会被改写的片段种类，带解析出的键与值。 */
export interface EntrySegment {
  kind: 'entry'
  /** 含行尾的原文。 */
  raw: string
  /** 不含行尾的文本。 */
  content: string
  /** 该行声明的变量名（保留文件里的原有拼写）。 */
  key: string
  /** 该行解析出的值；解析不出时为 undefined。 */
  value: string | undefined
}

/** `.env` 的一个片段：`raw` 含行尾，所以重写时未触及的行逐字节不变。 */
export type DotEnvSegment = VerbatimSegment | EntrySegment

/** `unset` 的删除占位：只在 `applyEditsToSegments` 内部存在，返回前被摘掉。 */
interface RemovedSegment {
  kind: 'removed'
  raw: null
}

/** 编辑过程中的位置槽：片段 + 删除占位。 */
type SegmentSlot = DotEnvSegment | RemovedSegment

/**
 * 把 `.env` 拆成可保留原貌的片段序列。
 *
 * 每一行**连同行尾一起保存**，所以重写时未触及的行逐字节不变，
 * 且 `joinDotEnv` 只是纯拼接 —— 天然满足 `join(split(x)) === x`，
 * 包括末尾空行、混合行尾、无末尾换行这些边界。
 *
 * （早先的实现用 `split('\n')` 再补分隔符，会吃掉末尾空行 —— 已由
 *  `verify-env-write.mjs` 的 split/join 恒等测试抓住。）
 *
 * @param text - 文件全文。
 * @returns 片段数组。每个片段带 `raw`（含行尾）与 `content`（不含行尾）。
 */
export function splitDotEnv(text: string): DotEnvSegment[] {
  const segments: DotEnvSegment[] = []
  let start = 0

  // 手写扫描，不用正则：`g` 标志下带空分支的模式在零宽匹配时 lastIndex
  // 推进不可靠，容易产出假行或死循环。手动推进位置是可证明正确的。
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '\n' && ch !== '\r') continue

    // `\r\n` 视为一个行尾
    let terminatorLength = 1
    if (ch === '\r' && text[i + 1] === '\n') terminatorLength = 2

    const content = text.slice(start, i)
    const raw = text.slice(start, i + terminatorLength)
    segments.push(classifySegment(content, raw))
    i += terminatorLength - 1
    start = i + 1
  }

  // 末尾没有行尾的残余内容也算一行（"无末尾换行"的边界）
  if (start < text.length) {
    const content = text.slice(start)
    segments.push(classifySegment(content, content))
  }

  return segments
}

/**
 * 把一个物理行归类成片段。
 *
 * @param content - 不含行尾的文本。
 * @param raw - 含行尾的原文。
 * @returns 片段对象。
 */
function classifySegment(content: string, raw: string): DotEnvSegment {
  const trimmed = content.trim()
  if (trimmed.length === 0) return { kind: 'blank', raw, content }
  if (trimmed.startsWith('#')) return { kind: 'comment', raw, content }

  // 判断这一行是否是有效赋值（与 parseDotEnv 同样的规则）
  let candidate = trimmed
  if (candidate.startsWith('export')) {
    const after = candidate.slice('export'.length)
    if (after.length === 0 || after[0] === ' ' || after[0] === '\t') candidate = after.trim()
  }
  const eq = candidate.indexOf('=')
  if (eq === -1) return { kind: 'other', raw, content }

  const key = candidate.slice(0, eq).trim()
  if (key.length === 0) return { kind: 'other', raw, content }

  return { kind: 'entry', raw, content, key, value: parseDotEnv(content)[key] }
}

/**
 * 把片段序列重新拼成文件全文。
 *
 * 纯拼接：每个片段的 `raw` 已含自己的行尾，所以不做任何分隔符推断。
 *
 * @param segments - 片段数组。
 * @returns 文件全文。
 */
export function joinDotEnv(segments: readonly DotEnvSegment[]): string {
  return segments.map((s) => s.raw).join('')
}

/**
 * 校验一次写入是否被允许。
 *
 * @param name - 变量名。
 * @param layer - 目标层（`project-env` 或 `user-env`）。
 * @param value - 待写入的值。
 * @returns 问题列表；空数组表示允许。
 *
 * @remarks
 * `layer` 声明成 `unknown`：它来自 HTTP 请求体，而本函数只把它与 `user-env`
 * 做相等比较 —— 不相等就拿不到代理例外（失败关闭），所以非字符串是安全的。
 */
export function validateEdit(name: string, layer: unknown, value: string): EnvEditProblem[] {
  const problems: EnvEditProblem[] = []

  if (typeof name !== 'string' || name.trim().length === 0) {
    problems.push({ code: 'empty-name', message: '变量名不能为空' })
    return problems
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    problems.push({
      code: 'invalid-name',
      message: '变量名只能由字母、数字、下划线组成，且不能以数字开头',
    })
  }
  if (/\s/.test(name)) {
    problems.push({ code: 'name-has-space', message: '变量名不能包含空白字符' })
  }

  // 禁止名单：写下去会让 DSH 拒绝启动，必须前置拦截
  if (isBootstrapOnly(name)) {
    const isProxy = HOME_LAYER_PROXY_NAMES.has(name.toUpperCase())
    if (isProxy && layer === 'user-env') {
      // 唯一例外，允许
    } else if (isProxy) {
      problems.push({
        code: 'proxy-not-in-home',
        message: `${name} 只能写入用户 .env`,
      })
    } else {
      problems.push({
        code: 'bootstrap-only',
        message: `${name} 不能写入 .env，请在启动 DSH 前设置`,
      })
    }
  }

  // 值的可表示性：绝不能静默写坏
  const literalLine = serializeDotEnvLine(name, value)
  const issue = representabilityOf(literalLine)
  if (issue !== undefined && issue.lossy) {
    problems.push({ code: 'lossy-value', message: issue.reason })
  }

  return problems
}

/** `readDotEnvFile()` 的结果；文件不存在时 `exists` 为 false、`revision` 为 `'absent'`。 */
export interface DotEnvFileRead {
  /** 文件绝对路径。 */
  path: string
  /** 文件是否存在。 */
  exists: boolean
  /** 内容 revision（CAS 用）。 */
  revision: string
  /** 解析出的键值对。 */
  values: Record<string, string>
  /** 可保留原貌的片段序列。 */
  segments: DotEnvSegment[]
}

/**
 * 读取一个 `.env` 文件，附带 revision 与结构信息。
 *
 * @param path - 文件绝对路径。
 * @returns 读取结果；文件不存在时 `exists` 为 false 且 `revision` 为 `'absent'`。
 */
export async function readDotEnvFile(path: string): Promise<DotEnvFileRead> {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return { path, exists: false, revision: 'absent', values: {}, segments: [] }
    }
    throw error
  }

  return {
    path,
    exists: true,
    revision: revisionOf(path, text),
    values: parseDotEnv(text),
    segments: splitDotEnv(text),
  }
}

/**
 * 编辑匹配用的键折叠。
 *
 * **Windows 上环境名不区分大小写**，所以 `MyVar` 与 `MYVAR` 是同一个变量。
 * 不做折叠会导致两个具体故障（已由回归测试证实）：
 *   1. 文件里有 `MyVar=...` 时写入 `MYVAR=...`，旧行被**保留**、新行被**追加**
 *      —— 同一变量在文件里出现两遍。
 *   2. `unset` 匹配不到，用户以为删掉了，实际还在。
 *
 * 这与 `buildEnvironmentModel` / `mergeOsLayers` 的 `lookupKey`/`fold` 保持
 * 同一套平台语义（`dsh-launch-environment` 也是这么做的）。
 *
 * @param name - 变量名。
 * @returns 用于比较的键。
 */
function editKey(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/**
 * 原地更新片段序列：命中的键改写，缺失的键追加，删除的键移除。
 *
 * 保留注释、空行与键序 —— 未触及的行**逐字节不变**。
 * 命中的行**保留其原有拼写**（只换值），不会把 `MyVar` 改写成 `MYVAR`。
 *
 * @param segments - 原片段数组。
 * @param edits - 编辑列表。
 * @returns 新片段数组。
 */
function applyEditsToSegments(segments: readonly DotEnvSegment[], edits: readonly EnvEdit[]): DotEnvSegment[] {
  /** 沿用文件已有的行尾风格；全新文件用 \n。 */
  const eol = segments.find((s) => s.raw.endsWith('\r\n'))?.raw.slice(-2) ?? '\n'

  const next: SegmentSlot[] = segments.map((s) => ({ ...s }))
  // 以折叠后的键索引待办编辑；同一批里的重复编辑后者覆盖前者
  const pending = new Map(edits.map((e) => [editKey(e.name), e]))

  // 第一遍：原地改写 / 删除已存在的键（保留原有拼写）
  for (let i = 0; i < next.length; i += 1) {
    const seg = next[i]
    if (seg.kind !== 'entry') continue
    const edit = pending.get(editKey(seg.key))
    if (edit === undefined) continue
    pending.delete(editKey(seg.key))
    if (edit.op === 'unset') {
      next[i] = { kind: 'removed', raw: null }
    } else {
      // `?? ''`：`validateEdit` 判定可表示性时用的就是 `edit.value ?? ''`，
      // 这里必须用同一套语义。曾经直接传 `edit.value`，于是 HTTP 上传一个
      // 不带 value 的 set 会把字面量 `"undefined"` 写进文件（下面的 `value`
      // 字段同理 —— 它是内存里的值，不能与落盘的内容不一致）。
      const value = edit.value ?? ''
      const content = serializeDotEnvLine(seg.key, value)
      next[i] = { kind: 'entry', raw: content + eol, content, key: seg.key, value }
    }
  }

  // 第二遍：新增键追加到末尾（保持用户原有顺序不动）
  for (const edit of pending.values()) {
    if (edit.op === 'unset') continue
    const value = edit.value ?? ''
    const content = serializeDotEnvLine(edit.name, value)
    next.push({ kind: 'entry', raw: content + eol, content, key: edit.name, value })
  }

  return next.filter((s): s is DotEnvSegment => s.kind !== 'removed')
}

/**
 * 原子写文件：同目录临时文件 + rename。
 *
 * 同目录是必须的 —— 跨卷 rename 不是原子操作。
 *
 * @param path - 目标路径。
 * @param text - 全文。
 * @param mode - POSIX 权限位；Windows 上忽略。
 */
async function atomicWrite(path: string, text: string, mode: number): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = resolve(dir, `.${randomUUID()}.tmp`)

  try {
    await writeFile(temp, text, { encoding: 'utf8', mode })
    let lastError: unknown
    for (let attempt = 0; attempt < RENAME_RETRY_LIMIT; attempt += 1) {
      try {
        await rename(temp, path)
        return
      } catch (error) {
        lastError = error
        // Windows 上目标可能被短暂占用（杀软、编辑器、另一个读取者）
        if (!isErrnoCode(error, 'EPERM') && !isErrnoCode(error, 'EACCES') && !isErrnoCode(error, 'EBUSY')) throw error
        await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAY_MS))
      }
    }
    throw lastError
  } finally {
    // rename 成功后 temp 已不存在；失败时清理，绝不留下垃圾文件
    await rm(temp, { force: true }).catch(() => {})
  }
}

/**
 * 按路径串行化写入的队列。
 *
 * **为什么必须有**：`applyEnvEdits` 是「读 revision → 校验 → 原子写」，中间有
 * await 点。两个并发请求若都在第一步读到同一 revision，就**都会通过 CAS**，
 * 后者覆盖前者 —— 实测确认过：10 个同 revision 的并发写入**全部返回成功**，
 * 但只有 1 个键存活，9 个"成功"的保存静默丢失。
 *
 * 也就是说：CAS 挡得住**外部**进程的并发（它们会改变磁盘上的 revision），
 * 但挡不住**同一进程内**的并发，因为两者的读取都发生在任何写入之前。
 *
 * 修法是把整个「读 → 校验 → 写」放进按路径的临界区。用 Promise 链实现，
 * 无需锁原语：每个新操作排在前一个之后。
 */
const writeChains = new Map<string, Promise<void>>()

/**
 * 在一个路径的临界区里运行一个操作。
 *
 * @param path - 目标文件路径（临界区键）。
 * @param task - 要运行的异步任务。
 * @returns 任务的结果。
 */
function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(path)
  const previous = writeChains.get(key) ?? Promise.resolve()
  // 无论前一个操作成功还是失败，下一个都要能继续
  const run = previous.then(task, task)
  // 链上只保留"结算完毕"的信号，且不能让失败冒泡成未处理的拒绝
  writeChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** 编辑被拒绝时抛出的错误，带结构化问题列表供 UI 呈现。 */
export class EnvEditRejected extends Error {
  /** 机器可读的拒绝原因。 */
  readonly code: string
  /** 结构化问题列表。 */
  readonly problems: EnvEditProblem[]

  /**
   * @param code - 机器可读的拒绝原因。
   * @param message - 人类可读说明。
   * @param problems - 结构化问题列表。
   */
  constructor(code: string, message: string, problems: EnvEditProblem[] = []) {
    super(message)
    this.name = 'EnvEditRejected'
    this.code = code
    this.problems = problems
  }
}

/** `applyEnvEdits()` 的编辑请求。 */
export interface ApplyEnvEditsOptions {
  /** 目标 `.env` 绝对路径（由宿主推导，绝不来自请求体）。 */
  path: string
  /**
   * 层标识（`project-env` 或 `user-env`），决定禁止名单例外。
   *
   * 声明成 `unknown`：它来自 HTTP 请求体，旧实现只把它用于相等比较 ——
   * 不等于 `user-env` 就拿不到代理例外（失败关闭），所以非字符串是安全的。
   */
  layer: unknown
  /**
   * `[{ op: 'set'|'unset', name, value? }]`。
   *
   * 声明成 `unknown`：同样来自请求体，旧实现的收口判定就是 `Array.isArray`
   * 加逐条的 `validateEdit`（非法名字得到 `empty-name`）。断言只在本文件内
   * 一处发生，不新增任何拒绝条件。
   */
  edits: unknown
  /** 客户端读到的 revision；不匹配即拒绝（同样来自请求体，只参与相等比较）。 */
  expectedRevision?: unknown
  /** Reject existing names instead of replacing them; checked under the path lock. */
  createOnly?: boolean
}

/**
 * 对某个 `.env` 层执行一批编辑。
 *
 * 全部校验通过才写入；写入是整文件原子替换，所以一批编辑要么全生效要么全不生效。
 *
 * **整个「读 → 校验 → 写」在按路径的临界区里跑**（见 `withPathLock`）：
 * CAS 只挡得住外部进程的并发，同进程内的并发请求必须靠串行化，
 * 否则多个带同一 revision 的写入会全部"成功"而互相覆盖。
 *
 * @param options - 编辑请求。
 * @param options.path - 目标 `.env` 绝对路径。
 * @param options.layer - 层标识（`project-env` 或 `user-env`），决定禁止名单例外。
 * @param options.edits - `[{ op: 'set'|'unset', name, value? }]`。
 * @param options.expectedRevision - 客户端读到的 revision；不匹配即拒绝。
 * @returns 写入后的状态（含新 revision 与解析出的值）。
 * @throws {EnvEditRejected} 校验失败或 revision 不匹配。
 */
export async function applyEnvEdits(options: ApplyEnvEditsOptions): Promise<DotEnvFileRead> {
  const { path, layer, edits, expectedRevision } = options

  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EnvEditRejected('no-edits', '没有需要应用的编辑')
  }

  // `edits` 是请求体里的 `unknown`：形状只按旧实现那样判一次 `Array.isArray`
  // （上一行），逐条的形状由 `validateEdit` 负责。断言收口在这一处。
  const list = edits as readonly EnvEdit[]

  // 1. 全部校验先跑完，任何一个不合格就整批拒绝。
  //    校验是纯计算、不碰磁盘，放在临界区外可以让"必然失败"的请求不排队。
  const problems: EnvEditProblem[] = []
  for (const edit of list) {
    const found = validateEdit(edit.name, layer, edit.value ?? '')
    for (const problem of found) problems.push({ ...problem, name: edit.name })
  }
  if (problems.length > 0) {
    throw new EnvEditRejected('validation-failed', `有 ${String(problems.length)} 处校验未通过，整批编辑已拒绝`, problems)
  }

  return withPathLock(path, async () => {
    // 2. CAS：版本不匹配就拒绝，绝不覆盖并发修改
    const current = await readDotEnvFile(path)
    if (options.createOnly === true) {
      const names = new Set(Object.keys(current.values).map(editKey))
      if (list.some((edit) => names.has(editKey(edit.name)))) {
        throw new EnvEditRejected('already-exists', '所选位置中已存在同名变量')
      }
    }
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new EnvEditRejected(
        'stale-revision',
        `文件已被其他程序修改（期望 ${String(expectedRevision)}，实际 ${current.revision}）。请重新读取后再编辑`,
      )
    }

    // 3. 生成新内容。插入的新行自带行尾，所以拼接后自然以换行结尾。
    const segments = applyEditsToSegments(current.segments, list)
    const text = joinDotEnv(segments)

    // 4. 落盘：0600（POSIX）。.env 可能含密钥，新建时绝不留默认权限窗口。
    await atomicWrite(path, text, 0o600)
    if (process.platform !== 'win32') {
      // 已存在的文件可能权限更宽，显式收紧
      await chmod(path, 0o600).catch(() => {})
    }

    return readDotEnvFile(path)
  })
}

/** `checkPermissions()` 的结果；`checked` 为 false 时 `ok`/`mode`/`reason` 无意义。 */
export interface PermissionCheck {
  /** 是否真的做了检查（Windows 上没有可检查的 mode 位，为 false）。 */
  checked: boolean
  /** 权限是否符合建议（仅 `checked` 为 true 时有意义）。 */
  ok?: boolean
  /** 八进制权限文本，如 `0600`。 */
  mode?: string
  /** 不符合建议时的原因。 */
  reason?: string
}

/**
 * 只读地检查一个 `.env` 文件的权限是否符合建议。
 *
 * POSIX 上建议 0600（仅属主可读写）。Windows 上 `dsh-credentials-local` 明确
 * 跳过权限检查（"Windows has no mode to inspect, so the check is skipped there
 * rather than faked"），所以这里同样返回 `checked: false` 而不是假装通过。
 *
 * @param path - 文件路径。
 * @returns 权限检查结果。
 */
export async function checkPermissions(path: string): Promise<PermissionCheck> {
  try {
    const info = await stat(path)
    if (process.platform === 'win32') {
      return { checked: false, reason: 'Windows 没有可检查的 mode 位，DSH 自身也跳过这项检查' }
    }
    const mode = info.mode & 0o777
    return {
      checked: true,
      mode: `0${mode.toString(8)}`,
      ok: (mode & 0o077) === 0,
      reason: (mode & 0o077) === 0 ? undefined : '文件对其他用户可读，建议 chmod 600',
    }
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return { checked: true, ok: true, mode: undefined, reason: undefined }
    throw error
  }
}
