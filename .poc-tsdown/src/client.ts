/**
 * POC 客户端半边：验证 tsdown 能否生成 DSH 期望的 bundle 形状。
 *
 * 关键看点：
 *   1. 产物是否带 `window.__ModuleLoader__.load({ id, factory })` 包装
 *   2. 是否有 `exports.inject` / `exports.apply` 两个具名导出
 *   3. `require('react')` 是否保留为外部依赖（不打进产物）
 */
import { createElement, useState, useEffect, useCallback } from 'react'

export const inject = ['slots']

function Demo() {
  const [value] = useState('x')
  useEffect(() => {}, [])
  const cb = useCallback(() => value, [value])
  return createElement('p', null, cb())
}

export function apply(ctx: { slots: { inject(k: string, fn: () => void): void } }): void {
  ctx.slots.inject('settings.plugins.tab', () => {})
}
