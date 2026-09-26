/**
 * POC 宿主半边：验证 tsdown 能否把 TS 编成 Node 端 ESM。
 */
export const name = 'poc-host'

export const inject = ['shellEnv']

export function apply(ctx: { get?: (k: string) => unknown }): void {
  void ctx
}
