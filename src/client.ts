/**
 * 客户端半边 — 在 Settings → Plugins 分区注册「环境变量」页签。
 *
 * 这里是**源码**。DSH 运行时要求客户端插件是**惰性 CJS 工厂**：宿主半边扫到
 * `package.json` 的 `dsh.client` 声明后提供 `/plugins/<id>/client.js`，浏览器端由
 * `window.__ModuleLoader__.load({ id, factory })` 注册工厂，工厂体只在**首次
 * materialize** 时执行。那个形状由 `build/client-wrapper.mjs` 在 tsdown 之后生成，
 * 所以本文件写成普通 ESM 即可。
 *
 * 产物里只允许出现 `require("react")` —— 客户端模块解析顺序是「平台种子表 →
 * 记忆化记录 → boot graph 行 → 已注册工厂」，表外说明符会抛错。因此 `react`
 * 由 tsdown 的 `deps.neverBundle` 保留为外部依赖，见 `tsdown.config.ts`。
 *
 * 数据面：`GET /api/env-manager/state`（见 src/host-api.ts）。
 * 写入面：`POST /api/env-manager/env` 与 `/registry`（见 src/write-routes.ts）。
 * 敏感名的值**永远不会到达浏览器** —— 宿主只回长度。
 *
 * @module dsh-env-manager/client
 */

import * as React from 'react'
import {
  Button,
  DisclosureRow,
  IconChevronDownOutline14,
  IconContextInjectionOutline16,
  IconEditOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'

import {
  Empty,
  GroupHeading,
  Key,
  LayerDetail,
  MONO,
  Meta,
  Note,
  Placeholder,
  Row,
  RowActions,
  ScrollArea,
  T,
  Toolbar,
  Value,
  installClientStyles,
} from './client-ui'

const { useState, useEffect, useCallback } = React

const STATE_URL = '/api/env-manager/state'
const ENV_WRITE_URL = '/api/env-manager/env'
const ENV_READ_URL = '/api/env-manager/env/read'
const REGISTRY_URL = '/api/env-manager/registry'
const CREDENTIAL_STATE_URL = '/api/env-manager/credential-state'
const CREDENTIAL_WRITE_URL = '/api/env-manager/credentials'

/* ────────────────────────── 宿主载荷的类型 ──────────────────────────
 *
 * 这里描述的是**宿主真的会回的字段**，对应 `src/host-api.ts` 里的投影对象与
 * `src/write-routes.ts` 的响应。刻意写成"用到的字段 + 可选"而不是精确镜像：
 * 客户端对未知字段必须无感（宿主加字段不能让页签崩），而用到的字段写清楚，
 * 编译器才能盯住 `state.counts.total` 这类路径。
 */

/** 一个变量在某一层里的样子（对应 `ProjectedLayer`）。 */
interface LayerView {
  layer: string
  writable?: boolean
  redacted?: boolean
  valueSummary?: { preview: string; length: number; truncated?: boolean }
  valueLength?: number
  registryType?: string
  requiresElevation?: boolean
  blockedCode?: string
  path?: string
}

/** 一个变量在模型里的样子（对应 `ProjectedVariable`）。 */
interface VariableView {
  name: string
  effective: string
  layers: LayerView[]
  runtimeManaged?: boolean
  shadowed?: boolean
  sensitive?: boolean
  forbidden?: boolean
  layerCount?: number
}

/** `GET /api/env-manager/state` 的响应。 */
interface EnvState {
  cwd: string
  home: string
  counts: { total: number; shadowed: number }
  files: { project?: string; user?: string }
  os?: {
    skipped?: boolean
    supported?: boolean
    scopes?: Record<string, { count?: number; error?: string | null } | undefined>
  }
  warnings?: { code?: string; path?: string; message?: string }[]
  variables?: VariableView[]
  blockedReasonText?: Record<string, string>
}

/** `GET /api/env-manager/credential-state` 里单个引用的描述（**没有值**）。 */
interface CredentialInfoView {
  configured?: boolean
  editable?: boolean
  sourceLabel?: string
  blockedReason?: string
}

/** 一个可撤销的注册表删除（对应 `write-routes.ts` 的 `undo`）。 */
interface UndoRecord {
  name: string
  value: string
  type: string
}

/**
 * 客户端持有的"待撤销删除"状态。
 * - `null` —— 没有待撤销的删除
 * - `'unavailable'` —— 删掉了，但宿主取不到原值
 * - 对象 —— 带上层标识，可用它写回
 */
type Undo = 'unavailable' | (UndoRecord & { scope: string })

/** 写路由的成功/失败响应。 */
interface HostResponse {
  ok?: boolean
  problems?: { name?: string; message?: string }[]
  message?: string
  revision?: string
  path?: string
  keys?: string[]
  undo?: UndoRecord
  /** 允许宿主新增字段而不影响这里。 */
  [key: string]: unknown
}

/** `VariableRow` 的 props。 */
interface VariableRowProps {
  variable: VariableView
  state: EnvState | null
  expanded: boolean
  onToggle: (name: string) => void
  onSaved: () => void
}

/** `CredentialPanel` 的 props。 */
interface CredentialPanelProps {
  names: string[]
  onSaved: () => void
}

/** 输入框 `onChange` 收到的事件（只用到 `target.value`）。 */
type InputChangeEvent = { target: { value: string } }

/**
 * 从 `unknown` 里取可读文案。
 *
 * catch 变量在 `strict` 下是 `unknown`，而原来的写法 `err && err.message ? … : …`
 * 依赖真值判断（空字符串的 message 会退化成 `String(err)`）。这里逐字保留那个
 * 真值语义，只把类型收干净。
 */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return String(error && message ? message : error)
}

