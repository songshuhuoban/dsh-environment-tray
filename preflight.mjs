/**
 * 重启前预检：模拟 DSH 重启时发生的每一步，尽量把所有失败模式提前暴露。
 *
 * 动机：用户那个 3080 实例只能重启一次来验证，所以**不能把发现问题的机会
 * 浪费在重启上**。这个脚本按 DSH 启动的真实顺序检查：
 *
 *   1. profile 的 package.json 声明（bundle 列表）
 *   2. profile 的 node_modules 里包是否可解析、是否指向预期
 *   3. 宿主半边每个模块能否 **真正 import**（语法 + 依赖解析）
 *   4. cordis 插件契约：apply 是函数、inject 是数组、apply 在缺服务时不抛
 *   5. 客户端 bundle：语法 + 工厂可物化 + 只 require 已知模块
 *   6. 组合后的配置里我们的行存在且未被 disabled
 *   7. 文件权限与残留状态
 *
 * 运行：node preflight.mjs
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

let failures = 0
let warnings = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const warn = (label, detail = '') => {
  warnings += 1
  console.log(`WARN  ${label}${detail ? ` — ${detail}` : ''}`)
}
const info = (label, detail) => console.log(`      ${label}${detail ? `: ${detail}` : ''}`)

const WORKSPACE = resolve('.')
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? process.env.DSH_HOME
  : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web')

console.log('=== 1. profile 声明 ===')
let manifest
try {
  manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  ok('profile package.json is readable and valid JSON', true)
} catch (error) {
  ok('profile package.json is readable and valid JSON', false, String(error))
}

if (manifest !== undefined) {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const deps = manifest.dependencies ?? {}
  ok('our package is listed in dsh.profile.bundles', bundles.includes('dsh-env-manager'), bundles.join(', '))
  ok('our package is a dependency of the profile', typeof deps['dsh-env-manager'] === 'string', String(deps['dsh-env-manager']))
  ok('patchReload is declared', typeof manifest.dsh?.profile?.patchReload === 'string', String(manifest.dsh?.profile?.patchReload))
}

console.log('\n=== 2. 包解析 ===')
{
  const linked = join(PROFILE, 'node_modules', 'dsh-env-manager')
  ok('the package is linked into the profile', existsSync(linked), linked)
  if (existsSync(linked)) {
    const real = readFileSync(join(linked, 'package.json'), 'utf8')
    const parsed = JSON.parse(real)
    info('resolved package name', parsed.name)
    ok('resolved manifest is ours', parsed.name === 'dsh-env-manager', String(parsed.name))
    ok('it declares dsh.bundle.patch', typeof parsed.dsh?.bundle?.patch === 'string', String(parsed.dsh?.bundle?.patch))
    ok('it declares dsh.client.platform', parsed.dsh?.client?.platform === 'web', String(parsed.dsh?.client?.platform))

    // **必须用 realpathSync**：`resolve()` 只做词法归一，不解析 junction，
    // 所以早先这条断言对 junction 链接误报失败。
    const realLinked = realpathSync(linked)
    const realWorkspace = realpathSync(WORKSPACE)
    ok('the link resolves to THIS workspace', realLinked === realWorkspace, `${realLinked} vs ${realWorkspace}`)

    // 指向 workspace 意味着后续所有代码改动都会被重启后的进程看到
    const entry = join(realLinked, 'lib', 'index.js')
    ok('the linked entry point exists', existsSync(entry), entry)
  }
}

console.log('\n=== 3. 宿主半边可加载性 ===')
const HOST_MODULES = [
  'lib/index.js',
  'lib/env-model.mjs',
  'lib/env-write.mjs',
  'lib/credentials.mjs',
  'lib/registry.mjs',
  'lib/host-api.mjs',
  'lib/write-routes.mjs',
]
const loaded = {}
for (const rel of HOST_MODULES) {
  const abs = join(WORKSPACE, rel)
  if (!existsSync(abs)) {
    ok(`exists: ${rel}`, false)
    continue
  }
  try {
    loaded[rel] = await import(pathToFileURL(abs).href)
    ok(`imports cleanly: ${rel}`, true)
  } catch (error) {
    ok(`imports cleanly: ${rel}`, false, String(error?.message ?? error))
  }
}

console.log('\n=== 4. cordis 插件契约 ===')
{
  const host = loaded['lib/index.js']
  if (host === undefined) {
    ok('host module loaded', false)
  } else {
    ok('exports apply()', typeof host.apply === 'function')
    ok('exports name', typeof host.name === 'string', String(host.name))
    ok('inject is an array', Array.isArray(host.inject), JSON.stringify(host.inject))
    ok('inject declares shellEnv', host.inject?.includes('shellEnv') === true)
    ok('inject declares credentials', host.inject?.includes('credentials') === true)
    ok('inject declares connection (the request-policy gate)', host.inject?.includes('connection') === true)

    // apply 在任何缺服务的情况下都不能抛 —— 它要挂进用户运行中的进程
    const barren = { get: () => undefined, logger: () => ({ info: () => {}, warn: () => {} }), on: () => {} }
    let threw
    try {
      host.apply(barren)
    } catch (error) {
      threw = error
    }
    ok('apply() does not throw with no services at all', threw === undefined, String(threw))

    // 带假服务再跑一次，确认注册路径不炸
    const fakeShellEnv = { register: () => () => {} }
    const withServices = {
      shellEnv: fakeShellEnv,
      credentials: { describe: async () => ({ configured: false, writable: true }), listRecords: async () => [] },
      connection: { requestRejection: () => undefined },
      get: () => undefined,
      logger: () => ({ info: () => {}, warn: () => {} }),
      on: () => {},
      inject: () => ({ then: () => {} }),
    }
    let threw2
    try {
      host.apply(withServices)
    } catch (error) {
      threw2 = error
    }
    ok('apply() does not throw with fake services', threw2 === undefined, String(threw2))
  }
}

console.log('\n=== 5. 客户端 bundle ===')
{
  const abs = join(WORKSPACE, 'lib/client.js')
  ok('client bundle exists', existsSync(abs))
  const src = readFileSync(abs, 'utf8')

  // 语法：用 vm 编译（不执行）
  const { Script } = await import('node:vm')
  let compiled
  try {
    // 包一层以模拟浏览器全局，但只编译不运行
    compiled = new Script(src, { filename: 'client.js' })
    ok('client bundle compiles', true)
  } catch (error) {
    ok('client bundle compiles', false, String(error?.message ?? error))
  }

  // 物化工厂，检查 require 清单
  const required = []
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } } },
    require: (spec) => {
      required.push(spec)
      if (spec === 'react') {
        return {
          createElement: () => ({}),
          Fragment: {},
          useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
          useEffect: () => {},
          useCallback: (f) => f,
        }
      }
      throw new Error(`unknown module: ${spec}`)
    },
  }
  const { createContext, runInContext } = await import('node:vm')
  try {
    runInContext(src, createContext({ ...sandbox, window: sandbox.window }))
    ok('client bundle registers a factory', typeof registered?.factory === 'function')
    ok('bundle id matches the package name', registered?.id === 'dsh-env-manager', String(registered?.id))
    if (typeof registered?.factory === 'function') {
      const exportsObj = registered.factory(sandbox.require)
      ok('factory materializes and exports apply()', typeof exportsObj.apply === 'function')
      ok('only react is required', required.every((r) => r === 'react'), required.join(','))
    }
  } catch (error) {
    ok('client bundle executes in a browser-like sandbox', false, String(error?.message ?? error))
  }
}

console.log('\n=== 6. 组合配置里我们的行 ===')
{
  // **必须走解析出的 bin 入口 + process.execPath**：PATH 上的 `dsh` 在 Windows
  // 只有 `dsh.ps1`（PowerShell 脚本），`execFileSync('dsh', ...)` 直接执行它会失败，
  // 而那是"检查脚本自己错了"，不是 profile 有问题。
  let dump = ''
  let dumped = true
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(join(PROFILE, 'package.json'))
    const pkgPath = req.resolve('@deepseek-ai/dsh/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const bin = join(dirname(pkgPath), pkg.bin.dsh)
    dump = execFileSync(process.execPath, [bin, '--profile', 'web', '--dump-config'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    dumped = false
    dump = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  ok('dsh --dump-config succeeds (profile composes)', dumped, dump.split('\n')[0]?.slice(0, 90))

  if (dumped) {
    const lines = dump.split('\n')
    const idx = lines.findIndex((l) => l.includes('name: dsh-env-manager'))
    ok('our row appears in the composed tree', idx !== -1)
    if (idx !== -1) {
      // 往前找最近的 id: 行
      let idLine = ''
      for (let i = idx; i >= 0; i -= 1) {
        if (/^- id:/.test(lines[i])) {
          idLine = lines[i]
          break
        }
      }
      info('our row', idLine.trim())
      ok('our row has the expected id', idLine.includes('env-manager'), idLine.trim())

      // disabled 只可能出现在同一行或紧随其后
      const near = lines.slice(Math.max(0, idx - 1), idx + 3).join('\n')
      const isDisabled = /disabled:\s*true/.test(near)

      // **被禁用是合法配置，不是失败。** 本 bundle 出厂就是 `disabled: true`
      // （理由见 cordis.patch.yml），由用户在 profile 的 patch 层显式开启。
      // 早先这里直接断言 `our row is not disabled`，于是用户按设计关掉它时
      // preflight 会报失败 —— 那是把"用户的正常选择"误报成"配置坏了"。
      if (isDisabled) {
        info('row state', 'DISABLED（出厂默认即如此；这是合法状态，不是错误）')
        console.log('      → 想启用：在 profile 的 cordis.patch.yml 里加 `- id: env-manager` / `  disabled: false`')
      } else {
        info('row state', 'ENABLED')
      }

      // 真正要守的是"行没被重复或被别的行顶掉"，而不是"它必须是启用的"
      const occurrences = lines.filter((l) => l.includes('name: dsh-env-manager')).length
      ok('exactly one row for our package (no duplicates)', occurrences === 1, String(occurrences))
    }
    // 行数应当比不含我们时多：至少能确认 dump 是完整的
    ok('the dump is non-trivial', lines.length > 400, String(lines.length))
  }
}

console.log('\n=== 7. 权限与残留 ===')
{
  const creds = join(DSH_HOME, '.credentials.yaml')
  ok('the real credentials file is untouched by our tests', !readFileSync(creds, 'utf8').includes('sk-e2e'))

  if (process.platform === 'win32') {
    let residue = ''
    try {
      residue = execFileSync('reg.exe', ['query', 'HKCU\\Environment'], { encoding: 'utf8' })
    } catch {
      residue = ''
    }
    ok('no DSH_ENV_MANAGER* residue in the registry', !residue.includes('DSH_ENV_MANAGER'))
  } else {
    warn('registry residue check skipped on this platform')
  }

  ok('no stray .env left in the workspace by tests', !existsSync(join(WORKSPACE, '.env')))
  ok('no probe home left behind', !existsSync(join(WORKSPACE, '.probe-home')))

  const patch = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  // **不要断言 profile 的 patch 层是空的。** 用户在那一层启用本插件是
  // 文档推荐的用法（见 cordis.patch.yml 的说明），所以"非空"是正常状态。
  // 早先这里断言 `endsWith('[]')`，把用户的合法配置误报成失败。
  const isPristine = patch.trim().endsWith('[]')
  if (isPristine) {
    info('profile patch layer', '空数组（插件用出厂默认，即 disabled）')
  } else {
    info('profile patch layer', '含用户覆盖（这是启用本插件的推荐方式，正常）')
  }
  ok('the profile patch layer parses as a YAML array', /^\s*(\[\]|[-#])/m.test(patch), patch.trim().slice(-40))
}

console.log()
console.log(failures === 0 ? `✅ 预检通过（${String(warnings)} 条警告）` : `❌ ${String(failures)} 项未通过`)
process.exitCode = failures === 0 ? 0 : 1
