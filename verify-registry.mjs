/**
 * P5 验证：Windows 注册表层。
 *
 * 这一层的风险有两类：
 *  1. **解析错**：`reg.exe` 输出是固定列宽 + 控制台代码页，解析错了会显示
 *     错误的变量名或值，而用户会据此做决定。
 *  2. **写坏**：把 `REG_EXPAND_SZ` 写回成 `REG_SZ` 会破坏 `%USERPROFILE%`
 *     这类引用。
 *
 * 所以：解析用**真实 `reg.exe` 输出**验证，读取用**真实注册表**验证，
 * 写入用假执行器验证（不碰系统状态）。
 *
 * 运行：node verify-registry.mjs
 */

import {
  OsEnvironmentLayer,
  USER_SCOPE,
  MACHINE_SCOPE,
  parseRegQuery,
  decodeRegOutput,
  normalizeKeyPath,
  mergeOsLayers,
} from './lib/registry.mjs'
import { execFileSync } from 'node:child_process'

let failures = 0
const ok = (label, condition, detail = '') => {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. 解析真实的 reg.exe 输出 ──────────────────────────────────────────────
console.log('--- parse real reg.exe output ---')

// 逐字取自本机 `reg query HKCU\Environment`
const REAL_USER_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '    TMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '',
].join('\r\n')

const KEY_USER = 'HKCU\\Environment'
{
  const entries = parseRegQuery(REAL_USER_OUTPUT, KEY_USER)
  ok('parses every value line', entries.length === 3, String(entries.length))
  ok('parses names', entries.map((e) => e.name).join(',') === 'Path,TEMP,TMP', entries.map((e) => e.name).join(','))
  ok('parses types', entries.every((e) => e.type === 'REG_EXPAND_SZ'))
  ok(
    'parses values with %VAR% intact (no expansion)',
    entries[0].value.includes('%USERPROFILE%'),
    entries[0].value,
  )
  ok('does not mistake the key header for a value', !entries.some((e) => e.name.includes('HKEY')))
}

// 带子键的递归输出：子键的值必须被排除
const OUTPUT_WITH_SUBKEY = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    C:\\bin',
  '',
  'HKEY_CURRENT_USER\\Environment\\SubKey',
  '    INNER    REG_SZ    should-not-appear',
  '',
].join('\r\n')
{
  const entries = parseRegQuery(OUTPUT_WITH_SUBKEY, KEY_USER)
  ok('subkey values are excluded', !entries.some((e) => e.name === 'INNER'), entries.map((e) => e.name).join(','))
  ok('own values still parsed alongside a subkey', entries.length === 1 && entries[0].name === 'Path')
}

// 默认值、DWORD、多值
const MIXED_OUTPUT = [
  'HKEY_CURRENT_USER\\Environment',
  '    (Default)    REG_SZ    default-data',
  '    COUNT    REG_DWORD    0x10',
  '    MULTI    REG_MULTI_SZ    a\\0b',
  '    PLAIN    REG_SZ',
  '',
].join('\r\n')
{
  const entries = parseRegQuery(MIXED_OUTPUT, KEY_USER)
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
  ok('(Default) maps to the empty name', byName[''] !== undefined && byName[''].value === 'default-data', JSON.stringify(byName['']))
  ok('REG_DWORD is kept with its raw hex text', byName.COUNT?.type === 'REG_DWORD' && byName.COUNT.value === '0x10', JSON.stringify(byName.COUNT))
  ok('REG_MULTI_SZ is parsed', byName.MULTI?.type === 'REG_MULTI_SZ', JSON.stringify(byName.MULTI))
  ok('a value with no data yields empty string', byName.PLAIN?.value === '', JSON.stringify(byName.PLAIN))
}

// 大小写不敏感的键头匹配
{
  const entries = parseRegQuery('hkey_current_user\\Environment\r\n    A    REG_SZ    1\r\n', KEY_USER)
  ok('key header match is case-insensitive', entries.length === 1 && entries[0].name === 'A', JSON.stringify(entries))
}

// 解码：不应抛错（控制台代码页可能不是 UTF-8）
{
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // "中文" 的 GBK 编码
  let threw
  let decoded
  try {
    decoded = decodeRegOutput(gbkBytes)
  } catch (error) {
    threw = error
  }
  ok('decodeRegOutput never throws on non-UTF8 bytes', threw === undefined, String(threw))
  ok('decodeRegOutput returns a string', typeof decoded === 'string')
}

// ── 2. 真实注册表读取（只读，安全）──────────────────────────────────────────
console.log('\n--- live registry read (read-only) ---')

