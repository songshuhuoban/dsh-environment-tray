/**
 * 探针：注册表写入是否有 `.env` 那种并发丢失。
 *
 * 推理上的差别：`.env` 是**整文件**读-改-写，所以并发会互相覆盖；
 * 而 `reg.exe add` 是**按值的原子 OS 操作**，理论上不该丢。
 * 但这是推理，必须实测 —— 上一个"理论上 CAS 够用"的推理就是错的。
 *
 * 自建变量名，`finally` 无条件清理。
 *
 * 运行：node probe-registry-race.mjs
 */

import { execFileSync } from 'node:child_process'
import { OsEnvironmentLayer, USER_SCOPE } from './lib/registry.js'

const TAG = `DSH_ENV_MANAGER_RACE_${String(process.pid)}`
const N = 8

const run = async (args) => execFileSync('reg.exe', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
const layer = new OsEnvironmentLayer({ run, platform: 'win32' })

/** 无条件清掉本次探针的全部痕迹。 */
function cleanup() {
  for (let i = 0; i < N; i += 1) {
    try {
      execFileSync('reg.exe', ['delete', 'HKCU\\Environment', '/v', `${TAG}_${String(i)}`, '/f'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      /* 不存在属预期 */
    }
  }
}

cleanup()

try {
  // 并发写入 N 个**不同名字**的值
  const results = await Promise.all(
    Array.from({ length: N }, (_v, i) => layer.write(USER_SCOPE, `${TAG}_${String(i)}`, `value-${String(i)}`, 'REG_SZ')),
  )

  const okCount = results.filter((r) => r.ok === true).length
  console.log(`并发写入数      : ${N}`)
  console.log(`报告成功        : ${okCount}`)

  // 独立读回（不信 layer 自己的报告）
  const after = await layer.read(USER_SCOPE)
  const survived = after.entries.filter((e) => e.name.startsWith(TAG))
  console.log(`独立读回存活    : ${survived.length}`)

  const allValuesCorrect = Array.from({ length: N }, (_v, i) => `value-${String(i)}`).every((want, i) =>
    survived.some((e) => e.name === `${TAG}_${String(i)}` && e.value === want),
  )
  console.log(`每个值都正确    : ${allValuesCorrect}`)
  console.log()

  if (okCount === N && survived.length === N && allValuesCorrect) {
    console.log('✅ 注册表没有同类竞态：每个值都是独立的原子 OS 操作，并发不互相覆盖。')
    console.log('   （与 .env 的整文件读-改-写有本质差别，所以不需要额外的临界区。）')
  } else {
    console.log('❌ 注册表也存在并发丢失，需要按 scope 串行化。')
    console.log('   存活明细:', survived.map((e) => `${e.name}=${e.value}`).join(', '))
  }
} finally {
  cleanup()
  const residue = (execFileSync('reg.exe', ['query', 'HKCU\\Environment'], { windowsHide: true }).toString('utf8').match(new RegExp(TAG, 'g')) ?? []).length
  console.log(`\n(cleanup 完成；残留 ${String(residue)} 项，应为 0)`)
}
