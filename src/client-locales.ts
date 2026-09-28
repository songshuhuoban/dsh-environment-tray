/** Dictionaries owned by this plugin; language selection belongs to DSH. */
export const LOCALE_NS = 'dsh-environment-tray'

const en = {
  title: 'Environment variables',
  close: 'Close',
  search: 'Search variables',
  refresh: 'Refresh',
  retry: 'Retry',
  newVariable: 'New variable',
  variableName: 'Name',
  variableValue: 'Value',
  saveTo: 'Save to',
  create: 'Create',
  cancel: 'Cancel',
  deleteVariable: 'Delete variable',
  deleteFrom: 'Delete from {layer}',
  deletePrompt: 'Delete {name} from {layer}?',
  deleteFallback: 'Values in other layers will remain.',
  confirmDelete: 'Confirm deletion',
  loading: 'Loading…',
  loadingEnvironment: 'Loading environment…',
  saving: 'Saving…',
  readError: 'Could not read: {error}',
  restart: 'Restart DSH to apply',
  deleted: 'Deleted {name}',
  undoDelete: 'Undo deletion',
  noMatches: 'No matching variables',
  valueLabel: 'Value of {name}',
  editHint: 'Enter to save · Esc to cancel',
  multilineHint: 'Reveal to edit multiple lines',
  hideInput: 'Hide input',
  showInput: 'Show input',
  hideValue: 'Hide value',
  showValue: 'Show value',
  copyValue: 'Copy value',
  copied: 'Copied',
  cancelEdit: 'Cancel editing',
  edit: 'Edit',
  delete: 'Delete',
  replace: 'Replace',
  set: 'Set',
  collapseLayers: 'Collapse layers',
  expandLayers: 'Expand layers',
  current: 'Current',
  layerCount: '{count} layers',
  unset: 'Not set',
  'layer.process': 'Current process',
  'layer.project': 'Project .env',
  'layer.user': 'User .env',
  'layer.credential': 'Credentials',
  'layer.osUser': 'Windows user variables',
  'layer.osMachine': 'Windows system variables',
  'layer.file': 'Credential store',
  'group.runtime': 'DSH runtime variables',
  'group.credential': 'Credential environment',
  'group.readonly': 'Current process · Read only',
  scopeReadError: 'Could not read {scope}',
  'warning.bom': '{path}: Remove the UTF-8 BOM so DSH can read the first variable correctly.',
  'blocked.process': 'Current process layer is read only',
  'blocked.proxy': 'Set the proxy in User .env',
  'blocked.bootstrap': 'Set before starting DSH',
  'blocked.unknown': 'Unsupported environment layer',
  'blocked.elevation': 'Administrator access required',
  'error.read': 'Could not read the value',
  'error.copy': 'Could not copy the value',
  'error.edit': 'Cannot edit this value',
  'error.reopen': 'Reopen the editor to read the latest value',
  'error.stale': 'The file changed. Reopen the editor before saving.',
  'error.emptyName': 'Variable name cannot be empty',
  'error.invalidName': 'Use letters, digits and underscores; start with a letter or underscore',
  'error.nameSpace': 'Variable name cannot contain whitespace',
  'error.lossy': 'This value cannot be stored in .env without changing it',
  'error.validation': 'Invalid changes',
  'error.noEdits': 'No changes to save',
  'error.credentials': 'Credential service unavailable',
  'error.invalidRef': 'Invalid credential name',
  'error.emptyValue': 'Credential cannot be empty; use Delete to remove it',
  'error.shadowed': 'A higher priority source overrides this credential',
  'error.invalidLayer': 'Invalid environment layer',
  'error.invalidRequest': 'Invalid request',
  'error.platform': 'Editing system variables is not supported on this platform',
  'error.missing': 'This value no longer exists; refresh the list',
  'error.policy': 'Reconnect to DSH to verify this request',
  'error.origin': 'Request origin is not trusted',
  'error.auth': 'Reconnect to DSH to authenticate',
  'error.exists': 'This name already exists in the selected location',
  'error.registryRead': 'Could not read the selected location; nothing was created',
}

