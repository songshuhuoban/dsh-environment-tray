/**
 * 宿主半边入口（占位，稍后由 lib/index.js 迁入）。
 */
export const name = 'env-manager'

export const inject = ['shellEnv', 'credentials', 'connection']

export function apply(): void {
  // 迁移中：正式实现见 lib/index.js
}
