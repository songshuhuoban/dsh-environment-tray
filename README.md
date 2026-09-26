# dsh-env-manager

在 DSH Web UI 里管理环境变量：**① `.env` 文件 ② 运行时 `DSH_*` 注入变量 ③ 密钥 ④ 各平台用户级环境变量**。

完整设计（含所有实测证据与取舍理由）见 [`docs/dsh-env-manager-design.md`](docs/dsh-env-manager-design.md)。
这份 README 只讲**怎么跑、怎么验、代码在哪**。

---

## 快速上手

```powershell
# 装进 web profile（会在 profile 的 package.json 里加 link: 依赖并把本包加入 dsh.profile.bundles）
dsh plugin --profile web add <本目录绝对路径>

# 不启动服务，先验证配置能正确组合
dsh --profile web --dump-config

# 启动（首次加载本插件必须重启，patchReload: live 不覆盖新增 bundle）
dsh web
```

重启后点**会话头部右上角的图标**（在「在应用中打开」「后台任务」旁边）打开。

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
| `src/host-api.ts` → `lib/host-api.js` | 读路由 + 客户端数据投影 | 长值摘要化；**敏感名只回长度**；错误结构化 |
| `src/write-routes.ts` → `lib/write-routes.js` | 写路由 + 请求策略闸门 | **路径由层标识推导，不接受任意路径**；复用 `connection.requestRejection` |
| `src/client.ts` → `lib/client.js` | 客户端入口与数据流 | 注册进**会话头部工具区** `conversation.session.header.utilities`，点开是模态框；普通 ESM 源码，`build/client-wrapper.mjs` 在构建后把它包成惰性 CJS 工厂（`window.__ModuleLoader__.load`）。**产物里只允许种子表内的说明符**：`react` 与 `@deepseek-ai/dsh-client-ui-primitives` |
| `src/client-ui.ts` | 客户端表现层 | 只有排版与样式，不认识 `fetch`；KEY/VALUE 是内容、其余是注解。被 `client.ts` 内联进同一个 bundle |

---

## 验证

### 测试套件（10 个可运行文件，949 项断言）

```powershell
pnpm run build                    # 套件测的是 lib/*.js，所以先构建
node check-p0.mjs                 # 插件形态 + 客户端 bundle 契约（39）
node verify-env-model.mjs         # 复合模型、差分测试、禁止名单保真（192）
node verify-env-write.mjs         # 结构保留、CAS、并发、BOM（115）
node verify-credentials.mjs       # 密钥零泄露与遮蔽分类（52）
node verify-host-api.mjs          # 读路由、投影、reg.exe 执行器（97）
node verify-registry.mjs          # 注册表解析、类型保留、并入模型（82）
node verify-registry-roundtrip.mjs # 真写 HKCU 再清理的往返（24）
node verify-write-routes.mjs      # 写路由、路径白名单、请求闸门（93）
node audit-hostile-input.mjs      # 敌意输入审计：畸形请求不崩、不泄露（192）
node verify-client-ui.mjs         # 客户端 UI：入口位置、排版层级、交互与请求体（63）

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

它会自建 `ENVMGR_LAYER_TEST` 变量（**不能用 `DSH_` 前缀** —— 那会被禁止名单
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
| 项目 / 用户 `.env` | ✅ | 🔄 需重启 DSH |
| OS 用户级 / 系统级（注册表）| ✅ | 🔄 需重启 DSH |

**模型执行的 shell 读不到密钥**：子进程环境会清洗 `/KEY|PASSWORD|SECRET|TOKEN/i`
形状的名字。这是 DSH 有意的安全设计，UI 会标注「shell 不可见」。

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

- **客户端 bundle 是手写的惰性 CJS 工厂**，`require` 只允许解析表内的模块（本项目只用 `react`）
- **首次安装必须重启 DSH**：`patchReload: live` 只覆盖 `cordis.patch.yml`，不覆盖新增 bundle
- **任何读服务的插件都必须声明 `inject`**：cordis 对未声明的服务直接抛错，不是返回 `undefined`
- **路由鉴权是路由所有者的责任**：`dsh-host-webserver` 自身不带鉴权，必须自己过 `connection.requestRejection`
