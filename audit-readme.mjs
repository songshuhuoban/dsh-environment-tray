// User documentation must keep its screenshots and local links accessible.
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
let checked = 0
for (const [, target] of readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
  const path = target.trim().replace(/^<|>$/g, '').split('#')[0]
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue
  assert.ok(statSync(resolve(root, decodeURIComponent(path)), { throwIfNoEntry: false })?.isFile(),
    `README references a missing file: ${path}`)
  checked += 1
}
console.log(`README links checked: ${checked}`)
