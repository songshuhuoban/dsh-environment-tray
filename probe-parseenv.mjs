// Evidence probe for docs/dsh-env-manager-design.md §4.1.
// Answers: what does node:util.parseEnv actually accept, and does it expand refs?
// This decides how the plugin serializes .env output.
//
// Run: node tmp-parseenv-probe.mjs
// Verified on Node v24.16.0 (Volta) — the same runtime the local DSH process uses.
import { parseEnv } from 'node:util'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.OUTER = 'from-process'

const cases = [
  ['a export prefix ', 'export MY=1'],
  ['b in-file ref   ', 'A=1\nB=$A\n'],
  ['c brace ref     ', 'C=${OUTER}'],
  ['d bare ref      ', 'D=$OUTER'],
  ['e dquote escape ', 'E="x\\ny"'],
  ['f squote literal', "F='$OUTER'"],
  ['g colon sep     ', 'G: v'],
  ['h trailing note ', 'H=1 # tail'],
  ['i multiline dq  ', 'I="l1\nl2"'],
  ['j empty value   ', 'J='],
  ['k spaces        ', '  K = spaced  '],
  ['l export dquote ', 'export L="1"'],
]

console.log('node', process.version, '| execPath', process.execPath)
console.log('--- parseEnv ---')
for (const [label, src] of cases) {
  try {
    console.log(label, JSON.stringify(parseEnv(src)))
  } catch (e) {
    console.log(label, 'THROWS:', e.constructor.name, '-', String(e.message).slice(0, 80))
  }
}

// Second path: does loadEnvFile expand refs once values land in process.env?
const dir = mkdtempSync(join(tmpdir(), 'dsh-envprobe-'))
const file = join(dir, '.env')
writeFileSync(file, 'AAA=1\nBBB=$AAA\nCCC=${AAA}\nDDD=%AAA%\n')
process.loadEnvFile(file)
console.log('--- loadEnvFile ---')
console.log(JSON.stringify({
  AAA: process.env.AAA,
  BBB: process.env.BBB,
  CCC: process.env.CCC,
  DDD: process.env.DDD,
}))

