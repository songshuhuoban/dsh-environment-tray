import { defineConfig } from 'tsdown'

/**
 * POC 构建配置。
 *
 * 双入口：宿主半边（Node 平台）与客户端半边（浏览器平台）。
 * 第一方包用 `tsdown` 默认配置产出 `lib/index.js` 与 `lib/client.js`，
 * 这里显式写出来以便观察差异。
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'neutral',
  // react 必须保持外部：客户端运行时通过 __ModuleLoader__ 的 require 提供它
  external: ['react', 'react/jsx-runtime'],
  dts: false,
  clean: true,
  sourcemap: false,
})
