/**
 * 客户端半边入口（占位，稍后由 lib/client.js 迁入）。
 *
 * **必须是"具名导出 `inject` + 具名导出 `apply`"**，且两者在同一个模块上：
 *
 * - 客户端 runner 把 materialize 出的 `module.exports` 交给 `ctx.plugin()`，
 *   而 cordis 用 `Inject.resolve(plugin.inject)` 建 fiber —— 所以 `inject`
 *   是**导出的具名成员**，不是别的机制。
 * - 第一方包的产物结尾就是 `exports.apply = apply; exports.inject = inject;`
 *   （如 `dsh-client-ui-goal`），与这里的形式一致。
 */
import { createElement } from 'react'

export const inject = ['slots']

/** 槽位就绪由 `slots.inject()` 处理，不需要把槽位本身写进 inject。 */
export function apply(ctx: { slots: { inject: (key: string, fn: () => void) => void } }): void {
  ctx.slots.inject('settings.plugins.tab', () => {
    // 迁移中：正式实现见 lib/client.js
  })
}

/** 页签组件（占位）。 */
export function EnvManagerTab(): unknown {
  return createElement('p', null, 'env-manager')
}
