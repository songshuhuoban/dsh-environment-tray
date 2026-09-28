# DSH Environment Tray（环境变量管理器）

npm 包名：`dsh-environment-tray`。在 DSH Web UI 里管理环境变量：**① `.env` 文件 ② 运行时 `DSH_*` 注入变量 ③ 密钥 ④ Windows 用户级与系统级环境变量**。

完整设计（含所有实测证据与取舍理由）见 [`docs/dsh-environment-tray-design.md`](docs/dsh-environment-tray-design.md)。
这份 README 包含安装、使用和验证步骤。

---

## 安装到 DSH Web

先安装并运行一次 DSH 的 `web` profile。需要可用的 `dsh` 命令和包管理器 `pnpm`。当前开发环境使用 DSH 0.1.7-rc.2；其他版本请先核对服务与客户端兼容性。

从 npm 安装已发布的 `0.1.0`：

```powershell
dsh plugin --profile web add dsh-environment-tray@0.1.0
```

也可以从本仓库构建后本地安装，适合开发调试：

```powershell
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add (Resolve-Path .).Path
```

安装只把 bundle 加入 profile。编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`；未设置 `DSH_HOME` 时，文件在 `~/.dsh/profiles/web/cordis.patch.yml`。在 YAML 顶层数组中加入以下条目，启用插件：

```yaml
- id: dsh-environment-tray
  disabled: false
```

然后检查组合配置并重启正在运行的 DSH Web：

```powershell
dsh --profile web --dump-config
dsh web
```

在输出中确认该条目的 `id` 和 `name` 都是 `dsh-environment-tray`，且 `disabled` 为 `false`。打开一个**已有会话**，点击右上角的「环境变量」双滑杆图标。空白新会话页不显示会话标题栏，因此没有该入口。首次加入 bundle 后需要重启，单改 profile patch 不能让已运行的前端扫描新增包。

### 升级与卸载

```powershell
# 把版本号替换为实际发布的新版本，随后重启 DSH Web
$newVersion = '0.1.1'
dsh plugin --profile web add "dsh-environment-tray@$newVersion"