const zh: Record<keyof typeof en, string> = {
  title: '环境变量', close: '关闭', search: '搜索变量', refresh: '刷新', retry: '重试',
  newVariable: '新建变量', variableName: '名称', variableValue: '值', saveTo: '保存位置', create: '新建', cancel: '取消',
  deleteVariable: '删除变量', deleteFrom: '从{layer}删除', deletePrompt: '从{layer}删除 {name}？',
  deleteFallback: '其他层中的同名值会保留。', confirmDelete: '确认删除',
  loading: '读取中…', loadingEnvironment: '正在读取环境…', saving: '保存中…',
  readError: '读取失败：{error}', restart: '需重启 DSH', deleted: '已删除 {name}', undoDelete: '撤销删除',
  noMatches: '没有匹配的变量', valueLabel: '{name} 的值', editHint: 'Enter 保存 · Esc 取消',
  multilineHint: '显示后编辑多行值', hideInput: '隐藏输入', showInput: '显示输入',
  hideValue: '隐藏值', showValue: '显示值', copyValue: '复制值', copied: '已复制',
  cancelEdit: '取消编辑', edit: '编辑', delete: '删除', replace: '替换', set: '设置',
  collapseLayers: '收起各层', expandLayers: '展开各层', current: '当前', layerCount: '{count} 层', unset: '未设置',
  'layer.process': '当前进程', 'layer.project': '项目 .env', 'layer.user': '用户 .env',
  'layer.credential': '凭据', 'layer.osUser': 'Windows 用户环境变量', 'layer.osMachine': 'Windows 系统环境变量',
  'layer.file': '凭据库', 'group.runtime': 'DSH 运行变量', 'group.credential': '凭据环境',
  'group.readonly': '当前进程 · 只读', scopeReadError: '{scope}读取失败',
  'warning.bom': '{path}：请去掉 UTF-8 BOM，以便 DSH 正确读取第一个变量。',
  'blocked.process': '当前进程层只读', 'blocked.proxy': '请在用户 .env 设置代理',
  'blocked.bootstrap': '请在启动 DSH 前设置', 'blocked.unknown': '不支持此环境层',
  'blocked.elevation': '需要管理员权限',
  'error.read': '读取失败', 'error.copy': '复制失败', 'error.edit': '无法编辑',
  'error.reopen': '请重新打开编辑', 'error.stale': '文件已被其他程序修改，请重新打开编辑后再保存。',
  'error.emptyName': '变量名不能为空', 'error.invalidName': '变量名只能由字母、数字、下划线组成，且不能以数字开头',
  'error.nameSpace': '变量名不能包含空白字符', 'error.lossy': '此值无法原样保存在 .env 中',
  'error.validation': '编辑内容无效', 'error.noEdits': '没有需要保存的改动',
  'error.credentials': '凭据服务不可用', 'error.invalidRef': '凭据名称无效',
  'error.emptyValue': '密钥不能为空，请使用删除操作移除', 'error.shadowed': '此凭据被更高优先级的来源覆盖',
  'error.invalidLayer': '环境层无效', 'error.invalidRequest': '请求无效',
  'error.platform': '当前平台不支持编辑系统环境变量', 'error.missing': '值已不存在，请刷新列表',
  'error.policy': '请重新连接 DSH 以验证请求', 'error.origin': '请求来源不受信任',
  'error.auth': '请重新连接 DSH 完成认证',
  'error.exists': '所选位置中已存在同名变量',
  'error.registryRead': '无法读取所选位置，未执行新建',
}

export const dictionaries = { zh, en }
export type LocaleKey = keyof typeof en
export type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string
export interface LocaleProps { t: Translate }

const layerKeys: Record<string, LocaleKey> = {
  process: 'layer.process', 'project-env': 'layer.project', 'user-env': 'layer.user',
  credential: 'layer.credential', 'os-user': 'layer.osUser', 'os-machine': 'layer.osMachine',
  env: 'layer.process', file: 'layer.file',
}
export const layerLabel = (t: Translate, layer: string) => layerKeys[layer] ? t(layerKeys[layer]) : layer

const codeKeys: Record<string, LocaleKey> = {
  'read-failed': 'error.read', 'copy-failed': 'error.copy', 'not-editable': 'error.edit',
  'reopen-editor': 'error.reopen', 'stale-revision': 'error.stale', 'empty-name': 'error.emptyName',
  'invalid-name': 'error.invalidName', 'name-has-space': 'error.nameSpace', 'lossy-value': 'error.lossy',
  'validation-failed': 'error.validation', 'no-edits': 'error.noEdits', 'invalid-ref': 'error.invalidRef',
  'credentials-unavailable': 'error.credentials', 'empty-value': 'error.emptyValue',
  'credential-shadowed': 'error.shadowed', 'invalid-layer': 'error.invalidLayer',
  'unsupported-platform': 'error.platform', 'value-missing': 'error.missing',
  'request-policy-unavailable': 'error.policy', 'untrusted-origin': 'error.origin', 'unauthenticated': 'error.auth',
  'invalid-edits': 'error.invalidRequest', 'invalid-revision': 'error.invalidRequest',
  'invalid-value': 'error.invalidRequest', 'invalid-type': 'error.invalidRequest', 'invalid-scope': 'error.invalidRequest',
  'process-inherited': 'blocked.process', 'process-layer': 'blocked.process',
  'proxy-not-in-home': 'blocked.proxy', 'bootstrap-only': 'blocked.bootstrap',
  'unknown-layer': 'blocked.unknown', 'needs-elevation': 'blocked.elevation',
  'already-exists': 'error.exists',
  'registry-read-failed': 'error.registryRead',
}
export const reasonLabel = (t: Translate, code: string, fallback?: string) => codeKeys[code] ? t(codeKeys[code]) : fallback ?? code

export interface ErrorResponse {
  error?: string
  message?: string
  problems?: { name?: string; code?: string; message?: string }[]
}
/** Keep codes in state so mounted errors also follow a locale change. */
export class ClientError extends Error {
  constructor(readonly response: ErrorResponse, readonly status?: number) {
    super(response.message ?? response.error ?? `HTTP ${status}`)
  }
}
export function errorLabel(t: Translate, error: unknown): string {
  if (error instanceof ClientError) {
    const { response } = error
    if (response.problems?.length) return response.problems.map((problem) => {
      const text = problem.code ? reasonLabel(t, problem.code, problem.message) : problem.message
      return (problem.name ? `${problem.name}: ` : '') + (text ?? t('error.validation'))
    }).join('; ')
    return response.error ? reasonLabel(t, response.error, response.message) : response.message ?? `HTTP ${error.status}`
  }
  return error instanceof Error ? error.message : String(error)
}
