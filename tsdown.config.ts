import { defineConfig } from 'tsdown'

import { clientBundleWrapper } from './build/client-wrapper.mjs'

/**
 * 双入口构建：
 *
 * - `src/index.ts` → `lib/index.js` —— 宿主半边（Node ESM）。cordis 直接 import 它。
 * - `src/client.ts` → `lib/client.js` —— 客户端半边（浏览器）。产物会被
 *   `clientBundleWrapper` 再包一层，变成 `window.__ModuleLoader__.load({ id, factory })`。
 *
 * ── 为什么客户端入口要 `platform: 'browser'` 且 `neverBundle: ['react']` ──────
 *
 * 客户端 bundle 里的裸说明符由 runner 的 `require` 解析，解析顺序是
 * 「平台种子表 → 记忆化记录 → boot graph 行 → 已注册工厂」——**表外的会抛错**。
 * `react` 在第一方 bundle 里也是保留的（它们同样 `require("react")`），所以
 * 它必须留在外部、不能被打进产物。
 */
export default defineConfig([
  {
    name: 'host',
    entry: {
      index: 'src/index.ts',
      'env-model': 'src/env-model.ts',
      'env-write': 'src/env-write.ts',
      credentials: 'src/credentials.ts',
      registry: 'src/registry.ts',
      'host-api': 'src/host-api.ts',
      'write-routes': 'src/write-routes.ts',
      'live-environment': 'src/live-environment.ts',
    },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    // **`platform: 'node'` 会把 fixedExtension 默认为 true**（见 tsdown 的
    // `fixedExtension = platform === "node"`），于是 ESM 产物叫 `index.mjs`。
    // 而 `package.json` 的 `main` 指向 `lib/index.js`，第一方包也都是 `.js`。
    // 显式关掉以得到 `.js`：
    //   resolveJsOutputExtension(module, 'es', fixedExtension) → fixedExtension ? 'mjs' : 'js'
    fixedExtension: false,
    dts: false,
    /**
     * **`clean` 必须是 false。**
     *
     * 迁移期间 `lib/` 里同时存在旧的手写 `*.mjs`（已通过 877 项断言）与新的
     * `*.js` 构建产物，`verify-build-parity.mjs` 要逐一对比两者。
     * 开 `clean: true` 会删掉旧产物，等价性门禁就无从对比了。
     *
     * 而且这个项目已经因此出过一次事故：早先在实现还位于 `lib/` 时就开了
     * `clean: true`，构建把 `lib/index.js` 与 `lib/client.js` 直接清空，
     * 而当时没有 git，只能从会话日志重建。
     */
    clean: false,
    sourcemap: false,
  },
  {
    name: 'client',
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'esm',
    // 浏览器面向：不注入 Node 内建 shim，也不把 process 之类打进产物
    platform: 'browser',
    fixedExtension: false,
    dts: false,
    // 客户端半边不清空 lib/，否则会删掉刚构建好的宿主产物
    clean: false,
    sourcemap: false,
    deps: {
      /**
       * 必须保留为 `require()` —— 见文件头的说明。
       *
       * `@deepseek-ai/dsh-client-ui-primitives` 是**平台种子**：它不在磁盘上的
       * node_modules 里，而由前端 shell 直接提供。实测自 `dsh-web-frontend` 的
       * 种子表（`function by(){return{…}}`）：
       *   react / react/jsx-runtime / react-dom / react-dom/client /
       *   @deepseek-ai/cordis / @deepseek-ai/dsh-client-store /
       *   @deepseek-ai/dsh-client-ui-slots /
       *   @deepseek-ai/dsh-client-ui-primitives /
       *   @deepseek-ai/dsh-client-ui-dockkit
       * 第一方客户端 bundle 里有 38 个 require 它，所以用它就能与 DSH 自己的
       * 设计系统（Button / Input / Modal / Pill / 图标 …）保持一致 ——
       * 比自己造一套按钮既便宜又好看。
       */
      neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
    },
    plugins: [
      clientBundleWrapper({
        id: 'dsh-environment-tray',
        chunk: 'client.js',
        external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
      }),
    ],
  },
])
