/**
 * 客户端页签的**表现层**。
 *
 * 与 `client.ts` 的分工：这里只有排版与样式，不认识 `fetch`、也不持有状态；
 * `client.ts` 负责数据流并把结果交给这里的组件。
 *
 * ── 排版原则（这一层的全部理由）────────────────────────────────────────────
 *
 * 「环境变量」这个界面的**内容就是 KEY 与 VALUE**。其余一切都是注解：
 * 生效层、层数、遮蔽、生效时机、平台限制。所以：
 *
 *   1. **KEY / VALUE 占满宽度。** 一行就是 `KEY  VALUE  · 次要信息`，
 *      等宽字体 + 三列对齐，让上百行能像 `env` 输出那样竖着扫下来。
 *   2. **次要信息一律 11px / 低对比。** 不用彩色胶囊、不用边框卡片 ——
 *      胶囊和边框会把注解抬到和内容一样的视觉重量，这是原版"丑"的主因。
 *      次要信息用 `·` 串成一行跟在后面，读得到但抢不走注意力。
 *   3. **操作按需出现。** 编辑/展开是图标按钮，只在悬停该行或键盘落在行内时
 *      出现。密集列表里常驻按钮会让每一行都变成一条按钮条。
 *   4. **分组用一条细横线 + 小字标题**，不要卡片盒子。盒子会切断竖向扫描。
 *   5. **颜色只用于状态**，不用于装饰。正文颜色全部继承
 *      `--dsw-alias-*`（DSH 自己的语义色），所以明暗主题自动正确。
 *
 * 需要 `:hover` / `:focus-within` 的部分走一张注入的极小样式表 —— 内联
 * style 表达不了伪类，而引入 CSS 工具链只为一个悬停态不值得。
 *
 * @module dsh-env-manager/client-ui
 */

import * as React from 'react'

/* ────────────────────────────── 排版尺度 ────────────────────────────── */

/** 等宽字体栈：KEY / VALUE / 路径都用它。 */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/**
 * 字号与不透明度只在这里定义一次。
 *
 * 三档就够：内容（KEY/VALUE）、注解（meta）、结构（分组标题）。
 * 原版的问题是每一类信息都自带一套字号 + 边框 + 颜色，于是没有主次。
 */
export const T = {
  /** KEY：内容，最高对比、略加粗。 */
  key: { fontSize: '12.5px', fontWeight: 560, letterSpacing: 0 },
  /** VALUE：内容，等宽、稍低对比（长值要能一眼看出边界）。 */
  value: { fontSize: '12.5px', fontWeight: 400, opacity: 0.74 },
  /** 注解：生效层、层数、字符数、时机。 */
  meta: { fontSize: '11px', fontWeight: 400, opacity: 0.42 },
  /** 展开后的每层细节。 */
  detail: { fontSize: '11.5px', fontWeight: 400, opacity: 0.5 },
  /** 分组标题。 */
  group: { fontSize: '11px', fontWeight: 520, letterSpacing: '0.06em', opacity: 0.5 },
} as const

/** 注入一次的小样式表：只放内联 style 表达不了的伪类与媒体查询。 */
const STYLE_ID = 'dsh-env-manager-client-style'

/**
 * 这张表负责三件内联样式做不到的事：
 *
 * 1. **`:hover` / `:focus-within`** —— 行尾操作按需出现；
 * 2. **响应式** —— 窄屏把三列压成两列，VALUE 换到第二行；
 * 3. **模态框宽度** —— 内容就是 KEY/VALUE，横向越宽越好扫，所以显式放宽到
 *    1080px（`Modal` 自带的默认宽度对这张表偏窄）。能覆盖它是因为两边都是
 *    单类选择器，同优先级下**后出现在文档里的胜出**，而这张表是运行时追加到
 *    `<head>` 末尾的。
 */
const CSS = `
.dsh-envmgr-dialog { width: min(1080px, calc(100vw - 48px)); max-width: none; }
.dsh-envmgr-row {
  display: grid;
  grid-template-columns: minmax(140px, 260px) minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: 12px;
  padding: 5px 8px;
  border-radius: 6px;
}
.dsh-envmgr-row:hover { background: var(--dsw-alias-fill-quaternary, rgba(128,128,128,0.10)); }
.dsh-envmgr-actions { opacity: 0; transition: opacity .12s ease; }
.dsh-envmgr-row:hover .dsh-envmgr-actions,
.dsh-envmgr-row:focus-within .dsh-envmgr-actions { opacity: 1; }
@media (hover: none) { .dsh-envmgr-actions { opacity: 1; } }
.dsh-envmgr-scroll { max-height: min(62vh, 760px); overflow-y: auto; overscroll-behavior: contain; }
.dsh-envmgr-valuecell { min-width: 0; }
.dsh-envmgr-valuecell:hover { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }

/* 窄屏：KEY 与注解一行，VALUE 独占下一行 —— 竖着扫仍然成立，且不再横向溢出 */
@media (max-width: 760px) {
  .dsh-envmgr-dialog { width: calc(100vw - 16px); }
  .dsh-envmgr-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
  .dsh-envmgr-valuecell { grid-column: 1 / -1; }
}
`

/**
 * 把上面那张样式表挂进 document（幂等）。
 *
 * 在模块体里调用 —— 客户端 bundle 是惰性 CJS 工厂，工厂体只在首次
 * materialize 时执行，所以挂载前不会有副作用。
 */
export function installClientStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/* ────────────────────────────── 基础件 ────────────────────────────── */

