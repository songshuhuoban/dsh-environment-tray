/**
 * `build/client-wrapper.mjs` 的类型声明。
 *
 * 为什么需要这个文件：`tsdown.config.ts` 在 `tsconfig.json` 的 `include` 里，
 * 会被 `tsc --noEmit` 检查；而它 `import` 的实现是 `.mjs`，`allowJs` 是关的。
 * 没有声明文件时 TS 报 TS7016（隐式 any）。
 *
 * 之所以改成给实现补声明、而不是把配置排除出类型检查：配置里的 `fixedExtension`
 * 与 `clean` 都有真实的踩坑历史（见 `tsdown.config.ts` 的注释），把它留在类型
 * 检查范围内是有价值的。
 *
 * 这里**只声明 `tsdown.config.ts` 真正用到的表面**，与实现的对应关系如下：
 * - `clientBundleWrapper(options)` → `build/client-wrapper.mjs` 同名导出；
 * - `ClientBundleWrapperPlugin` 对应它返回的 tsdown 插件对象。
 */

/** `clientBundleWrapper()` 的入参。 */
export interface ClientBundleWrapperOptions {
  /** bundle 的包名，写进 `window.__ModuleLoader__.load({ id })`。 */
  id: string
  /** 要包装的产物文件名，默认 `client.js`。 */
  chunk?: string
  /** 允许保留 `require()` 的说明符；缺省用实现里的 `DEFAULT_EXTERNAL`。 */
  external?: readonly string[]
}

/**
 * 返回的 tsdown 插件。
 *
 * 只声明 `tsdown.config.ts` 用得到的部分：插件名，以及在产物落盘后被调用的
 * `writeBundle`。参数按结构化最小面声明（`{ dir?: string }`），rolldown 传进来的
 * `OutputOptions` 可以赋给它。
 */
export interface ClientBundleWrapperPlugin {
  name: string
  writeBundle(outputOptions: { dir?: string }): void
}

/**
 * tsdown 插件：把浏览器朝向的 ESM 产物改写成 `window.__ModuleLoader__.load`
 * 的惰性 CJS 工厂形状（与 DSH 第一方客户端 bundle 对齐）。
 */
export function clientBundleWrapper(options: ClientBundleWrapperOptions): ClientBundleWrapperPlugin

/** 把 ESM 源码转成工厂函数体（导出赋值 + `return module.exports`）。 */
export function toFactoryBody(source: string, external: ReadonlySet<string>, label: string): string