/**
 * 密钥候选名的**下限**。
 *
 * 环境里有很多 `KEY`/`TOKEN`/`SECRET` 形状的名字并不是凭据引用（例如
 * `SSL_CERT_FILE`、`WT_SESSION`）。宿主会对每个候选名调 `describe`，
 * 只有真正已配置或被引用的才需要处理，所以候选集宽一点没有坏处 ——
 * 但绝不能把它们当成"已知密钥"来展示，那会制造噪音。
 */
const CREDENTIAL_HINTS = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)($|_)/i

/** 层标识 → 简短标签。 */
const LAYER_LABEL: Record<string, string> = {
  process: '启动环境',
  'project-env': '项目 .env',
  'user-env': '$DSH_HOME/.env',
  credential: '凭据库',
  'os-user': '注册表·用户',
  'os-machine': '注册表·系统',
}

/** 层标识 → 生效时机说明（设计文档 §11 的档位结论）。 */
const LAYER_TIMING: Record<string, string> = {
  process: '🔒 只读',
  'project-env': '🔄 需重启 DSH',
  'user-env': '🔄 需重启 DSH',
  credential: '🟢 立即（DSH 内部）',
  'os-user': '🔄 需重启 DSH',
  'os-machine': '🔄 需重启 DSH',
}

/**
 * 可通过 UI 写入的层 → 写路由目标。
 *
 * 显式标注成 `Record<string, …>`：`targetLayer.layer` 是运行期才知道的字符串，
 * 不给索引签名的话每次下标访问都要报隐式 any。
 */
const WRITABLE_LAYERS: Record<string, { url: string; kind: 'env' | 'registry' }> = {
  'project-env': { url: ENV_WRITE_URL, kind: 'env' },
  'user-env': { url: ENV_WRITE_URL, kind: 'env' },
  'os-user': { url: REGISTRY_URL, kind: 'registry' },
  'os-machine': { url: REGISTRY_URL, kind: 'registry' },
}

/* ────────────────────────── 表现层在别处 ──────────────────────────
 *
 * 排版与样式全部移到 `src/client-ui.ts`。这里原来内联了 40 多个 style 片段，
 * 正文被样式淹没 —— 而那正是"每一类信息都自带一套字号 + 边框 + 颜色"的根源，
 * 也就是界面显得杂乱的机制。现在这一层只管数据流。
 */
/** 把层里的机器可读码翻译成文案（宿主只传一次文案表）。 */
const reasonText = (state: EnvState | null, code: unknown): string =>
  (state && state.blockedReasonText && state.blockedReasonText[String(code)]) || String(code ?? '')

/**
 * 发起一次写请求。
 *
 * 把 HTTP 层的失败翻译成可读消息：`problems` 数组要逐条展示，
 * 因为那正是"为什么不让写"的答案（禁止名单、有损值等）。
 */
async function postJson(url: string, body: unknown): Promise<HostResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: HostResponse
  try {
    parsed = (await res.json()) as HostResponse
  } catch {
    throw new Error(`HTTP ${String(res.status)}（响应不是 JSON）`)
  }
  if (res.ok && parsed.ok === true) return parsed
  const detail = Array.isArray(parsed.problems) && parsed.problems.length > 0
    ? parsed.problems.map((p) => (p.name ? p.name + '：' : '') + String(p.message)).join('；')
    : parsed.message
  throw new Error(detail || `HTTP ${String(res.status)}`)
}

