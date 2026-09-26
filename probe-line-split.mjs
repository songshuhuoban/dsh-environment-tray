/**
 * 探针：行拆分正则到底产出什么。
 *
 * 我连续猜错了两次，这次把 exec 的每一步打出来。
 *
 * 运行：node probe-line-split.mjs
 */

const SAMPLES = ['A=1\n', 'A=1\n\n', 'A=1\n\n\n', 'A=1', '', '\n', 'A=1\r\n\r\n']

function trace(pattern, text) {
  const re = new RegExp(pattern.source, 'g')
  const steps = []
  let match
  let guard = 0
  while ((match = re.exec(text)) !== null) {
    steps.push({
      index: match.index,
      g1: match[1],
      g2: match[2],
      lastIndex: re.lastIndex,
    })
    guard += 1
    if (guard > 20) {
      steps.push({ note: 'guard tripped — likely zero-width infinite loop' })
      break
    }
  }
  return steps
}

const patterns = [
  ['current', /([^\r\n]*)(\r\n|\n|\r|)/g],
  ['explicit', /([^\r\n]*)(\r\n|\n|\r|$)/g],
]

for (const [label, pattern] of patterns) {
  console.log(`\n=== pattern: ${label}  ${String(pattern)} ===`)
  for (const text of SAMPLES) {
    const steps = trace(pattern, text)
    const rebuilt = steps
      .filter((s) => !(s.g1 === '' && s.g2 === ''))
      .map((s) => s.g1 + s.g2)
      .join('')
    console.log(
      `${JSON.stringify(text).padEnd(16)} steps=${String(steps.length).padEnd(3)} identity=${rebuilt === text ? 'OK ' : 'BAD'}  ` +
        steps.map((s) => `[${JSON.stringify(s.g1)}|${JSON.stringify(s.g2)}]`).join(''),
    )
  }
}