/**
 * 一行。三列网格：KEY 定宽、VALUE 占满、注解靠右。
 *
 * 网格定义在样式表里而不是内联：窄屏要换成两列，而媒体查询赢不过内联样式。
 * KEY 用 `minmax(140px, 260px)`：短名字不浪费空间，遇到
 * `HUOSHAN_DOUBAO_ACCESS_TOKEN` 这种长名字也不会把 VALUE 挤没。
 */
export function Row(props: { children?: React.ReactNode; active?: boolean }): React.ReactElement {
  return React.createElement(
    'div',
    {
      className: 'dsh-envmgr-row',
      style: {
        background: props.active === true ? 'var(--dsw-alias-fill-quaternary, rgba(128,128,128,0.10))' : 'transparent',
      },
    },
    props.children,
  )
}

/** 行尾的操作图标簇：默认透明，悬停整行时出现。 */
export function RowActions(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement(
    'span',
    { className: 'dsh-envmgr-actions', style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } },
    props.children,
  )
}

/** KEY：内容的主角之一。等宽、高对比、溢出省略。 */
export function Key(props: { children?: React.ReactNode; title?: string }): React.ReactElement {
  return React.createElement(
    'span',
    {
      style: {
        ...T.key,
        fontFamily: MONO,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      ...(props.title === undefined ? {} : { title: props.title }),
    },
    props.children,
  )
}

/**
 * VALUE：另一个主角。等宽、可省略。
 *
 * `masked` 用点阵表示"宿主不回传这个值" —— 这比空白更能说明状态。
 * 两类情况会走到这里：凭据域（契约上根本没有值可给），以及用户没有打开
 * 「显示敏感值」时宿主按名字屏蔽的值（见设计文档 §33）。
 */
export function Value(props: {
  children?: React.ReactNode
  title?: string
  onClick?: () => void
  masked?: boolean
}): React.ReactElement {
  return React.createElement(
    'span',
    {
      // 类名恒定：窄屏要在媒体查询里把它换到第二行，而媒体查询赢不过内联样式
      className: 'dsh-envmgr-valuecell',
      style: {
        ...T.value,
        fontFamily: MONO,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...(props.onClick === undefined ? {} : { cursor: 'pointer' }),
      },
      ...(props.title === undefined ? {} : { title: props.title }),
      ...(props.onClick === undefined ? {} : { onClick: props.onClick }),
    },
    props.masked === true ? '••••••••••' : props.children,
  )
}

/** 注解：一行里跟在 VALUE 后面的全部次要信息，用 `·` 连接。 */
export function Meta(props: { parts: readonly (string | null | undefined)[] }): React.ReactElement | null {
  const text = props.parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' · ')
  if (text.length === 0) return null
  return React.createElement('span', { style: { ...T.meta, whiteSpace: 'nowrap' } }, text)
}

/** 分组标题：小字 + 一条细横线 + 计数。横向规则把视线按组切开。 */
export function GroupHeading(props: { title: string; count?: number }): React.ReactElement {
  return React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0 2px', padding: '0 8px' } },
    React.createElement('span', { style: T.group }, props.title),
    React.createElement('span', { style: { flex: 1, height: '1px', background: 'currentColor', opacity: 0.12 } }),
    props.count === undefined
      ? null
      : React.createElement('span', { style: { ...T.meta, fontVariantNumeric: 'tabular-nums' } }, String(props.count)),
  )
}

/**
 * 展开后的每层细节。
 *
 * 用左侧一条细竖线表示"从属于上面那一行"，而不是再套一个盒子 ——
 * 盒子会让人以为它是一个独立条目。层名与事实分成两列，便于竖向比对。
 */
export function LayerDetail(props: { rows: readonly { name: string; facts: string }[] }): React.ReactElement {
  return React.createElement(
    'div',
    {
      style: {
        margin: '1px 0 4px 8px',
        paddingLeft: '11px',
        borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        columnGap: '10px',
        rowGap: '1px',
      },
    },
    props.rows.flatMap((row, i) => [
      React.createElement('span', { key: `n${String(i)}`, style: { ...T.detail, whiteSpace: 'nowrap' } }, row.name),
      React.createElement('span', { key: `f${String(i)}`, style: { ...T.detail, fontFamily: MONO } }, row.facts),
    ]),
  )
}

/** 可滚动的列表容器：固定工具条与脚注，只让内容滚。 */
export function ScrollArea(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'dsh-envmgr-scroll', style: { margin: '0 -4px', padding: '0 4px' } },
    props.children,
  )
}

/** 工具条：搜索 + 刷新 + 计数。固定在列表上方，不参与滚动。 */
export function Toolbar(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' } },
    props.children,
  )
}

/** 空状态：一句低对比说明，不要插图也不要按钮。 */
export function Empty(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('p', { style: { ...T.meta, margin: '18px 8px', textAlign: 'center' } }, props.children)
}

/** 脚注里的一行说明。 */
export function Note(props: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('p', { style: { ...T.detail, margin: '4px 0', lineHeight: 1.7 } }, props.children)
}

/** 加载/错误这类整屏状态。 */
export function Placeholder(props: { children?: React.ReactNode; tone?: 'muted' | 'warn' }): React.ReactElement {
  return React.createElement(
    'p',
    { style: { ...T.detail, margin: '24px 8px', textAlign: 'center', opacity: props.tone === 'warn' ? 0.8 : 0.5 } },
    props.children,
  )
}