/** 一个变量的摘要行，含就地编辑。 */
function VariableRow(props: VariableRowProps) {
  const { variable, state, expanded, onToggle, onSaved } = props
  const effectiveLayer = variable.layers.find((l) => l.layer === variable.effective)
  const summary = effectiveLayer && effectiveLayer.valueSummary ? effectiveLayer.valueSummary : undefined

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  /**
   * 刚删除的注册表值的备份。
   * `null` = 没有待撤销的删除；`'unavailable'` = 删掉了但宿主取不到原值；
   * 对象 = 可用它撤销。
   */
  const [undo, setUndo] = useState<Undo | null>(null)

  /** 可编辑的层：存在、可写、且我们支持它的写路由。 */
  const targetLayer = variable.layers.find((l) => l.writable && WRITABLE_LAYERS[l.layer] !== undefined)

  const beginEdit = useCallback(() => {
    setError(null)
    setSaved(null)
    // 敏感层不回传值，所以草稿从空开始（用户必须重输）
    setDraft(summary && !effectiveLayer?.redacted ? summary.preview : '')
    setEditing(true)
  }, [summary, effectiveLayer])

  const save = useCallback(async () => {
    if (targetLayer === undefined) return
    setBusy(true)
    setError(null)
    try {
      const target = WRITABLE_LAYERS[targetLayer.layer]
      if (target.kind === 'registry') {
        await postJson(target.url, {
          scope: targetLayer.layer,
          name: variable.name,
          value: draft,
          // 沿用已有类型，避免把 REG_EXPAND_SZ 降级成 REG_SZ（会破坏 %VAR%）
          type: targetLayer.registryType ?? 'REG_SZ',
        })
      } else {
        // `.env` 需要 CAS：先读当前 revision，再带栅栏写入
        const current = await postJson(ENV_READ_URL, { layer: targetLayer.layer })
        await postJson(target.url, {
          layer: targetLayer.layer,
          expectedRevision: current.revision,
          edits: [{ op: 'set', name: variable.name, value: draft }],
        })
      }
      setEditing(false)
      setSaved('已保存')
      if (onSaved) onSaved()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }, [draft, targetLayer, variable.name, onSaved])

  const remove = useCallback(async () => {
    if (targetLayer === undefined) return
    setBusy(true)
    setError(null)
    setUndo(null)
    try {
      const target = WRITABLE_LAYERS[targetLayer.layer]
      if (target.kind === 'registry') {
        const res = await postJson(target.url, { scope: targetLayer.layer, name: variable.name, unset: true })
        // 删除注册表值没有回收站 —— 用宿主回传的原值给用户一个撤销机会
        if (res.undo !== undefined) setUndo({ scope: targetLayer.layer, ...res.undo })
        else setUndo('unavailable')
      } else {
        const current = await postJson(ENV_READ_URL, { layer: targetLayer.layer })
        await postJson(target.url, {
          layer: targetLayer.layer,
          expectedRevision: current.revision,
          edits: [{ op: 'unset', name: variable.name }],
        })
      }
      setSaved('已删除')
      if (onSaved) onSaved()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }, [targetLayer, variable.name, onSaved])

  /** 撤销刚才的注册表删除：把宿主备份的原值与类型写回去。 */
  const undoRemove = useCallback(async () => {
    if (undo === null || undo === 'unavailable') return
    setBusy(true)
    setError(null)
    try {
      await postJson(REGISTRY_URL, {
        scope: undo.scope,
        name: undo.name,
        value: undo.value,
        // 必须沿用原类型：写回 REG_SZ 会破坏 %VAR% 引用
        type: undo.type,
      })
      setUndo(null)
      setSaved('已撤销删除')
      if (onSaved) onSaved()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }, [undo, onSaved])

  // 次要信息拼成**一行注解**，跟在 VALUE 后面。不再用彩色胶囊：胶囊有边框、
  // 有底色、有内边距，视觉重量和 KEY/VALUE 一样，几十行下来就是一片噪音。
  const hidden = summary === undefined && effectiveLayer?.redacted === true
  const lengthHint =
    summary !== undefined && summary.truncated === true
      ? `${String(summary.length)} 字符`
      : hidden
        ? `${String(effectiveLayer?.valueLength ?? 0)} 字符`
        : null

  const meta = React.createElement(Meta, {
    parts: [
      LAYER_LABEL[variable.effective] ?? variable.effective ?? '?',
      variable.shadowed === true ? `遮蔽 ${String(variable.layerCount ?? variable.layers.length)} 层` : null,
      variable.sensitive === true ? 'shell 不可见' : null,
      variable.forbidden === true ? '禁止写入 .env' : null,
      lengthHint,
    ],
  })

  // 值列：宿主不回传值时只回长度，这里用点阵 + 字符数如实表达"有值但看不到"
  const valueText =
    summary !== undefined
      ? summary.preview
      : hidden
        ? null
        : effectiveLayer?.valueLength !== undefined
          ? `(${String(effectiveLayer.valueLength)} 字符)`
          : null

  const value = React.createElement(Value, {
    masked: hidden,
    title:
      summary === undefined
        ? hidden
          ? '宿主从不回传密钥值'
          : undefined
        : `${summary.preview}${summary.truncated === true ? ` …（共 ${String(summary.length)} 字符）` : ''}`,
    children: valueText,
  })

  // 行尾操作：只在悬停/聚焦时出现（见 client-ui.ts 里注入的那张样式表）
  const rowActions = React.createElement(
    RowActions,
    null,
    targetLayer === undefined || editing
      ? null
      : React.createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          icon: React.createElement(IconEditOutline16, null),
          title: '编辑这一项',
          'aria-label': '编辑',
          disabled: busy,
          onClick: beginEdit,
        }),
    variable.shadowed === true
      ? React.createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          icon: React.createElement(IconChevronDownOutline14, null),
          title: expanded ? '收起各层' : '展开各层',
          'aria-label': expanded ? '收起各层' : '展开各层',
          onClick: () => onToggle(variable.name),
        })
      : null,
  )

  return React.createElement(
    'div',
    { style: { paddingBottom: '1px' } },
    React.createElement(
      Row,
      { active: editing || expanded },
      React.createElement(Key, { title: variable.name }, variable.name),
      value,
      React.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'baseline', gap: '8px' } },
        meta,
        rowActions,
      ),
    ),

    // ── 就地编辑 ─────────────────────────────────────────────────────────
    editing && targetLayer !== undefined
      ? React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 8px 6px' } },
          React.createElement(
            'span',
            { style: { ...T.meta, whiteSpace: 'nowrap' } },
            `写入「${LAYER_LABEL[targetLayer.layer] ?? targetLayer.layer}」`,
          ),
          React.createElement(Input, {
            value: draft,
            autoFocus: true,
            placeholder: '新值',
            style: { flex: 1, fontFamily: MONO, fontSize: '12px' },
            onChange: (e: InputChangeEvent) => setDraft(e.target.value),
          }),
          React.createElement(
            Button,
            { variant: 'outline', size: 'sm', disabled: busy, onClick: save },
            busy ? '保存中' : '保存',
          ),
          React.createElement(
            Button,
            { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => setEditing(false) },
            '取消',
          ),
          React.createElement(Button, {
            variant: 'ghost',
            size: 'sm',
            icon: React.createElement(IconTrashOutline16, null),
            title: '删除这一项',
            'aria-label': '删除',
            disabled: busy,
            onClick: remove,
          }),
          React.createElement(
            'span',
            { style: { ...T.meta, whiteSpace: 'nowrap' } },
            LAYER_TIMING[targetLayer.layer] ?? '',
          ),
        )
      : null,

    // ── 结果与撤销 ───────────────────────────────────────────────────────
    error !== null ? React.createElement(Note, null, `保存失败：${error}`) : null,
    saved !== null
      ? React.createElement(
          Note,
          null,
          `${saved}${targetLayer === undefined ? '' : `（${LAYER_TIMING[targetLayer.layer] ?? ''}）`}`,
        )
      : null,
    undo === 'unavailable'
      ? React.createElement(Note, null, '已删除；宿主未能取得原值，无法撤销。')
      : undo !== null
        ? React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 8px 4px' } },
            React.createElement('span', { style: T.meta }, `已删除（原类型 ${undo.type}）`),
            React.createElement(
              Button,
              { variant: 'ghost', size: 'sm', disabled: busy, onClick: undoRemove },
              busy ? '恢复中' : '撤销删除',
            ),
          )
        : null,

    // ── 各层细节 ─────────────────────────────────────────────────────────
    expanded
      ? React.createElement(LayerDetail, {
          rows: variable.layers.map((layer) => ({
            name: LAYER_LABEL[layer.layer] ?? layer.layer,
            facts: [
              layer.layer === variable.effective ? '【生效】' : '（被遮蔽）',
              layer.writable === true ? '可写' : '不可写',
              LAYER_TIMING[layer.layer] ?? '',
              layer.registryType ?? '',
              layer.requiresElevation === true ? '需管理员权限' : '',
              layer.blockedCode === undefined ? '' : `— ${reasonText(state, layer.blockedCode)}`,
              layer.path ?? '',
            ]
              .filter((part) => part.length > 0)
              .join('  '),
          })),
        })
      : null,
  )
}
/**
 * 密钥面板。
 *
 * 与其他层的关键差别：**宿主永远不回传值**，所以草稿从**空**开始，
 * 界面只能表达"已配置 / 未配置 / 被遮蔽"。这不是 UI 的保守选择，
 * 而是 `dsh-credentials` 的契约（`describe()` 的返回类型没有可以搭载值的
 * 位置）。任何"显示已存密钥"的界面都必然违反该契约。
 */