# 卸载包；再从 profile 的 cordis.patch.yml 删除 dsh-environment-tray 启用条目
dsh plugin --profile web remove dsh-environment-tray
```

如果安装过本仓库的早期开发版，升级前先从 web profile 移除旧 bundle，再按上面的步骤安装新包，避免 profile 中出现重复条目。

### 打包文件与来源

发布包内有 `lib/*.js`、`cordis.patch.yml`、文档和 MIT 许可证；安装 npm 包无需在用户机器上构建 TypeScript。发布步骤见 [`docs/releasing.md`](docs/releasing.md)。

---

## 使用

DSH 0.1.5 使用设置图标作为兼容替代，0.1.7 使用原生双滑杆图标；已有客户端 HMR 时，重新构建可直接更新按钮。

点行尾编辑图标后，VALUE 原位替换为输入框，显示被编辑层的完整原值。离开这一行或按 Enter 保存，Esc 或取消图标放弃；没改动不写入。密钥输入默认遮掩，多行值保留换行；保存失败保留草稿并在输入框旁显示错误。显示、复制、来源和行尾操作均预留相同列宽。

顶部加号打开「新建变量」表单，默认保存到用户 `.env`，也可选择项目 `.env` 或可读取的 Windows 用户／系统环境变量。填写名称和值后点「新建」提交；取消或 Esc 放弃。目标位置已有同名变量时拒绝覆盖，失败保留草稿。

可写变量的行尾直接提供删除图标，确认框显示变量名和目标层；其他层中的同名值会保留。删除无需读取明文值，`.env` 删除带文件版本校验；Windows 删除仍支持撤销。打开删除确认暂停编辑自动保存，取消后保留编辑草稿。

界面跟随 DSH 的语言设置，提供中文和英文。插件直接使用原生 `locale` 服务，按钮、分组、状态、警告及结构化错误均支持切换；已打开的面板即时更新，保留筛选条件和编辑草稿。其他语言按 DSH 的语言包回退规则显示。变量名、实际值和文件路径保持原样。

---

## 代码结构

源码在 `src/`（TypeScript），`lib/` 是 `tsdown` 的构建产物 —— **改 `lib/` 是改不动的，下次构建会覆盖**。

| 源文件 → 产物 | 职责 | 关键约束 |
|---|---|---|
| `src/index.ts` → `lib/index.js` | 宿主插件入口 | `inject: ['shellEnv','credentials','connection']`；**apply 绝不抛错**（挂进用户运行中的进程）|
| `src/env-model.ts` → `lib/env-model.js` | 复合环境模型（UI 的唯一数据源）| `.env` 解析对齐 `node:util.parseEnv`；禁止名单与 DSH 源码逐条一致 |
| `src/env-write.ts` → `lib/env-write.js` | `.env` 写入 | 逐字节保留未触及的行；CAS + 按路径临界区；原子写 + 0600 |
| `src/credentials.ts` → `lib/credentials.js` | 密钥域适配 | **只调 `describe`，从不调 `resolve`**；遮蔽翻译成可行动文案 |
| `src/registry.ts` → `lib/registry.js` | Windows 注册表 OS 层 | 保留 `REG_EXPAND_SZ`；删除前备份原值以支持撤销；非 Windows 诚实拒绝 |
| `src/host-api.ts` → `lib/host-api.js` | 读路由 + 客户端数据投影 | 列表默认遮掩敏感值；完整值按名称和层单独读取 |
| `src/live-environment.ts` → `lib/live-environment.js` | 保存后的运行环境同步 | 更新当前进程；删除回落；保留宿主启动快照 |
| `src/write-routes.ts` → `lib/write-routes.js` | 写路由 + 请求策略闸门 | **路径由层标识推导，不接受任意路径**；复用 `connection.requestRejection` |
| `src/client.ts` → `lib/client.js` | 客户端入口与数据流 | 注册进**会话头部工具区** `conversation.session.header.utilities`，点开是模态框；普通 ESM 源码，`build/client-wrapper.mjs` 在构建后把它包成惰性 CJS 工厂（`window.__ModuleLoader__.load`）。**产物里只允许种子表内的说明符**：`react` 与 `@deepseek-ai/dsh-client-ui-primitives` |
| `src/client-ui.ts` | 客户端表现层 | 只有排版与样式，不认识 `fetch`；KEY/VALUE 是内容、其余是注解。被 `client.ts` 内联进同一个 bundle |
| `src/inline-edit.ts` | 原位编辑状态 | 完整原值、失焦与键盘提交、取消、并发提交去重；被内联进客户端 bundle |
| `src/client-actions.ts` | 新建表单与删除确认 | 多字段显式提交、重复提交去重、失败保留草稿、按层删除；被内联进客户端 bundle |
| `src/client-locales.ts` | 中英文词典与错误翻译 | `dsh-environment-tray` 命名空间；`locale` 由 DSH 提供，词典随插件卸载释放；错误按机器码翻译 |

---

## 验证

### 测试套件（11 个可运行文件，1139 项断言）

其中 11 项是对本机已安装 DSH 参照包的差分检查；干净的 CI runner 会明确跳过这 11 项，其余 1128 项仍须全部通过。

```powershell
pnpm run build                    # 套件测的是 lib/*.js，所以先构建
node check-p0.mjs                 # 插件形态 + 客户端 bundle 契约（39）
node verify-env-model.mjs         # 复合模型、差分测试、禁止名单保真（192）
node verify-env-write.mjs         # 结构保留、CAS、并发、BOM、新建不覆盖（122）
node verify-credentials.mjs       # 密钥零泄露与遮蔽分类（52）
node verify-host-api.mjs          # 读路由、投影、敏感值开关、reg.exe 执行器（131）
node verify-registry.mjs          # 注册表解析、类型保留、并入模型（82）
node verify-registry-roundtrip.mjs # 真写 HKCU 再清理的往返（24）
node verify-write-routes.mjs      # 写路由、路径白名单、请求闸门、并发新建冲突（101）
node audit-hostile-input.mjs      # 敌意输入审计：畸形请求不崩、不泄露（192）
node verify-client-ui.mjs         # 客户端 UI：逐项显示与复制、原位自动保存、新建与删除、排版、i18n（170）
node verify-live-environment.mjs  # 保存后的真实子进程读取、删除回落、Windows PATH、逐项读值鉴权（34）

node verify-build-parity.mjs      # 迁移期门禁：旧 lib/*.mjs 与新构建的逐模块等价（已退役）
node audit-coverage.mjs           # 导出符号覆盖审计（应为 53/53）
node audit-readme.mjs             # 校验本 README 的断言数与实测一致
```

`verify-client-ui.mjs` 值得单独说明：它把构建出的 `lib/client.js` **真的跑起来** ——
受控的 `window.__ModuleLoader__`、假 `react`、假 `@deepseek-ai/dsh-client-ui-primitives`、
假 `fetch`，加一个只实现 4 个 hook 的迷你渲染器。然后点开入口、驱动交互，断言两类东西：

- **行为**：入口注册进 `conversation.session.header.utilities`（**不是** Settings 页签）、
  写请求的 URL 与请求体逐字节正确（`.env` 带 CAS 的 set/unset、注册表删除 + 撤销、
  凭据 set），以及被拒 / 500 / 永不 resolve 三条分支。
- **排版**：KEY/VALUE 是内容、其余是注解 —— 用**可度量**的方式断言：KEY/VALUE 字号
  大于注解、注解 `opacity ≤ 0.5`、注解没有边框（不是胶囊）、KEY 在 VALUE 之前、
  密文不外泄且以点阵表示、长说明默认收起。
- **宽度与响应式**：模态框带自己的宽度类，样式表里有窄屏断点，且这些规则**确实在
  构建产物里**（读 `lib/client.js` 断言，而不是读源码）。
- **排序**：分组标题的出现顺序就是"用户级在前、系统继承在后"，只读组必须最后，
  凭据面板不能被埋在系统组下面。
- **逐项显示与复制**：默认遮掩敏感值；点击眼睛只读取该名称、该层的完整值。
  隐藏或刷新后清除临时显示。复制读取完整值，不使用截断摘要；凭据支持相同操作。
- **语言切换**：中英文键与占位参数一致；已打开的面板及错误更新语言，筛选与草稿保留，切换不触发额外读写；卸载释放词典命名空间。
- **新建与删除**：保存位置、空值、多行值、敏感值、重名拒绝、失败保留和重复提交；删除按层确认，不读取明文，确认期间不会误触发编辑保存。

可用已安装 DSH 的真实语言运行时重跑同一套 UI 检查；运行时在测试中隔离实例化，不写入用户语言偏好：

```powershell
$env:DSH_LOCALE_CLIENT = '<DSH 安装目录>\node_modules\@deepseek-ai\dsh-client-locale\lib\client.js'
node verify-client-ui.mjs
Remove-Item Env:DSH_LOCALE_CLIENT
```

脚本按**按钮标签或 `aria-label`** 驱动（图标按钮没有文本），所以它顺带钉住了
无障碍名字。

### 重启前预检

**首次加载本插件必须重启 DSH，而重启只能试一次** —— 所以把所有失败模式提前暴露：

```powershell
node preflight.mjs
```

它按 DSH 启动的真实顺序检查 7 项：profile 声明 → 包解析（含 junction 真身是否指向本工作区）
→ 宿主半边逐模块真 import → cordis 插件契约（含 `apply` 在无服务时不抛）
→ 客户端 bundle 编译与工厂物化 → `dsh --dump-config` 组合出我们的行且未被 disabled
→ 权限与残留（真实 `~/.dsh` 未被污染）。

**重启前请先跑它。** 若它通过而重启后仍异常，那问题就在浏览器侧或运行时交互，
而不在配置与加载路径上。

### 重启后一条命令

**注意：3080 的 server 与 agent 会话运行时是同一个进程** —— 重启会终止当时
所在的会话（会话历史持久化，可在新实例里恢复）。恢复会话后跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\post-restart-probe.ps1
```

它会：确认旧进程已退出、新进程确实新鲜、静态预检通过、9 个套件全过，
再**起一个隔离实例**（独立 `DSH_HOME`，不碰真实数据）验证运行时行为——

- 插件日志里出现 `contributor registered` 与 `credentials service available`
- 未认证请求回 **401**、跨站回 **403**、外部 Host 回 **403**（请求闸门生效）
- 已认证请求回 **200**，模型带齐四层（实测 109 个变量 / 27 项遮蔽 / 19+18 个 OS 层变量）
- 客户端 bundle 出现在 index 的应用组合 URL 里

最后检查无残留。它**只依赖 HTTP**，所以能在重启后的新会话里直接跑。

剩下唯一需要人眼的事：确认**会话头部右上角**出现环境变量图标，点开是模态框。

另外 `verify-registry-roundtrip.mjs`（24 项）**会真的改系统** —— 它往
`HKCU\Environment` 写一个自建变量名做 写→删→撤销 往返（`finally` 无条件清理）。
它现在也在上面的列表里，但如果你不想让测试碰真实注册表，就单独跑：

```powershell
node verify-registry-roundtrip.mjs
```

### 需要运行中实例的端到端脚本

`e2e-shadowing.ps1` 证明**遮蔽关系与生效层回落**在真实链路上成立
（HTTP → 路由 → 注册表 → 复合模型 → 投影 → 响应）。需要一个跑着的 DSH 与它的 token：

```powershell
# 先起一个隔离实例（独立 DSH_HOME，不碰真实数据）
$env:DSH_HOME = "$PWD\.probe-home"
dsh --profile web --port 3180 --no-open   # 从输出里拿 ?token=...

# 另开一个终端
powershell -NoProfile -ExecutionPolicy Bypass -File .\e2e-shadowing.ps1 <token>
```

它会自建 `ENVIRONMENT_TRAY_LAYER_TEST` 变量（**不能用 `DSH_` 前缀** —— 那会被禁止名单
正确拒绝），在同名变量同时存在于 `.env` 与注册表时断言：

- `layerCount=2`、`shadowed=true`、**`effective=project-env`**（信任序）
- 每层保留自己的元数据（`.env` 带路径，注册表带 `REG_SZ` 类型）
- 逐层删除后生效层**正确回落**、最终变量消失

`finally` 里无条件删除注册表项与 `.env`。

两个套件会**真实触碰系统**，但都会自清理：

- `verify-registry-roundtrip.mjs` 往 `HKCU\Environment` 写一个自建变量名，`finally` 无条件删除
- `verify-env-write.mjs` 只在自己的临时目录里操作

### 探针（可复现的证据，不是断言）

每个探针回答一个具体问题。**它们的存在是因为"读文档猜"错过好几次**，所以关键行为都有可复现的实测记录。

| 探针 | 回答的问题 |
|---|---|
| `probe-parseenv.mjs` | `.env` 是否做变量展开？（答案：**不展开**，`$VAR` 是字面量）|
| `probe-parseenv-escapes.mjs` | 双引号里哪些转义生效？（答案：**只有 `\n`**）|
| `probe-quote-strategy.mjs` | 单引号能否承载双引号？（答案：**能**，推翻了最初的假设）|
| `probe-roundtrip-via-file.mjs` | 引号策略经 `loadEnvFile` 是否也成立？（DSH 真正走的通道）|
| `probe-line-split.mjs` | 行拆分正则的行为（发现空分支零宽匹配不可靠）|
| `probe-blank-count.mjs` | 空行到底几个（我在这个断言上连错三次）|
| `probe-bom.mjs` | BOM 是否粘进第一个变量名？（答案：**是**，且界面不可见）|
| `probe-reg-bytes.mjs` | `reg.exe` 输出的原始字节长什么样（控制台代码页）|
| `probe-reg-parse.mjs` | 为什么解析出 0 个值（缩写根 vs 全名不匹配）|
| `probe-write-race.mjs` | 并发写 `.env` 会丢数据吗？（答案：**会**，10 个"成功"只剩 1 个）|
| `probe-registry-race.mjs` | 注册表有同样问题吗？（答案：**没有**，按值原子操作）|

---

## 效果与生效时机

| 层 | 可写 | 生效时机 |
|---|---|---|
| 运行时 `DSH_*`（插件贡献）| ✅ | 🟢 **下一次 shell 调用**（无需重启）|
| 密钥（凭据库）| ✅ | 🟢 **下一次模型请求**（DSH 内部）|
| 项目 / 用户 `.env` | ✅ | 普通变量保存后同步至当前进程，下一次新启动的 shell 可读 |
| Windows 用户级 / 系统级环境变量 | ✅ | 保存后同步至当前进程，下一次新启动的 shell 可读 |

从 `.env` 或 Windows 环境层读取的凭据、代理及启动配置仍可能需要重启：
DSH 的 `launchEnvironment` 是宿主拥有的不可变启动快照，本插件不会替换它。
保存结果以 `appliedToProcess` 和 `restartRequired` 区分运行环境同步与剩余的重启要求。
已在运行的子进程不会收到环境更新。项目 `.env` 仍优先于用户 `.env` 和 Windows 环境层；
删除后立即按剩余层回落。Windows `REG_EXPAND_SZ` 在当前进程中展开 `%VAR%`，持久值与类型保持不变。
Windows `PATH` 按系统部分在前、用户部分在后合并；其它 Windows 环境变量以用户层优先。

**模型执行的 shell 读不到密钥**：子进程环境会清洗 `/KEY|PASSWORD|SECRET|TOKEN/i`
形状的名字；凭据库修改供 DSH 下一次模型请求使用。

---

## 已知边界

| 边界 | 处理 |
|---|---|
| Linux / macOS 的 OS 环境层 | **明确拒绝读写**并说明原因（macOS GUI 应用读 launchd 而非 shell profile；`launchctl setenv` 不持久；Linux 的 `environment.d` 只影响 systemd 用户会话）|
| `reg.exe` 输出的非 ASCII 值 | 按 UTF-8 宽松解码，ASCII 部分（变量名、类型名）正确，非 ASCII **值** 可能带替换字符 |
| `.env` 里 `#` 开头的行 | 是注释 —— 想设以 `#` 开头的值请用引号形式 |
| 值含 `KEY`/`TOKEN` 等字样 | 会被子进程清洗，模型 shell 读不到 |
| `.env` 无法表示的值 | 同时含 `"` 和 `'`、或含 `"` + 换行时**拒绝保存**并说明原因（不静默写坏）|

---

## 开发注意事项

- **客户端 bundle 由构建器包装为惰性 CJS 工厂**，运行时仅导入平台提供的 `react` 与 UI primitives；语言服务经 Cordis 注入，不直接导入其他 feature 的实现。
- **首次安装必须重启 DSH**：`patchReload: live` 只覆盖 `cordis.patch.yml`，不覆盖新增 bundle
- **任何读服务的插件都必须声明 `inject`**：cordis 对未声明的服务直接抛错，不是返回 `undefined`
- **两种依赖声明用途不同**：客户端导出的 `inject: ['slots', 'locale']` 声明服务；manifest 的 `dsh.client.inject` 声明语言包的加载依赖。词典通过 `ctx.effect` 注册，slot 的 `locale` 元数据让原生 renderer 注入 `t` 并响应语言切换。
- **路由鉴权是路由所有者的责任**：`dsh-host-webserver` 自身不带鉴权，必须自己过 `connection.requestRejection`
