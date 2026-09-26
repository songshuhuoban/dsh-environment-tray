/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的类型声明。
 *
 * 为什么需要它：这个包**不在磁盘上的 node_modules 里** —— 它由前端 shell 直接
 * 提供（`window.__ModuleLoader__` 的解析种子表）。所以 `tsc` 找不到它的声明，
 * 而运行时却真的能 `require()` 到。于是这里按**实测到的实现**补齐表面。
 *
 * 每一条都不是猜的，来源是 `dsh-web-frontend/dist/assets/index-*.js` 里那份
 * 被打包的实现（形如 `function A6({open:…,onClose:…}){…}`），以及第一方客户端
 * bundle 的调用点：
 *
 *   - `Button`     `{variant='ghost', size='md', icon, className, children, ...rest}`
 *                  实际用到的 variant：`outline` / `primary` / `ghost`
 *   - `Input`      `{icon, className, ...rest}`（rest 直接落到 `<input>`）
 *   - `Modal`      `{open, onClose, title, closeLabel, description, children,
 *                    footer, className, contentClassName, headless}`
 *                  `createPortal` 到 `document.body`；Esc 与遮罩点击都关
 *   - `Pill`       `{active=false, className, children, onClick, ...rest}`
 *   - `Tag`        `{tone='outline', className, children}`；用到 `neutral` / `solid`
 *   - `StateDot`   `{state, size=10}`；`state` 至少支持 `ongoing` / `error`
 *   - `DisclosureRow` `{icon, title, open, expandable, onToggle, expandOnRowClick,
 *                    previewChevron, keepContentWhenOpen, collapsedContent,
 *                    children, …}`
 *
 * 只声明本插件用到的成员。加新成员时**先回上面那份实现里核对 props**，
 * 不要凭名字猜。
 *
 * @module dsh-env-manager/primitives
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type * as React from 'react'

  /** 按钮。`variant` 默认 `ghost`，`size` 默认 `md`。 */
  export const Button: React.ComponentType<
    {
      variant?: 'ghost' | 'outline' | 'primary'
      size?: 'sm' | 'md' | 'lg'
      icon?: React.ReactNode
      className?: string
    } & React.ButtonHTMLAttributes<HTMLButtonElement>
  >

  /** 输入框。`icon` 会渲染在框内左侧；其余 props 落到 `<input>` 上。 */
  export const Input: React.ComponentType<
    { icon?: React.ReactNode; className?: string } & React.InputHTMLAttributes<HTMLInputElement>
  >

  /** 模态框：portal 到 body，自带遮罩、Esc、关闭按钮。`open=false` 时渲染 null。 */
  export const Modal: React.ComponentType<{
    open: boolean
    onClose: () => void
    title?: string
    closeLabel?: string
    description?: string
    children?: React.ReactNode
    footer?: React.ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }>

  /** 开关：`checked` 与 `onChange` 都由调用方持有；`label` 渲染在开关旁边。 */
  export const Switch: React.ComponentType<{
    checked: boolean
    onChange: (next: boolean) => void
    label?: React.ReactNode
    disabled?: boolean
    title?: string
    className?: string
  }>

  /** 可折叠行：`open` 由调用方持有。 */
  export const DisclosureRow: React.ComponentType<{
    icon?: React.ReactNode
    title?: React.ReactNode
    open?: boolean
    expandable?: boolean
    onToggle?: () => void
    expandOnRowClick?: boolean
    keepContentWhenOpen?: boolean
    collapsedContent?: React.ReactNode
    children?: React.ReactNode
    className?: string
    rowClassName?: string
  }>

  /* ── 图标：均为 16px（`14` 结尾的是 14px）线性图标 ── */
  export const IconChevronDownOutline14: React.ComponentType<{ size?: number; className?: string }>
  export const IconContextInjectionOutline16: React.ComponentType<{ size?: number; className?: string }>
  export const IconEditOutline16: React.ComponentType<{ size?: number; className?: string }>
  export const IconRefreshOutline16: React.ComponentType<{ size?: number; className?: string }>
  export const IconSearchOutline16: React.ComponentType<{ size?: number; className?: string }>
  export const IconTrashOutline16: React.ComponentType<{ size?: number; className?: string }>
}