function CredentialPanel(props: CredentialPanelProps) {
  const { names, onSaved } = props
  const [status, setStatus] = useState<Record<string, CredentialInfoView> | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  const key = names.join(',')

  const load = useCallback(() => {
    if (names.length === 0) {
      setStatus({})
      return
    }
    setError(null)
    fetch(CREDENTIAL_STATE_URL + '?refs=' + encodeURIComponent(key))
      .then((res) => res.json())
      .then((body) => {
        setAvailable(body.available === true)
        setStatus(body.refs || {})
      })
      .catch((err) => setError(messageOf(err)))
  }, [key, names.length])

  useEffect(() => {
    load()
  }, [load])

  const save = useCallback(async () => {
    if (editing === null) return
    setBusy(true)
    setFeedback(null)
    try {
      await postJson(CREDENTIAL_WRITE_URL, { ref: editing, value: draft })
      setEditing(null)
      setDraft('')
      setFeedback('已保存')
      load()
      if (onSaved) onSaved()
    } catch (err) {
      setFeedback('保存失败：' + messageOf(err))
    } finally {
      setBusy(false)
    }
  }, [editing, draft, load, onSaved])

  const remove = useCallback(async () => {
    if (editing === null) return
    setBusy(true)
    setFeedback(null)
    try {
      await postJson(CREDENTIAL_WRITE_URL, { ref: editing, unset: true })
      setEditing(null)
      setDraft('')
      setFeedback('已删除')
      load()
      if (onSaved) onSaved()
    } catch (err) {
      setFeedback('删除失败：' + messageOf(err))
    } finally {
      setBusy(false)
    }
  }, [editing, load, onSaved])

  if (names.length === 0) {
    return React.createElement(Empty, null, '环境中没有 KEY / TOKEN / SECRET 形状的变量名')
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(GroupHeading, { title: '密钥', count: names.length }),
    React.createElement(Note, null, '宿主**从不回传密钥值**，所以这里只表达"是否已配置"。写入后立即对 DSH 内部生效（下一次模型请求即可用），但模型执行的 shell 读不到它 —— 这是有意的安全设计。'),
    available === false
      ? React.createElement(Note, null, '本 composition 未挂载凭据域，无法管理密钥。')
      : null,
    error !== null ? React.createElement(Note, null, `读取失败：${error}`) : null,
    feedback !== null ? React.createElement(Note, null, feedback) : null,
    status === null
      ? React.createElement(Empty, null, '正在读取密钥状态…')
      : names.map((name) => {
          const info = status[name] ?? { configured: false, editable: false }
          const rowMeta = React.createElement(Meta, {
            parts: [info.configured === true ? '已配置' : '未配置', info.sourceLabel, info.blockedReason],
          })
          return React.createElement(
            'div',
            { key: name },
            React.createElement(
              Row,
              { active: editing === name },
              React.createElement(Key, { title: name }, name),
              React.createElement(Value, {
                masked: info.configured === true,
                title: info.configured === true ? '宿主从不回传密钥值' : undefined,
                children: info.configured === true ? null : '—',
              }),
              React.createElement(
                'span',
                { style: { display: 'inline-flex', alignItems: 'baseline', gap: '8px' } },
                rowMeta,
                React.createElement(
                  RowActions,
                  null,
                  info.editable === true && editing !== name
                    ? React.createElement(Button, {
                        variant: 'ghost',
                        size: 'sm',
                        icon: React.createElement(IconEditOutline16, null),
                        title: info.configured === true ? '替换密钥' : '设置密钥',
                        'aria-label': info.configured === true ? '替换' : '设置',
                        disabled: busy,
                        onClick: () => {
                          setEditing(name)
                          setDraft('')
                          setFeedback(null)
                        },
                      })
                    : null,
                ),
              ),
            ),
            editing === name
              ? React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 8px 6px' } },
                  React.createElement(Input, {
                    style: { flex: 1, fontFamily: MONO, fontSize: '12px' },
                    type: 'password',
                    placeholder: '输入新值（不会回显已存值）',
                    value: draft,
                    autoFocus: true,
                    onChange: (e: InputChangeEvent) => setDraft(e.target.value),
                  }),
                  React.createElement(
                    Button,
                    { variant: 'outline', size: 'sm', disabled: busy, onClick: save },
                    busy ? '保存中' : '保存',
                  ),
                  React.createElement(
                    Button,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      disabled: busy,
                      onClick: () => {
                        setEditing(null)
                        setDraft('')
                      },
                    },
                    '取消',
                  ),
                  info.configured === true
                    ? React.createElement(Button, {
                        variant: 'ghost',
                        size: 'sm',
                        icon: React.createElement(IconTrashOutline16, null),
                        title: '删除密钥',
                        'aria-label': '删除',
                        disabled: busy,
                        onClick: remove,
                      })
                    : null,
                )
              : null,
          )
        }),
  )
}
/** 页签主体。 */
function EnvManagerPanel() {
  const [state, setState] = useState<EnvState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')
  const [notesOpen, setNotesOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch(STATE_URL)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + String(res.status))
        return res.json()
      })
      .then((body) => {
        setState(body)
        setLoading(false)
      })
      .catch((err) => {
        setError(messageOf(err))
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))
  }, [])

  // 三种状态都在模态框内部表达（原来是三个各自 return 的整屏）
  if (loading && state === null) {
    return React.createElement(Placeholder, null, '正在读取环境…')
  }
  if (error !== null) {
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(Placeholder, { tone: 'warn' }, `读取失败：${error}`),
      React.createElement(Note, null, `宿主路由：${STATE_URL}（需要 DSH 已加载本插件）`),
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'center' } },
        React.createElement(Button, { variant: 'outline', size: 'sm', onClick: load }, '重试'),
      ),
    )
  }
  // 上面两个分支都 return 了，且 `load()` 成功才 setState、失败必 setError，
  // 所以走到这里 state 一定非空。编译器看不到这层配对，显式收一次窄；
  // **不能**改成调整分支顺序 —— 出错时 state 也是 null。
  if (state === null) return null

  const variables = state.variables ?? []
  const needle = filter.trim().toUpperCase()
  const shown = needle.length === 0 ? variables : variables.filter((v) => v.name.toUpperCase().includes(needle))

  const groups = [
    { key: 'runtime', title: '运行时 DSH_*', items: shown.filter((v) => v.runtimeManaged === true) },
    { key: 'shadowed', title: '多层竞争', items: shown.filter((v) => v.shadowed === true && v.runtimeManaged !== true) },
    { key: 'plain', title: '单层变量', items: shown.filter((v) => v.shadowed !== true && v.runtimeManaged !== true) },
  ]

  // 密钥候选：只挑凭据形状的名字（宿主会对每个候选逐个 describe）
  const credentialNames = variables
    .filter((v) => CREDENTIAL_HINTS.test(v.name))
    .map((v) => v.name)
    .sort()

  const warnings = state.warnings ?? []

  return React.createElement(
    React.Fragment,
    null,

    // ── 工具条 ───────────────────────────────────────────────────────────
    React.createElement(
      Toolbar,
      null,
      React.createElement(Input, {
        icon: React.createElement(IconSearchOutline16, null),
        placeholder: '按名称过滤',
        value: filter,
        style: { flex: 1, fontSize: '12px' },
        onChange: (e: InputChangeEvent) => setFilter(e.target.value),
      }),
      React.createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        icon: React.createElement(IconRefreshOutline16, null),
        title: '重新读取',
        'aria-label': '刷新',
        onClick: load,
      }),
      React.createElement(
        'span',
        { style: { ...T.meta, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
        needle.length === 0 ? String(variables.length) : `${String(shown.length)} / ${String(variables.length)}`,
      ),
    ),

    // 解析诊断必须显示：带 BOM 的文件里第一个变量名对 DSH 而言与界面显示的不同
    warnings.map((w, i) =>
      React.createElement(
        Note,
        { key: `w${String(i)}` },
        `⚠ ${w.path === undefined ? '' : `${w.path}：`}${w.message ?? w.code ?? ''}`,
      ),
    ),

    // ── 变量列表（只让这块滚动）───────────────────────────────────────────
    React.createElement(
      ScrollArea,
      null,
      groups.map((group) =>
        group.items.length === 0
          ? null
          : React.createElement(
              React.Fragment,
              { key: group.key },
              React.createElement(GroupHeading, { title: group.title, count: group.items.length }),
              group.items
                .slice(0, 40)
                .map((v) =>
                  React.createElement(VariableRow, {
                    key: v.name,
                    variable: v,
                    state,
                    expanded: expanded[v.name] === true,
                    onToggle: toggle,
                    onSaved: load,
                  }),
                ),
              group.items.length > 40
                ? React.createElement(
                    Note,
                    null,
                    `另有 ${String(group.items.length - 40)} 项，请用过滤框缩小范围`,
                  )
                : null,
            ),
      ),
      React.createElement(CredentialPanel, { names: credentialNames, onSaved: load }),
      shown.length === 0 ? React.createElement(Empty, null, `没有名字匹配「${filter}」`) : null,
    ),

    // ── 说明：默认收起。原文案是三段常驻长文，把 KEY/VALUE 挤到了屏幕外 ──
    React.createElement(
      DisclosureRow,
      {
        title: '说明与生效时机',
        open: notesOpen,
        expandable: true,
        onToggle: () => setNotesOpen(!notesOpen),
      },
      React.createElement(
        'div',
        { style: { paddingBottom: '4px' } },
        React.createElement(
          Note,
          null,
          `工作目录 ${state.cwd}　·　home ${state.home}　·　共 ${String(state.counts.total)} 项` +
            (state.counts.shadowed > 0 ? `（${String(state.counts.shadowed)} 项多层竞争）` : ''),
        ),
        React.createElement(
          Note,
          null,
          `项目 .env：${state.files.project ?? '（不存在）'}　·　用户 .env：${state.files.user ?? '（不存在）'}`,
        ),
        state.os === undefined
          ? null
          : React.createElement(
              Note,
              null,
              state.os.skipped === true
                ? 'OS 环境层：本次请求已跳过（os=0）'
                : state.os.supported === false
                  ? 'OS 环境层：当前平台不支持读写（Linux/macOS 没有单一可靠的写入点，见设计文档 §2）'
                  : `OS 环境层：注册表·用户 ${String(state.os.scopes?.['os-user']?.count ?? 0)} 项` +
                    (state.os.scopes?.['os-user']?.error ? `（读取失败：${state.os.scopes['os-user']?.error ?? ''}）` : '') +
                    `　·　注册表·系统 ${String(state.os.scopes?.['os-machine']?.count ?? 0)} 项` +
                    (state.os.scopes?.['os-machine']?.error ? `（读取失败：${state.os.scopes['os-machine']?.error ?? ''}）` : ''),
            ),
        React.createElement(
          Note,
          null,
          '标记为「shell 不可见」的名字会被子进程清洗（/KEY|PASSWORD|SECRET|TOKEN/i），所以模型执行的命令读不到它们 —— 这是「仅 DSH 内部可用」的密钥。',
        ),
        React.createElement(
          Note,
          null,
          '注册表层的改动在 DSH 重启前**不会改变生效值** —— 注册表的值在启动时已被继承进「启动环境」，而它的优先级更高。展开被遮蔽的多层变量即可看到这种竞争。',
        ),
        React.createElement(
          Note,
          null,
          '写入 .env 使用「读取 revision → 带栅栏写入」的乐观并发；若期间文件被其他程序改动，保存会被拒绝而不会覆盖对方的改动。',
        ),
      ),
    ),
  )
}
/**
 * 本插件依赖的 cordis 服务（**浏览器侧的 fiber inject**）。
 *
 * 这是 `cannot get property "slots" without inject` 检查的那个 inject。
 *
 * 两次修错的过程记在这里，免得重犯：
 *
 *   1. 改 `package.json` 的 `dsh.client.inject`（列包名）→ **无效**。
 *      那是 `dsh-client-modules` 的组合机制，只管 boot graph 的加载顺序，
 *      不解除 cordis 的服务访问限制。
 *   2. 我以为客户端 bundle 必须"return 插件对象"→ 也没解决。
 *
 * 真正的依据在 cordis 与第一方产物里：
 *   - cordis registry：`new Fiber(this.ctx, config, Inject.resolve(plugin.inject), …)`
 *     —— 它读的是**传进 ctx.plugin() 的那个对象**的 `inject`
 *   - 客户端 runner 传的是 materialize 出的 `module.exports`
 *   - 第一方产物结尾就是 `exports.apply = apply; exports.inject = inject;`
 *     （如 `dsh-client-ui-goal`）
 *
 * 所以：**具名导出 `inject`（服务名数组）+ 具名导出 `apply`**，与第一方一致。
 * 服务名只有 `"slots"`；槽位就绪由 `slots.inject()` 自己处理。
 */