const nodeRun = async (args) => {
  // reg.exe 的输出是控制台代码页，必须拿原始字节
  const buffer = execFileSync('reg.exe', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return buffer
}

const layer = new OsEnvironmentLayer({ run: nodeRun, platform: 'win32' })
{
  const live = await layer.readAll()
  const userCount = live[USER_SCOPE].entries.length
  const machineCount = live[MACHINE_SCOPE].entries.length

  ok('user scope read succeeded', live[USER_SCOPE].error === undefined, String(live[USER_SCOPE].error))
  ok('machine scope read succeeded', live[MACHINE_SCOPE].error === undefined, String(live[MACHINE_SCOPE].error))
  ok('user scope has values', userCount > 0, String(userCount))
  ok('machine scope has values', machineCount > 0, String(machineCount))

  const userNames = live[USER_SCOPE].entries.map((e) => e.name.toUpperCase())
  const machineNames = live[MACHINE_SCOPE].entries.map((e) => e.name.toUpperCase())
  ok('user scope contains PATH', userNames.includes('PATH'), userNames.join(','))
  ok('machine scope contains PATH', machineNames.includes('PATH'), machineNames.join(','))

  // PATH 必须存在于两层 → 这解释了为什么 Windows 上 PATH 是"合并"的
  const userPath = live[USER_SCOPE].entries.find((e) => e.name.toUpperCase() === 'PATH')
  const machinePath = live[MACHINE_SCOPE].entries.find((e) => e.name.toUpperCase() === 'PATH')
  const merged = OsEnvironmentLayer.mergePath(userPath?.value, machinePath?.value)
  ok('PATH merges machine-first', merged.order.join(',') === 'os-machine,os-user', merged.order.join(','))
  ok('merged PATH starts with the machine portion', merged.combined.startsWith(machinePath.value.slice(0, 20)), merged.combined.slice(0, 60))
  ok('merged PATH contains a separator', merged.combined.includes(';'))

  // 与 process.env 对照：PATH 的进程值应当包含注册表系统段
  ok(
    'process PATH (if present) contains the machine PATH segment',
    typeof process.env.PATH !== 'string' || process.env.PATH.includes(machinePath.value.split(';')[0]),
    'machine first segment: ' + machinePath.value.split(';')[0],
  )
}

// ── 3. 写入：用假执行器，绝不碰真实注册表 ───────────────────────────────────
console.log('\n--- write path (fake runner, real registry untouched) ---')
{
  const calls = []
  const fake = new OsEnvironmentLayer({
    platform: 'win32',
    run: async (args) => {
      calls.push(args)
      return Buffer.from('')
    },
  })

  const result = await fake.write(USER_SCOPE, 'MY_VAR', 'my-value', 'REG_SZ')
  ok('write reports success', result.ok === true, JSON.stringify(result))
  ok('write targets HKCU\\Environment', calls[0]?.includes('HKCU\\Environment'), JSON.stringify(calls[0]))
  ok('write uses /v with the name', calls[0]?.includes('MY_VAR'))
  ok('write uses the given type', calls[0]?.includes('REG_SZ'))
  ok('write is forced (/f) so it does not prompt', calls[0]?.includes('/f'))

  calls.length = 0
  await fake.write(USER_SCOPE, 'PCT_VAR', '%USERPROFILE%\\bin', 'REG_EXPAND_SZ')
  ok('REG_EXPAND_SZ is preserved verbatim', calls[0]?.includes('REG_EXPAND_SZ'), JSON.stringify(calls[0]))
  ok('the %VAR% text is passed through unexpanded', calls[0]?.includes('%USERPROFILE%\\bin'), JSON.stringify(calls[0]))

  calls.length = 0
  await fake.write(USER_SCOPE, 'WEIRD', 'v', 'NOT_A_TYPE')
  ok('an unknown type degrades to REG_SZ', calls[0]?.includes('REG_SZ'), JSON.stringify(calls[0]))

  calls.length = 0
  await fake.write(MACHINE_SCOPE, 'SYS_VAR', 'v')
  ok('machine scope targets the machine key', calls[0]?.some((a) => String(a).includes('Session Manager')), JSON.stringify(calls[0]))

  calls.length = 0
  const removed = await fake.remove(USER_SCOPE, 'MY_VAR')
  ok('remove reports success', removed.ok === true)
  // remove 现在会**先读一次做备份**，再删 —— 所以不能断言 calls[0] 是 delete
  ok('remove reads a backup before deleting', calls[0]?.[0] === 'query', JSON.stringify(calls[0]))
  ok(
    'remove eventually issues delete with /f',
    calls.some((c) => c.includes('delete') && c.includes('/f')),
    JSON.stringify(calls),
  )
  ok('remove reports backup unavailability honestly when it cannot read', removed.backupUnavailable === true, JSON.stringify(removed))

  // 可读时，remove 必须回传原值与类型，供 UI 撤销
  calls.length = 0
  const readable = new OsEnvironmentLayer({
    platform: 'win32',
    run: async (args) => {
      calls.push(args)
      if (args[0] === 'query') {
        return Buffer.from(
          '\r\nHKEY_CURRENT_USER\\Environment\r\n    MY_VAR    REG_EXPAND_SZ    %USERPROFILE%\\x\r\n\r\n',
          'utf8',
        )
      }
      return Buffer.from('')
    },
  })
  const withBackup = await readable.remove(USER_SCOPE, 'MY_VAR')
  ok('remove returns the removed value', withBackup.removed?.value === '%USERPROFILE%\\x', JSON.stringify(withBackup.removed))
  ok('remove returns the original type', withBackup.removed?.type === 'REG_EXPAND_SZ', String(withBackup.removed?.type))
  ok('remove returns the original spelling', withBackup.removed?.name === 'MY_VAR', String(withBackup.removed?.name))
  // 撤销的关键：类型必须能原样写回，否则 %VAR% 会被破坏
  const restore = await readable.write(USER_SCOPE, withBackup.removed.name, withBackup.removed.value, withBackup.removed.type)
  ok('a recorded removal can be replayed with its original type', restore.ok === true && restore.type === 'REG_EXPAND_SZ', JSON.stringify(restore))

  // 大小写：Windows 上按名字找备份必须不区分大小写
  const caseLayer = new OsEnvironmentLayer({
    platform: 'win32',
    run: async (args) => {
      if (args[0] === 'query') {
        return Buffer.from('HKEY_CURRENT_USER\\Environment\r\n    MyVar    REG_SZ    v\r\n', 'utf8')
      }
      return Buffer.from('')
    },
  })
  const caseRemoved = await caseLayer.remove(USER_SCOPE, 'MYVAR')
  ok('backup lookup is case-insensitive on Windows', caseRemoved.removed?.value === 'v', JSON.stringify(caseRemoved.removed))

  // 失败路径必须被转述而不是吞掉
  const failing = new OsEnvironmentLayer({
    platform: 'win32',
    run: async () => {
      throw new Error('ERROR: Access is denied.')
    },
  })
  const denied = await failing.write(MACHINE_SCOPE, 'X', 'v')
  ok('write failure is reported, not swallowed', denied.ok === false, JSON.stringify(denied))
  ok('write failure preserves the OS message', String(denied.error).includes('Access is denied'), String(denied.error))
  const readDenied = await failing.read(USER_SCOPE)
  ok('read failure is reported with an empty list', readDenied.entries.length === 0 && readDenied.error !== undefined, JSON.stringify(readDenied))
}

// ── 4. 非 Windows 平台必须诚实报告不支持 ────────────────────────────────────
console.log('\n--- unsupported platforms ---')
{
  for (const platform of ['linux', 'darwin']) {
    const other = new OsEnvironmentLayer({ run: async () => Buffer.from(''), platform })
    ok(`${platform}: supported is false`, other.supported === false)
    const read = await other.read(USER_SCOPE)
    ok(`${platform}: read reports unsupported`, read.error === 'unsupported-platform', String(read.error))
    const write = await other.write(USER_SCOPE, 'X', 'v')
    ok(`${platform}: write refuses instead of pretending`, write.ok === false && write.error === 'unsupported-platform', JSON.stringify(write))
  }
  const noRunner = new OsEnvironmentLayer({ platform: 'win32' })
  ok('win32 without a runner is unsupported', noRunner.supported === false)
}

// ── 5. PATH 合并语义 ────────────────────────────────────────────────────────
console.log('\n--- PATH merge semantics ---')
{
  ok('both present: machine first', OsEnvironmentLayer.mergePath('U', 'M').combined === 'M;U')
  ok('only user', OsEnvironmentLayer.mergePath('U', '').combined === 'U')
  ok('only machine', OsEnvironmentLayer.mergePath('', 'M').combined === 'M')
  ok('neither', OsEnvironmentLayer.mergePath('', '').combined === '')
  ok('undefined user is handled', OsEnvironmentLayer.mergePath(undefined, 'M').combined === 'M')
}

// ── 6. 键路径规范化（缩写根 vs 全名）────────────────────────────────────────
// 这是本轮最难定位的 bug 的回归测试：`reg query` 接受缩写根，但输出用全名。
// 不统一两者，scope 判断永远不匹配，症状是"解析出 0 个值"。
console.log('\n--- normalizeKeyPath ---')
{
  ok('HKCU expands to the full name', normalizeKeyPath('HKCU\\Environment') === 'HKEY_CURRENT_USER\\ENVIRONMENT', normalizeKeyPath('HKCU\\Environment'))
  ok('HKLM expands to the full name', normalizeKeyPath('HKLM\\x') === 'HKEY_LOCAL_MACHINE\\X', normalizeKeyPath('HKLM\\x'))
  ok('an already-full name is unchanged in substance', normalizeKeyPath('HKEY_CURRENT_USER\\Environment') === 'HKEY_CURRENT_USER\\ENVIRONMENT')
  ok(
    'abbreviation and full name normalize to the same key',
    normalizeKeyPath('HKCU\\Environment') === normalizeKeyPath('HKEY_CURRENT_USER\\Environment'),
  )
  ok('expansion is case-insensitive on the root', normalizeKeyPath('hkcu\\Environment') === normalizeKeyPath('HKCU\\Environment'))
  ok('surrounding whitespace is trimmed', normalizeKeyPath('  HKCU\\Environment  ') === 'HKEY_CURRENT_USER\\ENVIRONMENT')
  ok('a subkey stays distinct from its parent', normalizeKeyPath('HKCU\\Environment\\Sub') !== normalizeKeyPath('HKCU\\Environment'))
}

// ── 7. mergeOsLayers：并入复合模型 ──────────────────────────────────────────
console.log('\n--- mergeOsLayers ---')
{
  const baseModel = {
    cwd: 'C:\\p',
    home: 'C:\\h',
    projectFile: undefined,
    userFile: undefined,
    warnings: [],
    variables: [
      {
        name: 'SHARED',
        layers: [{ layer: 'process', value: 'from-process', writable: false, blockedCode: 'process-inherited' }],
        effective: 'process',
        shadowed: false,
        forbidden: false,
        sensitive: false,
        runtimeManaged: false,
      },
    ],
  }

  const merged = mergeOsLayers(baseModel, {
    [USER_SCOPE]: { scope: USER_SCOPE, entries: [{ name: 'SHARED', type: 'REG_SZ', value: 'from-user' }] },
    [MACHINE_SCOPE]: { scope: MACHINE_SCOPE, entries: [{ name: 'ONLY_MACHINE', type: 'REG_EXPAND_SZ', value: '%X%' }] },
  })

  const shared = merged.find((v) => v.name === 'SHARED')
  const onlyMachine = merged.find((v) => v.name === 'ONLY_MACHINE')

  ok('existing variable gains the OS layer', shared?.layers.length === 2, String(shared?.layers.length))
  ok('effective layer stays the higher-trust process layer', shared?.effective === 'process', String(shared?.effective))
  ok('the variable becomes shadowed', shared?.shadowed === true)
  ok('layerCount is recomputed', shared?.layerCount === 2, String(shared?.layerCount))
  ok('layer order follows trust order', shared?.layers.map((l) => l.layer).join(',') === 'process,os-user', shared?.layers.map((l) => l.layer).join(','))
  ok('registry type rides along on the OS layer', shared?.layers[1]?.registryType === 'REG_SZ', String(shared?.layers[1]?.registryType))
  ok('OS layers are writable', shared?.layers[1]?.writable === true)

  ok('a registry-only variable is added', onlyMachine !== undefined)
  ok('its effective layer is the machine scope', onlyMachine?.effective === 'os-machine', String(onlyMachine?.effective))
  ok('it is not marked shadowed', onlyMachine?.shadowed === false)
  ok('machine scope is flagged as needing elevation', onlyMachine?.layers[0]?.requiresElevation === true)
  ok('user scope is not flagged for elevation', shared?.layers[1]?.requiresElevation === undefined)
  ok('its REG_EXPAND_SZ type is preserved', onlyMachine?.layers[0]?.registryType === 'REG_EXPAND_SZ')

  // 敏感名与运行时名必须在新增条目上也被识别
  const flagged = mergeOsLayers(
    { ...baseModel, variables: [] },
    {
      [USER_SCOPE]: {
        scope: USER_SCOPE,
        entries: [
          { name: 'SOME_TOKEN', type: 'REG_SZ', value: 'x' },
          { name: 'DSH_SOMETHING', type: 'REG_SZ', value: 'y' },
        ],
      },
      [MACHINE_SCOPE]: { scope: MACHINE_SCOPE, entries: [] },
    },
  )
  ok('a registry-only sensitive name is flagged sensitive', flagged.find((v) => v.name === 'SOME_TOKEN')?.sensitive === true)
  ok('a registry-only DSH_ name is flagged runtimeManaged', flagged.find((v) => v.name === 'DSH_SOMETHING')?.runtimeManaged === true)

  // 不得修改入参（纯函数契约）
  ok('the base model is not mutated', baseModel.variables[0].layers.length === 1, String(baseModel.variables[0].layers.length))

  // 空输入必须安全
  const empty = mergeOsLayers({ ...baseModel, variables: [] }, { [USER_SCOPE]: { entries: [] }, [MACHINE_SCOPE]: { entries: [] } })
  ok('empty OS layers yield no variables', empty.length === 0, String(empty.length))

  const missing = mergeOsLayers({ ...baseModel, variables: [] }, {})
  ok('missing scope blocks are tolerated', missing.length === 0, String(missing.length))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
