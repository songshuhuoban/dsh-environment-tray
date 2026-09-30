import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(manifest.name, 'dsh-environment-tray')
assert.equal(manifest.private, undefined, 'the package must be publishable')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(manifest.dsh?.client?.platform, 'web')
assert.equal(manifest.exports?.['.'], './lib/index.js')
assert.equal(manifest.exports?.['./client'], './lib/client.js')
assert.equal(manifest.exports?.['./locale/*.json'], './locale/*.json')

// Ignore lifecycle scripts here: release:check already built and tested the exact tree.
// This asks npm itself which files its publish operation would include.
const output = execSync('npm pack --dry-run --json --ignore-scripts', {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
const [pack] = JSON.parse(output)
assert.equal(pack.name, manifest.name)
assert.equal(pack.version, manifest.version)
const actual = new Set(pack.files.map(({ path }) => path))
const expected = new Set([
  'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml',
  'locale/en.json', 'locale/zh.json',
  'docs/images/environment-entry.png',
  'docs/releasing.md', 'docs/dsh-environment-tray-design.md',
  'lib/index.js', 'lib/client.js', 'lib/env-model.js', 'lib/env-write.js',
  'lib/credentials.js', 'lib/registry.js', 'lib/host-api.js',
  'lib/write-routes.js', 'lib/live-environment.js',
])
assert.deepEqual([...actual].sort(), [...expected].sort(),
  `Unexpected npm tarball contents: ${[...actual].sort().join(', ')}`)

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
assert.match(patch, /^\s+- id: dsh-environment-tray\s*$/m)
assert.match(patch, /^\s+name: dsh-environment-tray\s*$/m)
assert.match(patch, /^\s+disabled: false\s*$/m,
  'enabling the bundle in Desktop must also activate its component')

for (const locale of ['en', 'zh']) {
  const dictionary = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
  assert.equal(typeof dictionary.meta?.title, 'string')
  assert.equal(typeof dictionary.meta?.description, 'string')
  assert.ok(dictionary.meta.title.trim())
  assert.ok(dictionary.meta.description.trim())
}

console.log(`Package check passed: ${pack.filename}, ${actual.size} files, ${pack.size} bytes`)