const inject = ['slots']

/**
 * 入口图标。
 *
 * `IconContextInjectionOutline16` —— 本插件做的事就是往 DSH 的上下文里注入变量，
 * 语义对得上，尺寸与 header 里其它图标一致。想换只改这一行，候选：
 * `IconDataOutline16`（层叠的数据）、`IconDatabaseOutline16`（分层存储）、
 * `IconSettingsOutline16`。
 */
const ENTRY_ICON = IconContextInjectionOutline16

/**
 * 模态框：把面板挂在 body 上的 portal，由 `Modal` 自己处理遮罩、Esc、焦点。
 *
 * 只在打开时才渲染 —— `Modal` 在 `open === false` 时返回 null，所以关闭状态下
 * 一次 `fetch` 都不会发。
 */
function EnvManagerDialog(props: { open: boolean; onClose: () => void }) {
  return React.createElement(
    Modal,
    {
      open: props.open,
      onClose: props.onClose,
      title: '环境变量',
      closeLabel: '关闭',
      description: 'KEY=VALUE 的复合视图：谁在生效、在哪一层、能不能改。',
      className: 'dsh-envmgr-dialog',
    },
    React.createElement(EnvManagerPanel),
  )
}

/**
 * 会话头部（`conversation.session.header.utilities`）里的入口。
 *
 * 为什么放在这里而不是 Settings → Plugins：环境变量是**每次会话都要看**的东西
 * （"这个变量到底生效了吗"），而 Settings 是配置一次就不再打开的页面。
 * 头部图标点开即成模态，不离开当前对话。
 */
