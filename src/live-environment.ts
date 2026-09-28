import { buildEnvironmentModel, isBootstrapOnly, SENSITIVE_ENV_PATTERN } from './env-model'
import { OsEnvironmentLayer } from './registry'
import type { OsReadLayerPort } from './host-api'

interface LaunchSnapshot {
  getFrom(name: string, sources: readonly string[]): { value: string; source: string } | undefined
}

export interface RuntimeResult {
  appliedToProcess: boolean
  restartRequired: boolean
}

export interface RuntimeChange {
  layer: string
  names: string[]
  cwd: string
  home: string
  removed?: { name: string; value: string }
}

/** 持久化成功后更新子进程下一次启动所读取的环境。 */
export class LiveEnvironment {
  private readonly original: NodeJS.ProcessEnv
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: {
    env?: NodeJS.ProcessEnv
    launch?: LaunchSnapshot
    osLayer: OsReadLayerPort
  }) {
    this.original = { ...(options.env ?? process.env) }
  }

  sync(change: RuntimeChange): Promise<RuntimeResult> {
    const run = this.pending.then(() => this.apply(change))
    this.pending = run.catch(() => {})
    return run
  }

  private async apply(change: RuntimeChange): Promise<RuntimeResult> {
    try {
      const env = this.options.env ?? process.env
      const model = buildEnvironmentModel({ cwd: change.cwd, home: change.home, env: {} })
      const fold = (name: string) => process.platform === 'win32' ? name.toUpperCase() : name
      const next = new Map<string, string | undefined>()
      let os: Awaited<ReturnType<OsReadLayerPort['readAll']>> | undefined
      // 只在需要注册表层或删除后的回落时读取 OS，普通 .env 保存无需启动 reg.exe。
      const needsOs = change.layer.startsWith('os-') || change.names.some((name) =>
        !model.variables.some((v) => fold(v.name) === fold(name)))
      if (needsOs && this.options.osLayer.supported) {
        os = await this.options.osLayer.readAll()
        if (Object.values(os).some((scope) => scope.error)) {
          return { appliedToProcess: false, restartRequired: true }
        }
      }
      for (const name of change.names) {
        const key = fold(name)
        const variable = model.variables.find((v) => fold(v.name) === key)
        let value = variable?.layers[0]?.value
        if (value === undefined && os !== undefined) {
          const osValue = (scope: 'os-user' | 'os-machine') => {
            const entry = os[scope].entries.find((entry) => fold(entry.name) === key)
            if (entry === undefined) return undefined
            let expanded = entry.value
            if (entry.type === 'REG_EXPAND_SZ') {
              expanded = expanded.replace(/%([^%]+)%/g, (match, reference: string) => {
                const referenced = Object.keys(env).find((candidate) => fold(candidate) === fold(reference))
                return referenced === undefined ? match : env[referenced] ?? match
              })
            }
            return expanded
          }
          const userValue = osValue('os-user')
          const machineValue = osValue('os-machine')
          value = process.platform === 'win32' && key === 'PATH'
            ? userValue === undefined && machineValue === undefined ? undefined : OsEnvironmentLayer.mergePath(userValue, machineValue).combined
            : userValue ?? machineValue
        }
        if (value === undefined) {
          const inherited = this.options.launch?.getFrom(name, ['process'])
          const originalName = Object.keys(this.original).find((candidate) => fold(candidate) === key)
          const original = inherited?.value ?? (this.options.launch === undefined && originalName !== undefined
            ? this.original[originalName] : undefined)
          // 注册表的启动副本不能让已删除的值复活。
          value = change.removed !== undefined && fold(change.removed.name) === key && original === change.removed.value
            ? undefined : original
        }
        const envName = Object.keys(env).find((candidate) => fold(candidate) === key) ?? name
        // Node/Windows 会静默截断 NUL，不能把有损值宣称为已同步。
        if (envName.includes('\0') || envName.includes('=') || value?.includes('\0')) {
          return { appliedToProcess: false, restartRequired: true }
        }
        next.set(envName, value)
      }
      for (const [name, value] of next) {
        if (value === undefined) delete env[name]
        else env[name] = value
      }
      // launchEnvironment 是宿主拥有的不可变快照；凭据回退和启动配置无法由插件刷新。
      return {
        appliedToProcess: true,
        restartRequired: change.names.some((name) => SENSITIVE_ENV_PATTERN.test(name) || isBootstrapOnly(name)),
      }
    } catch {
      // 文件已经保存；同步失败不能被描述为写入失败，也不能输出可能含值的错误。
      return { appliedToProcess: false, restartRequired: true }
    }
  }
}
