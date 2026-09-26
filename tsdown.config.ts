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
    entry: { index: 'src/index.ts' },
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
    clean: true,
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
      // 必须保留为 require() —— 见文件头的说明
      neverBundle: ['react', 'react/jsx-runtime'],
    },
    plugins: [
      clientBundleWrapper({
        id: 'dsh-env-manager',
        chunk: 'client.js',
        external: ['react', 'react/jsx-runtime'],
      }),
    ],
  },
])