function EnvManagerAction() {
  const [open, setOpen] = useState(false)
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(Button, {
      variant: 'ghost',
      size: 'sm',
      icon: React.createElement(ENTRY_ICON, null),
      title: '环境变量',
      'aria-label': '环境变量',
      onClick: () => setOpen(true),
    }),
    React.createElement(EnvManagerDialog, { open, onClose: () => setOpen(false) }),
  )
}

/**
 * 载入客户端插件。
 *
 * `ctx` 只声明**用到的**那一小块（`slots.inject` / `slots.register`）：
 * 客户端 runner 传进来的是它自己的 cordis 上下文，本包不该、也无法完整声明它。
 * 真正要保证的是 `inject = ['slots']` 已导出 —— 没有它，cordis 会以
 * `cannot get property "slots" without inject` 直接拒绝装载。
 *
 * @param ctx - 客户端 cordis 上下文（已因 `inject` 而保证 `ctx.slots` 可用）。
 */
function apply(ctx: {
  slots: {
    inject: (name: string, callback: () => void) => void
    register: (options: Record<string, unknown>, component: () => unknown) => unknown
  }
}) {
  installClientStyles()

  // 注册进**会话头部的右侧工具区**（`conversation.session.header.utilities`）。
  // 它是 `list` 槽位，与「在应用中打开」「后台任务」等图标并排。
  // `slots.inject` 等待槽位被声明后再注册：注册早于声明会被丢弃。
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'env-manager',
        order: 100,
      },
      EnvManagerAction,
    ),
  )
}

/**
 * 导出面：`apply` / `inject` / `EnvManagerAction` / `EnvManagerPanel`。
 *
 * `inject` 必须与 `apply` 一起**具名导出在同一个模块上** —— 客户端 runner 把
 * materialize 出的 `module.exports` 交给 `ctx.plugin()`，而 cordis 用
 * `Inject.resolve(plugin.inject)` 建 fiber。第一方产物的结尾同样是
 * `exports.apply = apply; exports.inject = inject;`（如 `dsh-client-ui-goal`）。
 */
export { apply, inject, EnvManagerAction, EnvManagerPanel }
