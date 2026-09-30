/**
 * Exercise the installed Desktop Host in Electron Node mode with a private profile.
 * Usage: node verify-desktop-runtime.mjs [desktop-install-directory]
 *        DSH_DESKTOP_DIR may supply the directory instead.
 * Build first. No CLI installation, package installation, GUI launch, user profile,
 * registry write, or inherited credential is used by this check.
 * --plugin-dir DIR tests another built package; --expect-disabled and --enable
 * reproduce an older bundle's disabled default and its explicit activation.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const repository = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let desktopDir = process.env.DSH_DESKTOP_DIR
let positionalDesktop = false
let pluginDir = repository
let expectDisabled = false
let enable = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--plugin-dir') pluginDir = args[++index]
  else if (args[index] === '--expect-disabled') expectDisabled = true
  else if (args[index] === '--enable') enable = true
  else if (args[index] === '--help') {
    console.log('Usage: node verify-desktop-runtime.mjs [desktop-install-directory] [--plugin-dir DIR] [--expect-disabled | --enable]')
    process.exit(0)
  } else if (!args[index].startsWith('--') && !positionalDesktop) {
    desktopDir = args[index]
    positionalDesktop = true
  }
  else throw new Error(`Unknown argument: ${args[index]}`)
}
assert.ok(desktopDir, 'Supply the Desktop installation directory or DSH_DESKTOP_DIR; the check never uses a CLI dsh')
assert.ok(pluginDir, '--plugin-dir requires a directory')
assert.ok(!(expectDisabled && enable), '--expect-disabled and --enable are mutually exclusive')
desktopDir = resolve(desktopDir)
pluginDir = resolve(pluginDir)
const executableNames = process.platform === 'win32'
  ? ['DeepSeek Harness.exe']
  : process.platform === 'darwin' ? ['Contents/MacOS/DeepSeek Harness'] : ['deepseek-harness', 'DeepSeek Harness']
const executable = executableNames.map(name => join(desktopDir, name)).find(existsSync)
assert.ok(executable, `Desktop executable missing in ${desktopDir}`)
const resources = join(desktopDir, process.platform === 'darwin' ? 'Contents/Resources' : 'resources')
// Packaged JavaScript is inside ASAR; app.asar.unpacked contains native payloads only.
const runtimeDir = existsSync(join(resources, 'app.asar')) ? join(resources, 'app.asar', 'dsh') : join(resources, 'dsh')
const dependenciesDir = join(resources, 'runtime')
const hostEntry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
const packageManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
assert.equal(packageManifest.name, 'dsh-environment-tray')
assert.ok(existsSync(join(pluginDir, 'lib', 'index.js')), 'Run the plugin build before testing Desktop')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-environment-tray-desktop-'))
const home = join(scratch, 'harness-home')
const profile = join(home, 'profiles', 'desktop')
const project = join(scratch, 'project')
const fakeUserHome = join(scratch, 'user')
const privateTemp = join(scratch, 'temp')
for (const directory of [profile, project, fakeUserHome, privateTemp, join(fakeUserHome, 'AppData', 'Roaming'), join(fakeUserHome, 'AppData', 'Local')]) {
  mkdirSync(directory, { recursive: true })
}
// An allowlist avoids inheriting API keys, proxy credentials, NODE_OPTIONS, or user settings.
const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']
  .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
Object.assign(environment, {
  ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, HOME: fakeUserHome, USERPROFILE: fakeUserHome,
  APPDATA: join(fakeUserHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(fakeUserHome, 'AppData', 'Local'),
  TMP: privateTemp, TEMP: privateTemp, TMPDIR: privateTemp, PATH: '',
  DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_VERSION: 'isolated-plugin-verification',
  ENVIRONMENT_TRAY_DESKTOP_PROCESS: 'synthetic-process-value',
})
const fixtureName = 'ENVIRONMENT_TRAY_DESKTOP_TEST'
const fixtureToken = 'ENVIRONMENT_TRAY_DESKTOP_TEST_TOKEN'
writeFileSync(join(project, '.env'), `${fixtureName}=synthetic-before\n`)
writeFileSync(join(home, '.env'), 'ENVIRONMENT_TRAY_DESKTOP_HOME=synthetic-home-value\n')
const runExecutable = promisify(execFile)
let child
let childClosed
let acknowledgedShutdown = false
let diagnostic = ''
let checks = 0
const check = (label, condition) => {
  assert.ok(condition, label)
  checks++
  console.log(`PASS ${label}`)
}
const within = async (promise, milliseconds, label) => {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

try {
  // Electron's fs reads ASAR, whereas the external Node running this test cannot.
  const { stdout } = await runExecutable(executable, ['--expose-internals', '-e', `
    const fs = require('node:fs');
    const root = ${JSON.stringify(runtimeDir)};
    const read = name => JSON.parse(fs.readFileSync(root + '/node_modules/' + name + '/package.json', 'utf8'));
    console.log(JSON.stringify({ host: read('@deepseek-ai/dsh-desktop-host').version,
      harness: read('@deepseek-ai/dsh').version, cordis: read('@deepseek-ai/cordis').version,
      node: process.version, entryExists: fs.existsSync(${JSON.stringify(hostEntry)}) }));
  `], { cwd: profile, env: environment, timeout: 30_000, windowsHide: true })
  const runtime = JSON.parse(stdout.trim())
  check('installed Desktop Host and matching Harness runtime are available', runtime.entryExists && runtime.host === runtime.harness)
  console.log(`Desktop ${runtime.host}; Electron Node ${runtime.node}; Cordis ${runtime.cordis}`)

  const modules = join(profile, 'node_modules')
  const plugin = join(modules, packageManifest.name)
  mkdirSync(plugin, { recursive: true })
  // Copy publishable artifacts only; never link the repository's dev dependencies.
  for (const directory of ['lib', 'locale', 'docs']) {
    if (existsSync(join(pluginDir, directory))) cpSync(join(pluginDir, directory), join(plugin, directory), { recursive: true })
  }
  cpSync(join(pluginDir, 'package.json'), join(plugin, 'package.json'))
  const patches = typeof packageManifest.dsh.bundle.patch === 'string'
    ? [packageManifest.dsh.bundle.patch] : packageManifest.dsh.bundle.patch
  for (const patch of patches) {
    const target = resolve(plugin, patch)
    const local = relative(plugin, target)
    assert.ok(local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), 'Bundle patch must stay inside the copied package')
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(pluginDir, patch), target)
  }
  if (packageManifest.icon) {
    const local = relative(pluginDir, resolve(pluginDir, packageManifest.icon))
    assert.ok(local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local))
    mkdirSync(dirname(join(plugin, local)), { recursive: true })
    cpSync(resolve(pluginDir, packageManifest.icon), join(plugin, local))
  }

  const probeName = 'dsh-environment-tray-desktop-runtime-probe'
  const probe = join(modules, probeName)
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'package.json'), JSON.stringify({
    name: probeName, version: '1.0.0', type: 'module', exports: './index.js',
    // Use the plugin's own Cordis declaration to verify the real shared resolver.
    peerDependencies: packageManifest.peerDependencies,
    dsh: { bundle: { patch: './bundle.yml' } },
  }))
  writeFileSync(join(probe, 'bundle.yml'), `- insert:\n    - id: ${probeName}\n      name: ${probeName}\n`)
  writeFileSync(join(probe, 'index.js'), `
import { Context } from '@deepseek-ai/cordis'
export const inject = ['webServer', 'pluginManager', 'clientModules', 'loader', 'connection']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/environment-tray-runtime-probe',
    async handler(request, response) {
      const rejection = ctx.connection.requestRejection(request)
      if (rejection !== undefined) { response.writeHead(rejection); response.end(); return }
      const bundle = (await ctx.pluginManager.listBundles()).find(item => item.name === 'dsh-environment-tray')
      const entries = [...ctx.loader.entries()].filter(entry => entry.options.id === 'dsh-environment-tray')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ singleton: ctx instanceof Context, bundle,
        entries: entries.map(entry => ({ disabled: entry.options.disabled === true, state: entry.fiber?.state })),
        graph: ctx.clientModules.graph(), processValue: process.env.ENVIRONMENT_TRAY_DESKTOP_TEST,
        home: process.env.DSH_HOME }))
    } }))
}
`)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true,
    dependencies: { [packageManifest.name]: packageManifest.version, [probeName]: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageManifest.name, probeName] } },
  }))
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n${enable ? '- id: dsh-environment-tray\n  disabled: false\n' : ''}`)

  child = spawn(executable, ['--expose-internals', hostEntry, runtimeDir, profile,
    join(dependenciesDir, 'primary-runtime'), join(dependenciesDir, 'pnpm', 'bin', 'pnpm.cjs'), join(dependenciesDir, 'bin')], {
    cwd: profile, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  })
  childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  for (const output of [child.stdout, child.stderr]) {
    output.setEncoding('utf8')
    output.on('data', text => { diagnostic = (diagnostic + text).slice(-64 * 1024) })
  }
  const ready = await within(new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady)
    child.once('close', code => rejectReady(new Error(`Desktop Host exited before readiness (${code})`)))
    child.on('message', message => {
      if (message?.type === 'ready') resolveReady(message)
      if (message?.type === 'fatal') rejectReady(new Error(`Desktop Host startup failed: ${message.message}`))
      if (message?.type === 'shutdown-complete') acknowledgedShutdown = true
    })
  }), 60_000, 'Desktop Host did not become ready within 60 seconds')
  const base = new URL(ready.url)
  check('private Desktop Host starts on an OS-assigned loopback port', base.hostname === '127.0.0.1' && base.port !== '19387')
  const login = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  check('Desktop authentication issues a private browser session', cookie.length > 0)
  const request = (path, body, authenticated = true) => fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  })
  const getJson = async (path, body) => {
    const response = await request(path, body)
    assert.equal(response.status, 200, `Expected a successful response from ${path.split('?')[0]}`)
    return response.json()
  }
  const inspect = () => getJson('/environment-tray-runtime-probe')
  const observed = await inspect()
  check('external plugin resolves the Desktop Cordis singleton', observed.singleton)
  check('bundle manager discovers the copied plugin in the isolated profile', observed.bundle?.installed && observed.bundle?.enabled && !observed.bundle?.error)
  check('Host uses only the temporary Harness home', observed.home === home)
  const row = observed.graph.entries.find(item => item.id === packageManifest.name)
  if (expectDisabled) {
    const health = await request('/api/dsh-environment-tray/health')
    check('legacy disabled bundle row prevents Host route registration', health.status === 404 && observed.entries[0]?.disabled)
    check('legacy disabled bundle row also removes browser factory discovery', row === undefined)
  } else {
    const health = await getJson('/api/dsh-environment-tray/health')
    check('plugin mounts and its authenticated health route succeeds', health.ok && health.pid === child.pid)
    check('browser boot graph discovers the environment plugin', row !== undefined)
    check('locale dependency is represented in the real browser boot graph', row.inject.includes('@deepseek-ai/dsh-client-locale'))
    const page = await request('/')
    check('packaged Desktop frontend is served by the same Host', page.status === 200 && (await page.text()).includes('<html'))
    const script = await request(row.url)
    assert.equal(script.status, 200)
    const registrations = []
    runInNewContext(await script.text(), { window: { __ModuleLoader__: { load: entry => registrations.push(entry) } } }, { timeout: 5_000 })
    check('served browser artifact registers the expected lazy factory', registrations.some(entry => entry.id === packageManifest.name && typeof entry.factory === 'function'))
    const meta = observed.bundle.meta
    if (existsSync(join(pluginDir, 'locale', 'zh.json'))) {
      const chinese = JSON.parse(readFileSync(join(pluginDir, 'locale', 'zh.json'), 'utf8')).meta
      const english = JSON.parse(readFileSync(join(pluginDir, 'locale', 'en.json'), 'utf8')).meta
      check('Desktop plugin manager reads both localized titles and entrance descriptions', !meta.error
        && meta.title.zh === chinese.title && meta.description.zh === chinese.description
        && meta.title.en === english.title && meta.description.en === english.description)
    } else {
      check('Desktop plugin manager reads the manifest description fallback', meta?.description === packageManifest.description)
    }

    const query = `?cwd=${encodeURIComponent(project)}`
    const route = name => `/api/dsh-environment-tray/${name}${query}`
    const unauthorized = await request(route('state') + '&os=0', undefined, false)
    check('real Desktop request policy rejects unauthenticated plugin reads', [401, 403].includes(unauthorized.status))
    const state = await getJson(route('state') + '&os=0&reveal=0')
    check('state route reads only synthetic project and home .env fixtures', state.cwd === project && state.home === home && state.variables.some(item => item.name === fixtureName))
    const before = await getJson(route('value'), { name: fixtureName, layer: 'project-env' })
    check('single-value route returns the full fixture value and revision', before.value === 'synthetic-before' && typeof before.revision === 'string')
    const written = await getJson(route('env'), { layer: 'project-env', expectedRevision: before.revision,
      edits: [{ op: 'set', name: fixtureName, value: 'synthetic-after-桌面' }] })
    check('Desktop .env write persists and updates its private Host process', written.appliedToProcess === true && (await inspect()).processValue === 'synthetic-after-桌面'
      && readFileSync(join(project, '.env'), 'utf8').includes('synthetic-after-桌面'))
    const after = await getJson(route('value'), { name: fixtureName, layer: 'project-env' })
    const stale = await request(route('env'), { layer: 'project-env', expectedRevision: before.revision,
      edits: [{ op: 'set', name: fixtureName, value: 'stale-should-not-write' }] })
    check('real Host write route preserves CAS conflict detection', stale.status === 409 && after.revision !== before.revision && (await inspect()).processValue === 'synthetic-after-桌面')
    const secret = 'synthetic-desktop-secret-value'
    const credential = await getJson(route('credentials'), { ref: fixtureToken, value: secret })
    check('private credential write returns status without exposing its value', !JSON.stringify(credential).includes(secret))
    const credentialState = await getJson(`/api/dsh-environment-tray/credential-state?refs=${fixtureToken}`)
    check('private credential state reports configuration without plaintext', credentialState.refs[fixtureToken]?.configured && !JSON.stringify(credentialState).includes(secret))
    const revealed = await getJson(route('value'), { name: fixtureToken, layer: 'credential' })
    check('explicit credential value reads use the Desktop provider', revealed.value === secret)
    await getJson(route('credentials'), { ref: fixtureToken, unset: true })
    const removed = await getJson(`/api/dsh-environment-tray/credential-state?refs=${fixtureToken}`)
    check('private credential deletion reaches the Desktop provider', removed.refs[fixtureToken]?.configured === false)
  }
  child.send({ type: 'shutdown' })
  const exit = await within(childClosed, 15_000, 'Private Desktop Host failed to shut down')
  check('Desktop Host acknowledges graceful shutdown and releases its process', acknowledgedShutdown && exit.code === 0)
  console.log(`Desktop runtime integration: ${checks} PASS / 0 FAIL`)
} catch (error) {
  // Only synthetic private-profile output exists in this child; never print the auth URL/cookie.
  const safeDiagnostic = diagnostic.replace(/([?&]token=)[^\s"<>]+/gu, '$1[redacted]')
  if (safeDiagnostic) console.error(safeDiagnostic)
  throw error
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: 'shutdown' }, () => {})
    try { await within(childClosed, 10_000, 'shutdown timeout') }
    catch {
      child.kill('SIGTERM')
      await within(childClosed, 5_000, 'Private Desktop Host did not exit after termination')
    }
  }
  // Cleanup is restricted to the uniquely created test directory after child exit.
  assert.ok(basename(scratch).startsWith('dsh-environment-tray-desktop-') && dirname(scratch) === resolve(tmpdir()))
  rmSync(scratch, { recursive: true, force: true })
}
