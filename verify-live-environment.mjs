import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { LiveEnvironment } from './lib/live-environment.js'
import { createWriteRoutes } from './lib/write-routes.js'
import { createHostApi } from './lib/host-api.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-live-env-'))
const cwd = join(scratch, 'project')
const home = join(scratch, 'home')
mkdirSync(cwd); mkdirSync(home)
const name = 'ENVIRONMENT_TRAY_LIVE_TEST'
const query = '?cwd=' + encodeURIComponent(cwd)
const osValues = { 'os-user': new Map(), 'os-machine': new Map() }
let readFailure = false
const osLayer = {
  supported: true,
  async readAll() {
    return Object.fromEntries(Object.entries(osValues).map(([scope, entries]) => [scope, {
      entries: [...entries].map(([name, value]) => ({ name, ...value })), error: readFailure ? 'failed' : undefined,
    }]))
  },
  async write(scope, name, value, type = 'REG_SZ') {
    osValues[scope].set(name, { value, type })
    return { ok: true, type }
  },
  async remove(scope, name) {
    const old = osValues[scope].get(name)
    osValues[scope].delete(name)
    return { ok: true, removed: old && { name, ...old } }
  },
}
const req = (body, method = 'POST', url = '/api/dsh-environment-tray/value' + query) => ({
  method, url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
})
const res = () => ({
  status: 0, headers: {}, body: undefined,
  writeHead(status, headers) { this.status = status; this.headers = headers },
  end(text) { this.body = text ? JSON.parse(text) : undefined },
})
let checks = 0
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log('PASS ' + label) }
const launch = { getFrom: () => undefined }
const runtime = new LiveEnvironment({ launch, osLayer })
const routes = createWriteRoutes({ ctx: {}, osLayer, runtime, guard: () => true, homeOf: () => home })
const call = async (handler, body) => { const response = res(); await handler(req(body), response); return response }
const envWrite = async (layer, edits, expectedRevision) => {
  const revision = expectedRevision ?? (await call(routes.envRead, { layer })).body.revision
  return call(routes.env, { layer, expectedRevision: revision, edits })
}
const registryWrite = (scope, value, extra = {}) => call(routes.registry, { scope, name, value, ...extra })
const childValue = () => execFileSync(process.execPath, ['-e', `process.stdout.write(process.env.${name} ?? '')`], { encoding: 'utf8' })
const initial = process.env[name]
const initialBase = process.env.ENVIRONMENT_TRAY_BASE
try {
  writeFileSync(join(home, '.env'), `${name}=fallback\n`)
  let response = await call(routes.env, { layer: 'project-env', createOnly: true, expectedRevision: 'absent', edits: [{ op: 'set', name, value: 'live-值' }] })
  check('creating a .env variable updates the current process', response.status === 200 && process.env[name] === 'live-值')
  check('ordinary variables need no restart', response.body.appliedToProcess === true && response.body.restartRequired === false)
  check('a newly spawned real child reads the saved value', childValue() === 'live-值')
  check('the value was persisted too', readFileSync(join(cwd, '.env'), 'utf8').includes('live-值'))
  response = await envWrite('user-env', [{ op: 'set', name, value: 'home-changed' }])
  check('editing a lower .env layer preserves project precedence', process.env[name] === 'live-值')
  response = await envWrite('project-env', [{ op: 'unset', name }])
  check('deleting project value falls back to user .env immediately', childValue() === 'home-changed')
  response = await envWrite('user-env', [{ op: 'unset', name }])
  check('deleting the last .env value removes the stale process copy', process.env[name] === undefined && childValue() === '')
  response = await envWrite('project-env', [{ op: 'set', name, value: 'lost' }], 'stale')
  check('CAS failure neither persists nor updates runtime', response.status === 409 && process.env[name] === undefined)

  process.env.ENVIRONMENT_TRAY_BASE = 'C:\\tools'
  response = await registryWrite('os-user', '%ENVIRONMENT_TRAY_BASE%\\bin', { type: 'REG_EXPAND_SZ', createOnly: true })
  check('creating a registry variable updates the current process before responding', response.status === 200 && process.env[name] === 'C:\\tools\\bin')
  check('expandable registry values are expanded for the running process', childValue() === 'C:\\tools\\bin')
  osValues['os-machine'].set(name, { value: 'machine-fallback', type: 'REG_SZ' })
  response = await registryWrite('os-user', undefined, { unset: true })
  check('registry deletion retains an undo record with the original type', response.body.undo.type === 'REG_EXPAND_SZ')
  check('registry deletion falls back to the machine layer immediately', childValue() === 'machine-fallback')
  await registryWrite('os-machine', undefined, { unset: true })
  check('last registry deletion removes the runtime value', process.env[name] === undefined)
  const undo = response.body.undo
  response = await call(routes.registry, { scope: 'os-user', ...undo })
  check('undo also restores the live expanded value', response.status === 200 && childValue() === 'C:\\tools\\bin')
  readFailure = true
  response = await registryWrite('os-user', 'saved-but-not-live')
  check('runtime read failure reports persistence separately', response.status === 200 && response.body.appliedToProcess === false && response.body.restartRequired === true)
  check('runtime failure keeps the previous process value', childValue() === 'C:\\tools\\bin')
  readFailure = false

  const cachedEnv = { ENVIRONMENT_TRAY_CACHED: 'boot-value' }
  const cachedRuntime = new LiveEnvironment({ env: cachedEnv, launch: {
    getFrom: () => ({ source: 'process', value: 'boot-value' }),
  }, osLayer })
  await cachedRuntime.sync({ layer: 'os-user', names: ['ENVIRONMENT_TRAY_CACHED'], cwd, home, removed: { name: 'ENVIRONMENT_TRAY_CACHED', value: 'boot-value' } })
  check('deletion never resurrects an inherited registry copy', cachedEnv.ENVIRONMENT_TRAY_CACHED === undefined)

  const fakeSecret = 'synthetic-secret-' + 'x'.repeat(300)
  const secretName = 'ENVIRONMENT_TRAY_TEST_TOKEN'
  response = await envWrite('project-env', [{ op: 'set', name: secretName, value: fakeSecret }])
  check('dotenv credential fallback reports its immutable launch limitation', response.body.restartRequired === true)
  check('write responses contain no secret value', !JSON.stringify(response.body).includes(fakeSecret))
  let resolves = 0
  const provider = {
    async resolve() { resolves++; return { value: fakeSecret, source: 'file' } },
    async describe() { return { configured: true, writable: true, source: 'file' } },
    async set() {}, async unset() {}, async listRecords() { return [] },
  }
  const api = createHostApi({ ctx: { credentials: provider }, osLayer, guard: () => true })
  response = await call(api.value, { name: secretName, layer: 'project-env' })
  check('per-item reads return the full dotenv value and its CAS revision', response.body.value === fakeSecret && typeof response.body.revision === 'string')
  check('plaintext responses are never cacheable', response.headers['cache-control'] === 'no-store')
  response = await call(api.value, { name: secretName, layer: 'credential' })
  check('credentials are resolved only on explicit per-item reads', response.body.value === fakeSecret && resolves === 1)
  const stateResponse = res()
  await api.credentialState(req({}, 'GET', '/api/dsh-environment-tray/credential-state?refs=' + secretName), stateResponse)
  check('credential list state still uses describe without exposing a value', resolves === 1 && !JSON.stringify(stateResponse.body).includes(fakeSecret))
  const blocked = createHostApi({ ctx: { credentials: provider }, osLayer, guard: (_, response) => { response.writeHead(401); response.end(); return false } })
  response = await call(blocked.value, { name: secretName, layer: 'credential' })
  check('unauthorized plaintext reads never reach the provider', response.status === 401 && resolves === 1)
  response = res(); await api.value(req({ name: secretName, layer: 'credential' }, 'GET'), response)
  check('GET cannot read plaintext', response.status === 405 && resolves === 1)
  for (const [body, code] of [
    [{ name: [], layer: 'process' }, 'invalid-name'],
    [{ name, layer: '../private' }, 'invalid-layer'],
    [{ name: '', layer: 'credential' }, 'invalid-name'],
  ]) {
    response = await call(api.value, body)
    check('malformed single-value request is rejected with a localizable code', response.status === 400 && response.body.value === undefined && response.body.error === code)
  }
  response = await call(api.value, { name: 'ENVIRONMENT_TRAY_MISSING', layer: 'process' })
  check('missing values return a localizable 404 instead of an invented empty value', response.status === 404 && response.body.error === 'value-missing')
  provider.resolve = async () => { throw new Error(fakeSecret) }
  response = await call(api.value, { name: secretName, layer: 'credential' })
  check('provider errors return a localizable code without leaking plaintext', response.status === 500 && response.body.error === 'read-failed' && !JSON.stringify(response.body).includes(fakeSecret))
  const guardedEnv = { ENVIRONMENT_TRAY_BATCH_A: 'old-a', ENVIRONMENT_TRAY_BATCH_B: 'old-b' }
  writeFileSync(join(cwd, '.env'), 'ENVIRONMENT_TRAY_BATCH_A=new-a\nENVIRONMENT_TRAY_BATCH_B="bad\0value"\n')
  const guardedRuntime = new LiveEnvironment({ env: guardedEnv, osLayer, launch })
  const guardedResult = await guardedRuntime.sync({ layer: 'project-env', names: Object.keys(guardedEnv), cwd, home })
  check('unrepresentable runtime values cannot be silently truncated', guardedResult.appliedToProcess === false && guardedResult.restartRequired === true)
  check('a rejected runtime batch leaves all previous values intact', guardedEnv.ENVIRONMENT_TRAY_BATCH_A === 'old-a' && guardedEnv.ENVIRONMENT_TRAY_BATCH_B === 'old-b')
  if (process.platform === 'win32') {
    osValues['os-user'].set('Path', { value: '%ENVIRONMENT_TRAY_BASE%\\user-bin', type: 'REG_EXPAND_SZ' })
    osValues['os-machine'].set('PATH', { value: 'C:\\Windows\\System32', type: 'REG_SZ' })
    const pathEnv = { Path: 'old-merged-path', ENVIRONMENT_TRAY_BASE: 'C:\\tools' }
    const pathRuntime = new LiveEnvironment({ env: pathEnv, osLayer, launch })
    await pathRuntime.sync({ layer: 'os-user', names: ['PATH'], cwd, home })
    check('Windows PATH combines the machine path with the expanded user path', pathEnv.Path === 'C:\\Windows\\System32;C:\\tools\\user-bin')
    osValues['os-user'].delete('Path')
    await pathRuntime.sync({ layer: 'os-user', names: ['PATH'], cwd, home })
    check('deleting user PATH preserves the machine PATH immediately', pathEnv.Path === 'C:\\Windows\\System32')
  }
  delete process.env[secretName]
  console.log(`\nLive environment and per-item reads: ${checks} PASS / 0 FAIL`)
} finally {
  if (initial === undefined) delete process.env[name]; else process.env[name] = initial
  if (initialBase === undefined) delete process.env.ENVIRONMENT_TRAY_BASE; else process.env.ENVIRONMENT_TRAY_BASE = initialBase
  delete process.env.ENVIRONMENT_TRAY_TEST_TOKEN
  rmSync(scratch, { recursive: true, force: true })
}
