# DSH 环境变量管理插件 — 设计方案

> 目标：一个 DSH 插件，让开发者在 DSH Web UI 里管理环境变量。
> 覆盖层级：① 启动期 `.env` 文件 ② 运行时 `DSH_*` 注入变量 ③ 密钥（`.credentials.yaml`）④ 各平台用户级/系统级环境变量。
> 本文档中所有结论都标注了来源（本机包源码 / README / 官方文档），可直接复核。

---

## 0. 三个决定性结论（先看这个）

在写任何代码之前，有三条硬约束会改变整个设计：

### 结论 1 — `DSH_*` 变量**无法**通过 OS 用户级环境变量设置

`dsh-app-boot` 的实现里有一个"只能由启动环境提供"的名单：

```js
/** Name prefixes no discovered file may set. */
const BOOTSTRAP_PREFIXES = [ "DSH_", "XDG_", "DYLD_", "BASH_FUNC_" ];
```

- 任何 `.env` 文件（项目或 `$DSH_HOME`）里写 `DSH_` 开头的变量 → **抛错，启动失败**（fail-loud，不是警告）：
  `${binName}: ${path} sets "${name}", which only the launching environment may set ...`
- 这不是"忽略"，是拒绝启动。UI 必须把 `DSH_*` / `XDG_*` / `DYLD_*` / `BASH_FUNC_*` 标为**不可写**，并且在用户输入时前置拦截，否则用户一次误操作会让 DSH 起不来。

### 结论 2 — 模型 shell 调用收到的 `DSH_*` 是**注册表重建**的，环境里的同名值会被丢弃

`dsh-shell-env` 的声明原文：

> The namespace is rebuilt for every model shell call: ambient `DSH_*` values are discarded by the executor, then the registry's current snapshot is injected.

所以**在 OS 里设 `DSH_HOME` 或 `DSH_WEB_URL`、想影响模型 shell，是无效的** —— 每次 shell 调用都会被注册表覆盖。

本机实测印证了这一点：`DSH_HOME`、`DSH_WEB_URL` **都不在** `HKCU\Environment` 里（`HKCU\Environment` 只有 `Path`），它们是运行时注入的：

```js
// dsh-web-app/lib/index.js
runtimeCtx.shellEnv.register({
  name: ...,
  variables: { [DSH_WEB_URL]: { description: "Canonical local URL of the ... Web GUI serving this session." } },
  resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) })
})
```

**含义**：想管理 `DSH_*`，唯一正确的位置是插件自己的 `ctx.shellEnv.register()`，而不是 OS 环境变量管理器。UI 上这两者必须**分区呈现**，不能混在一个列表里。

### 结论 3 — 运行中的 DSH 无法感知 OS 用户级环境变量的变更

Node 的 `process.env` 在进程启动时由**父进程**一次性决定（[Node 官方文档](https://nodejs.org/api/process.html#processenv)）。DSH 进程不会去轮询注册表或 shell profile。

本机还在跑着 `DSH_WEB_URL=http://127.0.0.1:3080` 这个 web 服务。**通过 UI 写入的用户级环境变量，对当前这个进程永远不可见**，必须重启 DSH 才生效。UI 必须对"OS 用户级变量"这一类明确标注**需要重启**，否则用户会以为功能坏了。

> 唯一例外：`$DSH_HOME/.env` 在**启动时**被读取到 launch 快照里。但它同样需要重启才能进入运行中的进程。

> ⚠️ **本条在 §11 中被部分推翻**：那个"唯一例外"其实不止一个例外。经进一步核实，`.env` 的值在启动时会被**写入 `process.env`**（不只是进快照），而子进程环境是**每次 spawn 时从 `process.env` 重建**的 —— 这意味着我们自己写 `.env` 是**可以立即生效**的。详见 §11。

---

## 1. DSH 环境变量权威表

环境变量在 DSH 里不是一个东西，是**六个互相竞争的权威**。读和写各有一条不同的顺序 —— 这是最容易设计错的地方。

### 1.1 权威清单

| # | 权威 | 载体 | 谁维护 | 可否热生效 | 可否由本插件写 |
|---|---|---|---|---|---|
| A | 继承的进程环境 | 启动 DSH 的父进程 / OS | OS 或启动它的 shell | ❌ 需重启 | ❌ 只能由外部设置 |
| B | 项目 `.env` | `<调用目录>/.env` | 用户 / 仓库 | ❌ 需重启 | ✅ 文件写入 |
| C | 用户 `.env` | `$DSH_HOME/.env`（默认 `~/.dsh/.env`） | 用户 | ❌ 需重启 | ✅ 文件写入 |
| D | 凭据库 | `$DSH_HOME/.credentials.yaml` | 用户 / UI | ✅ **立即生效** | ✅ 经 `ctx.credentials` |
| E | OS 用户级 / 系统级环境 | 注册表 / shell profile / launchd | OS | ❌ 需重启 DSH | ✅ 平台相关 API |
| F | 每调用 `DSH_*` | `ctx.shellEnv` 注册表 | 插件 | ✅ **立即生效** | ✅ `shellEnv.register` |

### 1.2 解析顺序（读路径）— 两个不同的问题，两个不同答案

**问题一：「一个普通变量（如 `MY_VAR`）的值是什么？」**

```
1. A 继承的进程环境          ← 最高
2. D 凭据库（仅当该名字被当作 credential ref 解析时）
3. B 项目 .env
4. C 用户 .env               ← 最低
```

来源：`dsh-credentials-local` README 原文 —— "Credential lookup follows a fixed precedence: **the launch environment wins, followed by the stored file, the project's `.env`, and the harness-home `.env`**"。

**问题二：「launch 快照本身怎么分层？」**

```
1. A 继承的进程环境      source: 'process'      ← 最高
2. B 项目 .env           source: 'project-env'
3. C 用户 .env           source: 'user-env'     ← 最低
```

来源：`dsh-launch-environment` 的 `SOURCE_ORDER = ["process", "project-env", "user-env"]`。

**问题三：「模型 shell 调用看到的 `DSH_*` 是什么？」**

```
每次调用重建：丢弃环境里的 DSH_* → 注入注册表快照（内置 + 各插件贡献者）
```

### 1.3 写路径与读路径**不对称**（必须理解的坑）

| 写进哪里 | 读的时候排第几 | 后果 |
|---|---|---|
| `project/.env` | 第 3 | 会被继承环境**和**凭据库遮蔽 |
| `$DSH_HOME/.env` | 第 4（最低） | 会被上面三层全部遮蔽 |
| 凭据库 | 第 2 | 会被继承环境遮蔽 |
| 继承环境 | 第 1 | 无法从进程内部修改 |

**这直接导致一条官方约束**：`ctx.credentials.set()` 有 "environment-shadowed" 预检 —— **当某个名字已经被继承环境提供时，写凭据会被拒绝**。

> 原文："`set`/`unset` queue onto one exclusive operation chain: entry checks reject early (disposed, empty value, **environment-shadowed**)"

**UI 设计后果**：当用户在密钥页想设置 `DEEPSEEK_API_KEY`，而该名字已在继承环境里存在时，UI 不能显示一个会失败的输入框。必须先把读取到的**遮蔽来源**（"这个名字已被启动环境提供，凭据库无法覆盖它"）展示出来，并引导用户去修改正确的层，或明确告知需先从启动环境移除。

### 1.4 凭据库为何**不是**通用环境层

`dsh-credentials-local` README 明确拒绝了这个用法：

> "A versioned document with `refs` and `records` sections rather than a dotenv file: a store the harness owns and never materializes into the environment cannot also serve as the user's environment layer, **which would shadow non-secret entries behind its precedence**."

**含义**：不要让用户把普通变量塞进凭据库。凭据库优先级很高（第 2），一旦当环境层用，会把 `.env` 里的非密钥项全部遮蔽。UI 必须把「密钥」和「普通变量」做成两个不同的编辑面，而不是一个列表加个"是否加密"开关。

---

## 2. 跨平台环境变量：读取顺序与语义

这一节回答"我不熟悉各平台读取顺序"的问题。

### 2.1 Windows

**权威只有一个：注册表。** 没有 profile 文件这一层（PowerShell profile 只对 PowerShell 生效，不是 OS 环境）。

| 作用域 | 注册表位置 | 生效范围 |
|---|---|---|
| 用户级 | `HKCU\Environment` | 当前用户，优先级**更高** |
| 系统级 | `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` | 全机器 |

- **PATH 是唯一会合并的变量**：最终 PATH = 系统 PATH + `;` + 用户 PATH（**系统在前**）。这是 Windows 上唯一一个"两层叠加"的变量，其他变量都是用户级覆盖系统级。
- **名称大小写不敏感**。DSH 的实现已适配：`lookupKey()` 在 `win32` 上做 `toUpperCase()` 折叠，POSIX 上精确匹配。

```js
return process.platform === "win32" ? name.toUpperCase() : name;
```

- **类型**：`REG_SZ`（字面值）vs `REG_EXPAND_SZ`（含 `%VAR%` 引用，读取时展开）。UI 写回时必须**保留原有类型**，把 `REG_EXPAND_SZ` 写回 `REG_SZ` 会破坏 `%USERPROFILE%` 这类引用。
- **路径复用**：Windows 有用户级和系统级两份 `Path`，UI 必须显示"我改的是哪一份"，否则会出现"改了但没生效"的困惑。
- **生效时机**：注册表改动不会自动进入已运行的进程。需要向所有顶层窗口广播 `WM_SETTINGCHANGE` 通知（`SendMessageTimeout` + `SMTO_ABORTIFHUNG`），新建的进程才会拿到新值 —— 且**资源管理器重启/新登录**才最可靠。
- **隐藏变量**：注册表值可以带 `Hidden` 标志，UI 默认隐藏。做环境变量管理器时要注意，否则"看不见的变量"会让人困惑。

### 2.2 Linux

不存在单一的"用户级环境变量"。按会话类型分岔：

| 场景 | 读取来源 | 顺序 |
|---|---|---|
| **登录 shell** | `/etc/profile` → `/etc/profile.d/*.sh` → `~/.bash_profile` / `~/.bash_login` / `~/.profile`（**只取第一个存在的**） | 系统 → 用户 |
| **交互非登录 shell** | `/etc/bash.bashrc` → `~/.bashrc` | 系统 → 用户 |
| **桌面会话（PAM）** | `/etc/environment` → `~/.pam_environment`（已弃用，见下） | 系统 → 用户 |
| **systemd 用户服务** | `/etc/environment`、`/etc/environment.d/*.conf`、`~/.config/environment.d/*.conf`、`systemctl --user set-environment` | environment.d 按文件名字典序，**后者覆盖前者** |
| **直接 exec（无 shell）** | 什么都不读，**完全继承**父进程 | — |

关键点：

- **`~/.pam_environment` 已弃用**（PAM 1.4 起对未加 `--with-pam-env` 的发行版不再构建该模块）。新系统不要依赖它。
- **`~/.config/environment.d/*.conf` 只影响 systemd 用户会话**（`systemd --user` 拉起的进程）。从 SSH 直接登录或从终端直接跑 `dsh` **不会**读到它。这是最常见的"我设了但没用"来源。
- **`/etc/environment` 不是 shell 脚本**：只有 `KEY=value`，不支持 `$VAR` 展开、不支持 `export`、不支持条件逻辑。
- **`PATH` 不是环境变量文件设的**，通常是 `/etc/profile` 里拼接的。

### 2.3 macOS

macOS 的坑最深：**GUI 应用的父进程是 `launchd`，不是你的 shell。**

| 启动方式 | 环境来自 |
|---|---|
| 从 Terminal 跑 `dsh` | 该 shell 的环境（profile 链：`/etc/profile` → `~/.zprofile` → `~/.zshrc`，zsh 已是默认） |
| 从 Finder / Dock / IDE 启动 | **`launchd` 的环境**，与 shell profile **完全无关** |
| ssh 登录 | 登录 shell 的环境 |

- `launchctl setenv NAME value` 设置的是 **launchd 会话的环境**，只影响**之后启动**的进程；已运行的 GUI 应用（包括已开着的终端）**看不到**。
- `/etc/launchd.conf` 在 macOS 10.10 之后**已被忽略**，网上很多老教程还在教这个。
- GUI 应用登录时的环境还受 `~/.MacOSX/environment.plist` 影响（同样历史悠久，可靠性差）。
- **结论**：macOS 上"用户级环境变量"没有单一可靠写入点。如果 DSH 是从 Finder/IDE 启动的，UI 写了 shell profile **不会有任何效果**。UI 必须能显示**当前 DSH 进程的父进程是谁 / 环境从哪来**，否则用户在 macOS 上必然踩坑。

### 2.4 三平台对照

| 维度 | Windows | Linux | macOS |
|---|---|---|---|
| 存储载体 | 注册表（用户 + 系统两个作用域） | shell profile / PAM / systemd 多套并存 | launchd（GUI）+ shell profile（终端），互不相通 |
| 名称大小写 | **不敏感** | 敏感 | 敏感 |
| PATH 语义 | 系统 + 用户**合并**，系统在前 | profile 里字符串拼接 | 同 Linux |
| 变量引用/展开 | `REG_EXPAND_SZ` 的 `%VAR%` | `$VAR`（仅脚本层） | `$VAR`（仅脚本层） |
| 写入 API | `HKCU\Environment` + `WM_SETTINGCHANGE` 广播 | 编辑 profile 文件 | `launchctl setenv`（不持久！重启失效） |
| 持久性 | 注册表持久 | 文件持久 | `launchctl setenv` **不持久**，需 LaunchAgent plist |
| 生效条件 | 新进程 / 重新登录 | 新 shell | 新进程（且仅限 launchd 会话） |

---

## 3. 禁止写入名单（必须在 UI 层拦截）

来自 `dsh-app-boot` 的实现，**任何 `.env` 文件**声明这些名字都会**导致启动失败**。

### 3.1 前缀禁令（无条件）

```
DSH_   XDG_   DYLD_   BASH_FUNC_
```

### 3.2 精确名单（无条件）

```
PATH  HOME  USERPROFILE  SHELL
NODE_OPTIONS  NODE_PATH  NODE_EXTRA_CA_CERTS
LD_PRELOAD  LD_LIBRARY_PATH  LD_AUDIT
BASH_ENV  ENV  SHELLOPTS  BASHOPTS
PERL5OPT  PERL5LIB  PYTHONSTARTUP  PYTHONPATH  PYTHONHOME
RUBYOPT  RUBYLIB
JAVA_TOOL_OPTIONS  _JAVA_OPTIONS  JDK_JAVA_OPTIONS
GIT_SSH  GIT_SSH_COMMAND  GIT_EXTERNAL_DIFF  GIT_PAGER  GIT_EDITOR  GIT_ASKPASS
GIT_CONFIG_GLOBAL  GIT_CONFIG_SYSTEM  GIT_CONFIG_COUNT
SSH_ASKPASS
EDITOR  VISUAL  PAGER  BROWSER
SSL_CERT_FILE  SSL_CERT_DIR  REQUESTS_CA_BUNDLE  CURL_CA_BUNDLE
NODE_TLS_REJECT_UNAUTHORIZED
```

### 3.3 唯一的例外：`$DSH_HOME/.env` 可以设代理

```js
const HOME_LAYER_PROXY_NAMES = new Set([ "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY" ]);
```

设计理由（源码注释原文）："A proxy chooses the route every request takes, so the invoking directory's file — which arrives with a clone — keeps refusing them; the home file is the user's own... The CA and TLS names in the same group stay refused everywhere: they change **what is trusted**, not where traffic goes."

**UI 后果**：这 4 个代理变量在 `$DSH_HOME/.env` 层**可写**，在项目 `.env` 层**不可写**。UI 的顺序敏感 —— 同一变量在不同层的可写性不同，必须逐层判断，不能用一张全局禁用表。

### 3.4 错误提示照抄原文

源码里已经写好了给用户看的两条补救提示，UI 直接复用即可保持术语一致：

```
export ${name}, or put it in ${resolve(home, ".env")}, which does not travel with a repository
export ${name} instead of putting it in a .env file
```

---

## 4. 文件格式约束

### 4.1 `.env` 解析器 = `node:util.parseEnv`（不是 dotenv 库）

DSH 用的是 Node 内置 API 的组合：

```js
import { parseEnv } from "node:util";
...
process.loadEnvFile(resolve(dir, ".env"));   // 用于把值装载进 process.env
const values = parseEnv(content);            // 用于读取分层快照（readEnvLayer）
```

#### ⚠️ 实测结果（本机 Node v24.16.0，DSH 进程 `execPath` 同为 Volta 24.16.0，已核对一致）

下面是**在本机实跑出来**的行为，不是照抄文档。用探针脚本逐例验证：

| 输入 | 结果 | 结论 |
|---|---|---|
| `export MY=1` | `{ MY: "1" }` | ✅ **`export` 前缀被接受**（会剥离） |
| `A=1` + `B=$A` | `{ A:"1", B:"$A" }` | ❌ **不展开**，字面量 |
| `C=${OUTER}` | `{ C: "${OUTER}" }` | ❌ **不展开**，字面量 |
| `D=$OUTER`（OUTER 在 process.env 中）| `{ D: "$OUTER" }` | ❌ **不展开**，字面量 |
| `E="x\ny"` | `{ E: "x\ny" }` | ✅ 双引号转义生效 |
| `F='$OUTER'` | `{ F: "$OUTER" }` | ✅ 单引号字面量 |
| `G: v` | `{}` | ❌ **冒号分隔不支持，且该行被静默丢弃** |
| `H=1 # tail` | `{ H: "1" }` | ✅ 行尾注释被剥离 |
| `I="l1\nl2"` | `{ I: "l1\nl2" }` | ✅ 双引号支持跨行 |
| `J=` | `{ J: "" }` | ✅ 空值 |
| `  K = spaced  ` | `{ K: "spaced" }` | ✅ 键值两侧空白被修剪 |

并且 `process.loadEnvFile()` 装载进 `process.env` 后**同样不展开**：

```
文件内容:  AAA=1  BBB=$AAA  CCC=${AAA}  DDD=%AAA%
装载结果:  {AAA:"1", BBB:"$AAA", CCC:"${AAA}", DDD:"%AAA%"}
```

**核心结论：DSH 的 `.env` 不做任何变量展开，`$VAR` / `${VAR}` / `%VAR%` 全部按字面量写入环境。**

#### 引号策略（P1 实测，比 §4.1 上表更精确）

序列化值时引号怎么选，完全由实测决定（`probe-quote-strategy.mjs` +
`probe-roundtrip-via-file.mjs`，且同时在 `parseEnv` 与 `process.loadEnvFile`
**两条路径**上验证——后者才是 DSH 真正把值装进 `process.env` 的通道）：

| 值的形状 | 安全写法 | 忠实？ |
|---|---|---|
| 普通 / 含空白 / 含 `#` | `KEY="v"` | ✅ |
| 含双引号 `"` | `KEY='v'` | ✅ 单引号内双引号是字面量 |
| 含单引号 `'` | `KEY="v"` | ✅ 双引号内单引号是字面量 |
| 含换行 | `KEY="a\nb"` | ✅ `\n` 是双引号内**唯一**被识别的转义 |
| 含反斜杠 | `KEY="a\b"` | ✅ 必须原样写出，写 `\\` 会读回两个反斜杠 |
| **同时含 `"` 和 `'`** | 无解 | ❌ 两种引号都在首个同类引号处截断 |
| **同时含 `"` 和换行** | 无解 | ❌ 双引号内无法转义引号，单引号不能跨行表示 |
| 空值 | `KEY=""` | ⚠️ 能读回空串，但与"未设置"**无法区分** |

**注意这一版推翻了我最初的假设**：我原以为"含单引号的值有损"，实测证明
`K="with 'single'"` 完美往返；反过来单引号能承载双引号也是实测结论。
真正有损的只有上表加粗的两类。

`lib/env-model.mjs` 的 `serializeDotEnvLine` 据此实现，并用
`representabilityOf()` 把「有损」（必须拒绝保存）与「歧义」（必须提醒）
两类问题区分开 —— **UI 绝不能静默写坏用户的值**。

#### 这对设计意味着什么（重要）

1. **绝对不能写"引用式"值**。用户若在 UI 里填 `$HOME/bin` 期望展开，得到的是字面字符串 `$HOME/bin`，并且会**原样传给模型 shell**、原样给到各种 CLI —— 这类值往往在很久之后才以奇怪的方式爆掉。UI 应在值包含 `$` 或 `%` 时给出提示。
2. **不做变量展开反而是好事**：序列化逻辑可以极简，`KEY="escaped-value"` 就够，不必担心解析顺序或循环引用。
3. **必须用结构化序列化**，不能做"原样文本编辑 + 保存"。原因不是 `export`（它其实被支持），而是**冒号分隔的行会被静默丢弃** —— 用户手写一行 `KEY: value` 看起来完全正常，保存后该变量凭空消失且无任何报错。
4. **写值一律用双引号包裹并转义 `\` 与 `"`**，这样跨行、空格、`#`、`$` 都不会引发歧义。
5. **注意跨平台不对称**：Windows 注册表的 `REG_EXPAND_SZ` **会**展开 `%VAR%`，而 `.env` **不会**展开任何东西。同一个变量名走不同层时语义不同，UI 需要按层说明。

### 4.2 `$DSH_HOME/.credentials.yaml` 是"文档"不是 dotenv

```yaml
# 版本化文档，含 refs 与 records 两节
refs:    { ... }   # 按名字引用的密钥
records: { ... }   # 插件持有的凭据记录（授权 grant 等）
```

- **不要手写这个文件**，走 `ctx.credentials.set/unset` 与 `describe`。
- `describe(ref)` 返回 `{ configured, source?, writable }` —— **永远不返回值本身**。
- 空字符串的 key 值 **等同于未设置**；空 record 则是**有意的已存凭据**（两者语义不同，UI 文案要区分）。

### 4.3 `$DSH_HOME/settings.yaml`

本机已存在 `C:\Users\qq651\.dsh\settings.yaml`。这是 `ctx.settings` + `dsh-settings-file` 的载体，适合存**非密钥**的插件配置与元数据（如"UI 里展示哪些变量"、"分组标签"），**不适合存密钥**。

---

## 5. 权限与隔离边界（含一个必须诚实说明的落差）

### 5.1 POSIX

| 对象 | 要求 | 强制力 |
|---|---|---|
| `~/.dsh/.credentials.yaml` | 仅属主可读（0600）| **强制**：DSH 拒绝加载任何其他用户可读的凭据文件，报错并提示 `chmod 600` |
| `~/.dsh/.env` | 建议 0600 | ⚠️ **无强制检查** |
| `<project>/.env` | 视仓库而定 | ⚠️ 通常 0644，且**会随仓库分发** |
| `~/.dsh/` 目录 | 建议 0700 | ⚠️ 无强制检查 |

### 5.2 Windows

**这里有一个必须对用户诚实说明的落差。**

`dsh-credentials-local` README 说 "Only your OS user can read the file"。但本机实测 ACL：

```
IdentityReference         FileSystemRights  AccessControlType
NT AUTHORITY\SYSTEM       FullControl       Allow
BUILTIN\Administrators    FullControl       Allow
PcOfSimooo\qq651          FullControl       Allow
```

- Windows 上的检查是**跳过**的，README 原文："Windows has no mode to inspect, so the check is skipped there rather than faked."
- 上面这个 ACL 是标准的继承 ACL，**Administrators 和 SYSTEM 都有完全控制权**。所以"只有你的 OS 用户能读"在 Windows 上**并不严格成立**。

### 5.3 真正的边界声明

README 自己把话说得很清楚，UI 文案应该照抄这个诚实程度：

> "The agent is not another user: its tool processes run as you, so they can read the file like any other file you own. ... **That is discretion, not a boundary**: a deployment that must keep provider keys away from its own agent cannot get there with file permissions."

**含义**：文件权限**挡不住 agent**。UI 里任何"加密存储"、"安全隔离"的措辞都会误导用户。正确措辞是："此处的密钥对以你身份运行的任何进程可见，包括 agent 的工具调用。"

---

## 6. 插件设计

### 6.1 分层职责

```
┌─────────────────────────────────────────────────────────────┐
│ 客户端半边  dsh.client (platform: 'web')                     │
│   占据 settings.plugins.tab 槽位 → "环境变量" 一页             │
│   ctx.settingsScope.bind() 读写 settings 命名空间             │
│   host.call() 走宿主 API 做实际文件/注册表操作                  │
│   ⚠️ 永不接收密钥明文                                         │
├─────────────────────────────────────────────────────────────┤
│ 宿主半边  lib/index.js                                       │
│   ① 列举所有层 + 遮蔽关系（读）                                │
│   ② 写 .env 文件（结构化序列化 + 原子写 + 0600）               │
│   ③ ctx.credentials.set/unset/describe（密钥，含遮蔽预检）      │
│   ④ ctx.shellEnv.register（DSH_* 贡献者，运行时生效）           │
│   ⑤ 平台适配器：Windows 注册表 / Linux profile / macOS launchd  │
│   ⑥ 禁止名单校验（boot 前拦截，避免用户把 DSH 写挂）             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 数据模型：**复合变量**而非扁平列表

这是整个设计的核心抽象。不能给用户一个扁平的 `KEY=VALUE` 列表 —— 因为同一个名字可能同时存在于 6 个权威里，而"当前生效值"只是其中一个。

```ts
/** 一个权威层的取值。 */
interface EnvLayerValue {
  layer: 'process' | 'project-env' | 'user-env' | 'credential'
       | 'os-user' | 'os-machine' | 'shell-registry'
  /** 该层提供的值；只有 process 层与已配置的密钥可返回；否则为 undefined */
  value?: string
  /** 值的来源文件绝对路径（process 层无） */
  path?: string
  /** 该层是否可被本插件写入 */
  writable: boolean
  /** 不可写的原因（禁止名单 / 平台不支持 / 需重启 / 被遮蔽） */
  blockedReason?: string
}

/** 一个环境变量名字的完整身份。 */
interface CompositeVariable {
  name: string
  /** 按权威顺序排列；首个有值的即为当前生效层 */
  layers: EnvLayerValue[]
  /** 当前生效层（= layers 中第一个有值的） */
  effective?: EnvLayerValue['layer']
  /** 是否命中禁止名单 */
  forbidden: boolean
  /** 是否是密钥（走凭据域，值永远不返回） */
  secret: boolean
  /** 是否是 DSH_* 命名空间（不可由 .env 或 OS 层设置） */
  runtimeManaged: boolean
}
```

**UI 呈现规则**：

| 情况 | 呈现 | 生效方式标注（见 §11）|
|---|---|---|
| 只有一个层有值 | 单行显示值 + 层标签 | 按层显示 🟢立即 / 🔄重启 |
| 多层有值且**值相同** | 单行显示，层标签标"多处一致" | 同上 |
| 多层有值且**值不同** | **折叠展开**，高亮生效层，其余层灰显并标注"被遮蔽" | 同上 |
| 命中禁止名单 | 红标"不可写入 .env"，禁用编辑，提示正确做法 | — |
| `DSH_*` 命名空间 | 独立分区，标注"由插件运行时提供，不来自环境" | 🟢 立即 |
| 密钥 | 显示"已配置 / 未配置" + 来源 + 可否写，**永不显示值** | 🟢 立即（DSH 内部）/ 🔒 shell 不可见 |
| 标记为"shell 可见"的变量 | 额外标记 | 🟢 下次 shell 调用 |

这正是"帮助开发者理解自己环境"的地方 —— 大多数人 debug 环境变量问题的根因就是不知道有多个层在竞争，以及不知道改动什么时候生效。

### 6.3 挂载点：`settings.plugins.tab`

来自 `dsh-client-ui-settings` 的槽位契约（`contract/slots.d.ts`）：

```ts
'settings.plugins.tab': {
  kind: 'list';
  scope: 'root';
  owner: SettingsPluginsTabOwnerProps;   // { children?: never } —— 分区不传任何 props
};
```

契约原文（关于这个槽位的语义）：

> "One page inside the Plugins settings section. The section owner renders localized entry labels as tabs and mounts each contribution inside its corresponding tab panel. Options: `id` (tab key), `order` (tab order), and `label` (registrant-localized tab text). Declared at runtime by the feature that owns the Plugins section."

- 分区外壳**零文案**，所有文本由注册者提供 → 我们的页签标签是自己的责任，且**locale 变化时要重新注册**（外壳不订阅 locale 状态）。
- 现有 card 顺序是：shell executor (`bash`)、`agent-loop`、`subagent-model-selection`、`web-search-deepseek` → 我们的 `order` 应排在其后。
- **`owner: SettingsPluginsTabOwnerProps` 是空 props**，页面的数据**全部**从自己的 inject face 与 store 来。

### 6.4 命名空间与并发栅栏

用 `ctx.settingsScope.bind(spec)` 绑定一个命名空间（如 `env-manager`），用于持久化**非密钥**的 UI 元数据。

必须实现 `expectedRevision` 栅栏 —— 契约原文：

> "Each write is fenced by the namespace revision as `expectedRevision`, so a concurrent write from another surface is refused instead of silently overwritten."

**这里有一个必须自行处理的危险**：settings 的 revision 栅栏**只保护 settings 文档**。而我们的插件真正写的是 `.env` 文件、注册表、凭据库 —— 这些都在 settings 文档之外，**没有任何 revision 保护**。

设计对策：
- 文件层写入使用「读取 → 校验 mtime+hash 未变 → 原子替换（temp + rename）」的 CAS 循环，不匹配则拒绝并重新读取展示。
- 每个可写层都必须暴露一个 `revision`（文件用 mtime+size+hash，注册表用读取时快照）参与栅栏判断。
- 这与 `dsh-client-ui-settings-plugins` 的既有行为一致："If the configuration changed after the card loaded, the save is rejected instead of overwriting the newer values."

### 6.5 宿主 API 面（草稿）

```ts
// 读：不返回值本身（除 process 层与可读文件层），只返回结构与 provenance
ctx.envManager.list(opts?: { scope?: 'project' | 'home' | 'os-user' | 'os-machine' }): Promise<CompositeVariable[]>

// 写普通变量到某一层（禁止名单校验 + CAS + 原子写）
ctx.envManager.set(layer, name, value, expectedRevision): Promise<Result>

// 删
ctx.envManager.unset(layer, name, expectedRevision): Promise<Result>

// 密钥：只转发 describe，值永不回传客户端
ctx.credentials.describe(ref)  // → { configured, source?, writable }
ctx.credentials.set(ref, value)
ctx.credentials.unset(ref)

// DSH_* 运行时：注册贡献者（含时间变化的 resolve）
ctx.shellEnv.register({ name, variables, resolve })
ctx.shellEnv.list()   // → BashEnvVariableInfo[]，可枚举、不执行 resolve
```

`ctx.shellEnv.list()` 是现成的**只读清单**（"Enumerate plugin-contributed variables without executing their resolvers"），最适合做「运行时 DSH_* 变量」分区的展示，且零风险。

---

## 7. 落点实现细节

### 7.1 客户端半边声明（`package.json`）

照抄 `dsh-client-ui-settings-plugins` 的既有形态：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":         { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client":  { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-api-remotes"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "4.0.2" }
}
```

加载机制（`dsh-client-modules` README）：宿主扫描 Loader 条目 → 组合 boot graph → Web carrier 在 `/plugins` 暴露 bundle → 浏览器**按需懒加载**。`<id>/client` 与裸 id 解析到同一份导出。

### 7.2 各层写入实现矩阵

| 层 | 实现要点 | 难点 |
|---|---|---|
| 项目 `.env` | `parseEnv` 读取 → 合并 → 结构化序列化（`KEY="escaped"`）→ 原子写 | 保留用户注释与键序；必须避免生成 `KEY: value` 冒号形式（静默丢弃）|
| `$DSH_HOME/.env` | 同上；此层额外允许 4 个代理变量 | 需与项目层区分可写性判断 |
| 凭据库 | `ctx.credentials.set/unset`，捕获 environment-shadowed 错误 | 必须在 UI 前置展示遮蔽来源 |
| `DSH_*` 运行时 | `ctx.shellEnv.register({ name, variables, resolve })` | 注册以**贡献者**为单位、key 冲突**大声报错**；随 fiber 销毁 |
| Windows 注册表 | `HKCU\Environment` / `HKLM\...\Environment`；**保留 `REG_EXPAND_SZ` 类型**；写后广播 `WM_SETTINGCHANGE` | 需提权才能写 HKLM；PATH 合并语义特殊 |
| Linux | 编辑 shell profile（带标记块）或 `~/.config/environment.d/*.conf` | 无法覆盖所有会话类型；需明确告知适用范围 |
| macOS | shell profile（终端启动）或 LaunchAgent plist（GUI 启动，持久）| `launchctl setenv` **不持久**，不能单独使用 |

**关于编辑 shell profile**：建议采用「受管标记块」方案，而不是任意文件编辑：

```sh
# >>> dsh-env-manager >>>
export MY_VAR="value"
# <<< dsh-env-manager <<<
```

这样可以安全撤销，也不会破坏用户自己的 profile 内容。但必须告知：**这只对之后新启动的 shell 生效**。

### 7.3 一个必须复核的加载机制细节

`profiles/web/package.json` 里是 `"patchReload": "live"`，profile 目录下也有 `.dsh-module-fallback`。

`patchReload: live` 的语义（`dsh` README）：**watches the profile and home-level patch files** —— 即监听 `cordis.patch.yml` 的变更。

**需要验证**：`node_modules` 里**新增**一个包时，live reload 是否会重新扫描 Loader 条目。合理的预期是**不会**（它监听的是 patch 文件，不是 node_modules 目录树），因此**首次安装插件后需要重启 DSH**，之后改 `cordis.patch.yml` 才能热重载。

> 这一条我尚未实测确认，列为方案落地时**第一个要验证的假设** —— 它决定开发循环是"秒级热重载"还是"每次重启 30 秒"。

### 7.4 开发与安装流程

```powershell
# 安装到 web profile（转发给 profile 目录下的 pnpm）
dsh plugin --profile web add <path-or-pkg>

# 检查组合后的插件树而不启动
dsh --profile web --dump-config
dsh --profile web --dump-default-config
```

⚠️ **注意**：`desktop` 这个 profile 名被保留给 Electron 所有，CLI 会拒绝 boot / dump-config / 插件管理请求。我们用的是 `web`，不受影响。

---

## 8. 分阶段实施

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 探针** | 最小宿主插件 + 一个 `settings.plugins.tab` 页签，只渲染静态文案；**并行验证 §11 的单变量热重载** | ① 页签出现在 Plugins 分区，确定 7.3 的开发循环；② 用 `shellEnv.register` 注册一个 `DSH_*` 变量，在 UI 里改值后**不重启**、下一次 shell 调用即读到新值（验证档 A）；③ 确认 shell 工具是否有可挂载的 env 覆盖点（验证档 B 是否成立）|
| **P1 只读视图** | `list()` 读全部层，复合模型 + 遮蔽关系可视化 | 能正确解释本机现状：`DSH_HOME`/`DSH_WEB_URL` 显示为"运行时提供"，`HKCU\Environment` 的 `Path` 显示为 OS 用户级 |
| **P2 文件层写入** | `.env` 结构化读写 + 禁止名单拦截 + CAS + 原子写 + 0600 | 尝试写 `DSH_HOME` 被拦截并给出正确提示；外部改动后保存被拒而不是覆盖 |
| **P3 密钥层** | 凭据域接入 + 遮蔽预检 + 掩码 UI | `DEEPSEEK_API_KEY` 在继承环境中存在时，UI 不显示可写输入框 |
| **P4 运行时 DSH_*** | `shellEnv.register` + `shellEnv.list()` 展示 | UI 改完无需重启，下一次 shell 调用即可见 |
| **P5 OS 用户级** | Windows 注册表（含 `REG_EXPAND_SZ` + 广播） → Linux profile → macOS | 各平台写入后重启 DSH 生效；UI 明确标注需重启 |

**顺序理由**：P0 先验证最不确定的机制假设；P1 只读先建立正确的模型，避免在错误抽象上写 UI；P2/P3 是有强制约束保护的两层（禁止名单、遮蔽预检），风险可控；P5 平台差异最大且最难验证，放最后。

---

## 9. 反直觉要点速查（实现时贴在旁边）

1. `DSH_*`/`XDG_*`/`DYLD_*`/`BASH_FUNC_*` 写进 `.env` → **DSH 起不来**，不是被忽略。
2. 模型 shell 里的 `DSH_*` 由注册表重建，**OS 里设了也会被丢弃**。
3. 凭据库优先级**高于**两个 `.env`；因此它不能当通用环境层用，否则遮蔽非密钥项。
4. 普通变量的解析顺序是 `继承环境 > 凭据库 > 项目 .env > 用户 .env` —— 写 `.env` 是最弱的一层。
5. 凭据写入有 **environment-shadowed 预检**：名字已在继承环境里 → 写入被拒。
6. `.env` 用 `node:util.parseEnv` + `process.loadEnvFile`，**不做任何变量展开** —— `$VAR`、`${VAR}`、`%VAR%` 全是字面量（本机 v24.16.0 实测）。`export` 前缀**是**被接受的，但**冒号分隔的行（`KEY: value`）会被静默丢弃** —— 这是最危险的静默失败点。
7. Windows 名称**大小写不敏感**（DSH 内部 `toUpperCase()` 折叠），PATH 是唯一**合并**的变量且**系统在前**。
8. macOS GUI 启动的应用**看不见** shell profile；`launchctl setenv` **不持久**且只影响之后启动的进程。
9. Linux 的 `~/.config/environment.d/*.conf` **只影响 systemd 用户会话**，SSH 直连或终端直跑读不到。
10. **权限挡不住 agent** —— 工具进程以同一 OS 用户运行。这是 discretional，不是 boundary。
11. Windows 上凭据文件权限检查是**跳过**的，实际 ACL 里 Administrators 和 SYSTEM 有完全控制权。
12. 运行中的 DSH 进程**永远看不到**新设的 OS 环境变量 —— 必须重启。
13. **写 `.env` 时的键匹配也必须大小写不敏感**（Windows）。漏掉这条会让
    `unset` 静默失效、`set` 产出重复行 —— 见 §20 的真实故障与回归测试。
    禁止名单本身已经是大小写不敏感的（`Path` 也会被挡住）。
14. **UTF-8 BOM 会粘进第一个变量名。** `parseEnv` 不剥离 BOM，所以 DSH 读到的
    是 `\uFEFFFIRST` 而界面显示 `FIRST` —— 用户看不见差别也删不掉它。
    我们剥离并**报告**该差异，但写回时**原样保留 BOM**（见 §22）。
15. **路由鉴权是路由所有者的责任。** `dsh-host-webserver` 自身不带任何鉴权或
    Origin 策略，直接注册在上面的路由默认对跨站请求开放 —— 必须自己调用
    `connection.requestRejection`（见 §21 的实测缺口）。
16. **CAS 挡不住同进程并发。** `.env` 是整文件读-改-写，两个并发请求会读到同一
    revision 而**都通过校验**，10 个"成功"的保存可以丢掉 9 个。
    必须把「读 → 校验 → 写」放进按路径的临界区（见 §24）。
17. **但注册表不需要临界区。** `reg.exe add` 是按值的原子 OS 操作，并发写不同
    值不互相干扰 —— 实测确认（§24.4）。判据是"是否整文件读-改-写"，不是"是否有并发"。

---

## 10. 待确认 / 风险

| # | 项 | 影响 |
|---|---|---|
| 1 | `patchReload: live` 是否覆盖 `node_modules` 新增包（7.3）| 决定开发循环速度，**P0 先验证** |
| 2 | 项目 `.env` 写入时如何保留用户注释与键序 | 影响数据丢失风险 |
| 3 | 写 `HKLM` 需要提权 —— DSH 进程通常非提权运行 | 系统级变量可能只能只读，需降级设计 |
| 4 | macOS / Linux 行为无法在本机验证 | P5 需要目标平台实测或用户协助 |
| 5 | `ctx.settings` 命名空间在 web profile 中是否已挂载 `dsh-settings-file` | 决定 P1 元数据持久化是否开箱可用（本机 `settings.yaml` 已存在，倾向已挂载） |
| 6 | 凭据文件 ACL 是否可收紧（Windows icacls） | 决定能否部分兑现"仅属主可读" |
| 7 | 是否要在写值含 `$` / `%` 时告警 | `.env` 不展开而注册表展开，跨层语义不一致，易产生长期潜伏的 bug |
| 8 | shell 工具是否暴露可挂载的"注入 spawn 显式 env"覆盖点（11.3）| **决定档 B 能否成立**；若不成立则普通变量只能"需重启"或需改 DSH 上游 |
| 9 | `.env` 热生效是否必须偏离 DSH 的"继承优先"规则才看得出效果（11.7）| 若必须偏离，则档 B 应整体降级为档 C（诚实标注需重启）|

> **已通过实测消除的风险**：4.1 的 `.env` 解析语义曾按 Node 文档写成"支持 `${VAR}` 展开"，本机探针证明**不展开**，文档已修正。这提醒：凡是 Node 内置 API 的细节，落码前都以实测为准。

---

## 11. 自研热重载：可行性与方案

> 问题：DSH 不把配置热重载覆盖到环境层取值上，我们能否自己补上？
> **答案：能，但要按层拆开 —— 有的层本来就能热，有的层不能用"重载"的思路，而要拦住 spawn 那一刻。**

先说清 DSH 到底哪里热、哪里不热。`dsh-client-hmr` 存在，`profiles/web/package.json` 里写着 `patchReload: live`，`dsh-app-boot` 里也确实有 `watchUserPatches(ctx, ...)` 在监听 patch 文件。所以 **DSH 的热重载覆盖的是"配置树"，不覆盖"环境层取值"** —— 这两件事必须分开判断。

### 11.1 逐层热重载可行性矩阵

| 层 | 当前是否热 | 我们自己能否做到热 | 机制 |
|---|---|---|---|
| **F** 插件贡献的 `DSH_*` | ✅ **本来就是热的** | ✅ 无需额外工作 | `resolve(execution)` **每次 shell 调用都执行**；`register()` 返回 disposer，注册/注销即时生效 |
| **D** 凭据库（DSH 自身消费） | ✅ **本来就是热的** | ✅ 无需额外工作 | `dsh-llm-deepseek` / `dsh-web-search-deepseek` / `dsh-webhook-github` 每次请求都调 `credentials.resolve(ref)` |
| **D** 凭据库（模型 shell 可见） | ❌ | ⚠️ 技术上可以，但**不应默认做** | 见 11.4 —— 要绕过 `scrubbedParentEnv` 的敏感名清洗，属于安全策略变更 |
| **B/C** `.env` 文件 | ❌ 启动时读一次，快照冻结 | ✅ **可以做到下一个 shell 调用生效** | 值在启动时已进入 `process.env`；子进程环境每次 spawn 重建 → **无需重启** |
| **E** OS 用户级/系统级 | ❌ 需重启 | ⚠️ 部分可以，代价见 11.5 | 自己有读注册表能力，可覆盖进 spawn 环境 |
| 启动期 `launchEnvironment` 快照 | ❌ 不可变 | ❌ **做不到** | 见 11.2 |
| `process.env`（第三方库读取） | ❌ | ⚠️ 可写但有污染风险 | 见 11.3 |

### 11.2 为什么"换掉 `launchEnvironment` 槽位"这条路被堵死

最优雅的方案本应是：我们也提供一个 `launchEnvironment`，让它每次 `get()` 都读最新文件，这样 `launchEnvironmentOf(ctx)` 的所有消费者（`dsh-llm-pi-ai`、代理解析、SSH 判定等）**立刻全部热起来**。

**这条路走不通**，`cordis/src/reflect.ts` 的契约原文：

> `set(name: string, value: any): void`
> Overwrite a provided service's value.
> **Only the fiber that provided the service may set it**; setting an unprovided name throws.

而代理 handler 里的实现是：

```js
if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)
const error = new Error(`cannot set property "${prop}" without provide`)
if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)
return ctx.reflect.set(prop, value, error)
```

`launchEnvironment` 由**启动器所在的 fiber** 提供（在 "before any config entry mounts" 的时刻），我们的插件是另一个 fiber → 赋值会被拒绝。

**教训**：DSH 的"环境快照不可变"是**有意的架构决策**，不是一个可以绕过的懒加载。要热它，只能从**取值点**下手，不能从**快照**下手。

### 11.3 可行的正面路径：控制"spawn 那一刻"

关键发现来自 `dsh-subprocess/lib/index.js`：

```js
/**
* The ambient parent environment minus credential-shaped names and minus all
* `DSH_*` names — the canonical base every harness child starts from.
* ...
* harness identity never leaks implicitly (a deliberately forwarded
* credential or current `DSH_*` fact goes through the spec's explicit `env`,
* which merges after this scrub).
*/
function scrubbedParentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== void 0 && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith("DSH_")) env[key] = value;
  ...
}
```

`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`

**三个立刻可用的结论**：

1. **子进程环境是每次 spawn 时从 `process.env` 重建的**，不是启动时定死的。所以 **`.env` 的值一旦进入 `process.env`，就能立刻被后续子进程看到**。
2. **父进程环境里所有 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 形状的变量被清洗掉**，`DSH_*` 也全部清洗。这意味着 `MY_API_KEY` 这类变量**永远不会自动到达 shell**，只有走"显式 `env`"才会。
3. spec 里**显式传入的 `env` 在清洗之后合并** —— 这是插件唯一合法的注入通道，也是我们做热重载的着力点。

于是本插件可以这样实现 `.env` 的热生效：

```ts
// 我们自己的贡献者：每次 shell 调用都重新读盘，而不是读冻结的快照
ctx.shellEnv.register({
  name: 'env-manager-overlay',
  // ⚠️ 只能贡献 DSH_* 前缀的 key（见 11.6 的约束）
  variables: { DSH_SHELL_OVERLAY: { description: '...' } },
  resolve: () => ({ DSH_SHELL_OVERLAY: readLiveEnvStamp() }),
})
```

但 `DSH_*` 前缀的约束让它无法直接承载 `MY_VAR` 这种普通变量。要覆盖普通变量，需要宿主侧配合在构造子进程 spec 时把新鲜读到的值放进显式 `env`。**这一步需要确认 shell 工具是否暴露了可挂载的 env 覆盖点** —— 若没有，这就是我们必须自己实现的部分，也是本方案唯一需要"造轮子"的地方。

### 11.4 为什么凭据**不应**默认转发给 shell

`dsh-bash-local` 的组装是：

```js
env: {
  ...scrubbedParentEnv(),   // 已剔除 KEY/PASSWORD/SECRET/TOKEN 与 DSH_*
  ...spec.dshEnv,
}
```

DSH 的设计意图非常明确（注释原文）："**harness identity never leaks implicitly**"，"a deliberately forwarded credential ... goes through the spec's explicit `env`"。

也就是说：**密钥不进模型 shell 是刻意的安全设计**，不是遗漏。`DEEPSEEK_API_KEY` 在对话里能用（`dsh-llm-deepseek` 内部 `credentials.resolve` 拿），但在模型执行的 shell 里读不到 —— 这是正确的默认值。

**UI 设计结论**：不要试图"让密钥在 shell 里也能用"作为默认行为。正确做法是把这个区别**显式呈现出来**，让开发者理解：

| 标记 | 含义 | 实现 |
|---|---|---|
| 🟢 **shell 可见** | 会注入模型 shell 的 `DSH_*` | `ctx.shellEnv.register` |
| 🔒 **仅 DSH 内部** | DSH 组件能用，shell 读不到 | `ctx.credentials` |
| ⚪ **两者都不可见** | 只在 OS 环境里，连 DSH 都不用 | 仅作展示 |

如果确实要转发某个密钥给 shell，应当做成**逐变量的显式开关 + 安全警告**（"该密钥将对 agent 执行的任何命令可见"），而不是默认开启。

### 11.5 成本与代价（诚实清单）

| 做法 | 收益 | 代价 / 风险 |
|---|---|---|
| `shellEnv.register` 动态 resolve | 真热重载，零重启 | 只能贡献 `DSH_*` key；每次 shell 调用都要重算（读盘/读注册表，需缓存） |
| 我们自己写 `.env` → 值进 `process.env` | 无需重启即可被后续子进程看到 | ⚠️ **语义变更**：DSH 的原意是"继承环境优先，`.env` 只补空缺"（`if (process.env[name] === void 0)`），我们若让 `.env` 覆盖已有值，就**偏离了 DSH 自身的优先级契约**，且用户无法从 DSH 的行为推断出来 |
| 覆盖 OS 用户级变量进 spawn 环境 | Windows 上也能"改了就用" | 每次 shell 调用读注册表（性能）；必须明确标注"这与重启后的行为一致/不一致" |
| 把凭据转发给 shell | 密钥在 shell 里可用 | ❌ 绕过安全清洗；agent 能看到密钥 |
| 直接改 `process.env` | 第三方库也看得到 | ⚠️ 污染全局；影响所有子进程；与快照产生分歧；**建议不做** |

**最关键的风险是"热重载后的行为 ≠ 重启后的行为"**。如果 UI 让用户以为"改完立即生效"就等于"最终行为"，而两者不一致，那这个功能会制造出比手动重启更难排查的问题 —— 因为问题只在重启后才显现。

**设计对策**：热重载必须做到**与重启后语义一致**，否则就该诚实地标注"需重启"而不是硬凑热更新。具体而言，我们热注入的值应当**镜像 `loadLayeredEnv` 的规则**（继承环境优先，`.env` 只补空缺），而不是自己发明一套。

### 11.6 硬约束与实现细节

`ShellEnvRegistry.register` 的校验（来自实现）：

```js
if (!key.startsWith(DSH_ENV_PREFIX) || !BASH_ENV_KEY_SUFFIX.test(key.slice(DSH_ENV_PREFIX.length)))
  throw new Error(`bash env contributor "${contributor.name}" ...`)
if (RESERVED_BASH_ENV_KEYS.has(key))
  throw new Error(`bash env contributor "${contributor.name}" cannot own reserved key "${key}"`)

const RESERVED_BASH_ENV_KEYS = new Set([ DSH_HOME_ENV, DSH_SHELL_KEY, DSH_SESSION_ID_KEY ]);
```

即：

- ✅ 所有 key **必须** `DSH_` 前缀 + 合法后缀
- ❌ **不能**占用 `DSH_HOME` / `DSH_SHELL` / `DSH_SESSION_ID`（内置保留）
- ❌ 同一个 key **不能**被两个贡献者同时拥有（会抛错）
- ⚠️ 热重载时**必须走 `disposer()` → 重新 `register()`**，因为 disposer 里的 `keyOwners.delete(key)` 在"先 release 再 register"的顺序下不会误删新注册；反过来则会把自己的新注册删掉

好消息：`dsh-app-boot` **导出了** `loadLayeredEnv(binName, cwd, warn): LaunchEnvironmentSnapshot`。我们可以复用它来"模拟一次启动"，从而拿到与真实启动**完全一致**的分层结果 —— 不必自己重写 dotenv 分层逻辑，也就避免了"热重载语义与重启语义不一致"的最大风险。

（需注意：`loadLayeredEnv` 内部会写 `process.env`，且是幂等的 —— `if (process.env[name] === void 0)` —— 所以反复调用不会覆盖已有值，可以安全复用。）

### 11.7 推荐方案：按"能否保证与重启一致"分档

```
档 A｜真热重载（零重启，语义与重启一致）
  · 我们贡献的 DSH_* 变量        → shellEnv.register 动态 resolve
  · 凭据库（DSH 内部消费）        → 本来就热，UI 如实反映"立即生效"
  · settings 命名空间（非密钥）   → ctx.settings，本来就热

档 B｜可以热，但必须镜像 DSH 规则才安全
  · 项目 .env / 用户 .env         → 复用 loadLayeredEnv 重算 → 注入 spawn 显式 env
      前置条件：确认 shell 工具是否有可挂载的 env 覆盖点
      约束：遵守"继承环境优先"，不得让 .env 覆盖已有值

档 C｜诚实标注需重启（不要硬凑）
  · OS 用户级 / 系统级环境变量
  · 任何需要第三方库通过 process.env 读取的值
  · launchEnvironment 快照的读者（改不了，见 11.2）
```

**档 B 是本次问题的核心答案**：`.env` 的热生效**在技术上成立**，因为子进程环境每次 spawn 重建；但它成立的前提是**我们不去挑战 DSH 自己的优先级契约**。

如果复查后发现"镜像 DSH 规则"会导致热重载几乎看不出效果（因为继承环境几乎总是有值，`.env` 只补空缺），那就说明 **`.env` 这一层本来就不该热**，此时档 B 整体降级为档 C，UI 如实标注"下次启动生效"。这个判断必须基于实测，不能靠推测 —— 列为 P0 验证项。

### 11.8 不改 DSH 源码能否完成

**能。** 全部所需能力都在插件侧：

| 需求 | 可用能力 | 来源 |
|---|---|---|
| 贡献热重载变量 | `ctx.shellEnv.register` / `.list()` | `dsh-shell-env` |
| 复用启动期分层规则 | `loadLayeredEnv`（**已导出**） | `dsh-app-boot` |
| 读启动快照 | `launchEnvironmentOf(ctx)` | `dsh-launch-environment` |
| 密钥读写 | `ctx.credentials.resolve/set/unset/describe` | `dsh-credentials` |
| 持久化非密钥配置 | `ctx.settings` + `dsh-settings-file` | `dsh-settings` |
| HTTP 面 | `dsh-host-webserver` 具名路由 | `dsh-host-webserver` |
| 客户端页面 | `settings.plugins.tab` 槽位 | `dsh-client-ui-settings` |

唯一可能需要自己实现的是**普通变量注入 spawn 显式 env 的挂载点**（11.3 结尾）。这一点在 P0 必须确认；如果 shell 工具没有暴露覆盖点，则要么接受"普通变量需重启"，要么**改 DSH 源码加一个覆盖点** —— 那将是本方案唯一需要上游配合的地方。

---

## 12. P0 实测结果（2026-09-26）

P0 的目标是用实测回答两个决定性假设。结论如下 —— 其中一条**推翻了 §11.7 档 B 的可行性**。

### 12.1 挂载机制：实测确认，但有一个必须声明的 `inject`

**bundle 与 profile 的关系**（实测）：

- `dsh plugin --profile web add <path>` 把包装成 `link:` 依赖
- **但包必须在 `package.json` 声明 `dsh.bundle.patch`**，否则 CLI 只发一条警告并当作普通依赖：
  `warning: dsh-env-manager declares no dsh.bundle — installed as a plain dependency, not a profile layer`
- 声明后 CLI **自动把包名追加进 `profiles/web/package.json` 的 `dsh.profile.bundles`** —— 不需要手改 profile
- bundle patch 的每一行都应该是 `insert`，这样这一层只**追加**行，绝不覆盖/禁用 base 或 web-app 的行

**`inject` 不是可选项**（实测踩到的坑）：

第一次启动时插件的 `apply()` 跑得**早于** `dsh-shell-env` 就绪，日志为：

```
[env-manager] plugin loaded (pid=60212, uptime=4.3s, DSH_SHELL=1)
[env-manager] ctx.shellEnv unavailable — contributor NOT registered
```

原因在 `cordis/src/reflect.ts` 的 `_getImpl`：strict 模式下要求 `impl.fiber.state === ACTIVE`。修复方式是导出 `inject: ['shellEnv']`，让 cordis 推迟 `apply` 到依赖就绪。修复后：

```
[env-manager] contributor registered: DSH_ENV_MANAGER_LIVE (marker=...)
```

**结论**：任何要读取其他服务的 DSH 插件都必须声明 `inject`，否则会静默拿到 `undefined`。

### 12.2 假设 (a)：`shellEnv` 贡献变量热生效 —— ✅ **成立**

| 链路 | 证据 |
|---|---|
| 工具每调用收集 | `dsh-tool-pwsh:373` `dshEnv: ctx.shellEnv.collect(exec)` |
| 注册表每次重建并丢弃 ambient | `dsh-shell-env` 的 `collect()` 注释与实现 |
| 执行器按 spec 注入 spawn | `dsh-pwsh-local:261` → `:300` `env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }` |
| `resolve()` 每次调用重跑 | 实测：未提供标记文件时返回 `static-pid-<pid>` 回退值 |

**"档 A" 成立**：插件贡献的 `DSH_*` 变量**无需重启 DSH** 即可在下一次 shell 调用生效，且 `resolve()` 每次执行都重跑 —— 真热重载。

> ⚠️ **尚未端到端验证的最后一步**：以上证明了"值会被注入 spawn 环境"，但**没有**实际跑一次模型 shell 调用去读到它 —— 那需要在运行中的实例里重启以加载插件。这一步留给用户重启后确认。

### 12.3 假设 (b)：普通变量注入点 —— ❌ **档 B 不成立**

实测的三段事实：

1. **契约存在**：`ShellExecRequest` 有 `env?: Record<string, string>`
   > *Ordinary environment entries for the command, merged after the credential scrub. Managed facts belong in `dshEnv`, which merges after this*
2. **执行器完整支持**：`dsh-pwsh-local:260` / `dsh-bash-local:175` 都原样透传 `request.env`，并在 `spawnSpec` 里以 `ENV_OVERRIDES → spec.env → spec.dshEnv` 的顺序合并。注意 `spec.env` 在凭据清洗**之后**合并，所以它能带回被清洗的名字。
3. **但模型侧工具一个都不传**：`dsh-tool-pwsh`、`dsh-tool-bash` 构造请求时**只传 `dshEnv`**，从不设置 `env`。

因此**没有任何插件钩子**能往现有 `pwsh`/`bash` 工具的 spawn 环境里注入普通变量。唯一可行但有代价的路径：

- 写一个 `extends PwshLocalExecutor`（类已导出）并在 `resolve(request)` 里注入 `env`，**替换** `tool-pwsh` 那一行。
- 代价：`ctx.shell` 是 `ctx.provide` 的单例契约（`ReflectService.provide` 在已注册时会抛 `service "shell" has been registered at <fiber>`），所以必须**禁用**官方那一行才能装上自己的；而且必须与 `dsh-pwsh-sandbox`（同样是子类，`dsh-pwsh-sandbox:118` `SandboxPwshExecutor extends PwshLocalExecutor`，并在 `resolve` 里 `...super.resolve(request)`）协调继承链。
- **判断：为一个 UI 功能替换默认 shell 执行器，侵入性过高，不采用。**

**结论**：**档 B 降级为档 C** —— 普通变量（非 `DSH_*`）的改动**需要重启 DSH** 才能在模型 shell 中生效。UI 必须如实标注，不能假装热更新。

### 12.4 对设计的净影响

| 层 | P0 后的最终结论 |
|---|---|
| **F** 插件贡献的 `DSH_*` | ✅ 真热重载（档 A 成立） |
| **D** 凭据库（DSH 内部） | ✅ 立即生效（`credentials.resolve` 每请求调用） |
| **B/C** `.env` 文件 | ❌ **需重启**（档 B 不成立）—— 值虽在启动时进入 `process.env`，但没有任何合法注入点让它在运行中抵达模型 shell |
| **E** OS 用户级/系统级 | ❌ 需重启 |

> 一个仍然理论可行的例外：插件自己改写 `process.env`。因为 `scrubbedParentEnv()` 每次 spawn 都从 `process.env` 重建，这样做**确实**能让后续子进程看到新值。但它同时影响 DSH 自身的所有子进程、与冻结的启动快照产生分歧、且对敏感名依然无效。**建议不做**，除非将来证明 `.env` 重启成本不可接受。

### 12.5 P0 交付物

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `dsh.bundle.patch` + `dsh.client`（双面包） |
| `cordis.patch.yml` | bundle 层，只有 `insert`，不含覆盖 |
| `lib/index.js` | 宿主半边：声明 `inject: ['shellEnv']`，注册 `DSH_ENV_MANAGER_LIVE` 贡献者 |
| `lib/client.js` | 客户端半边：手写惰性 CJS 工厂，占据 `settings.plugins.tab` |
| `check-p0.mjs` | 22 项本地断言，**不需要启动 DSH** 即可验证两个半边 |
| `probe-parseenv.mjs` | §4.1 的 `.env` 解析语义证据 |

**关键工程结论**：客户端 bundle 是 `window.__ModuleLoader__.load({ id, factory })` 形式的惰性 CJS 工厂，**手写即可，整个 P0 不需要任何打包器**。这让开发循环可以只有"改文件 → 重启"两步。

---

## 13. P1 进展：复合环境模型（2026-09-26）

P0 的端到端验证被"需要重启用户实例"卡住，因此并行推进 P1 的地基 ——
把 §6.2 的"复合变量"抽象从文档变成可运行的代码。

### 13.1 新增模块 `lib/env-model.mjs`

| 导出 | 作用 |
|---|---|
| `parseDotEnv(content)` | `.env` 解析器，语义对齐 `node:util.parseEnv` |
| `serializeDotEnvLine(key, value)` | `.env` 序列化器，含引号策略与有损检测 |
| `representabilityOf(line)` | 查询某行是否**有损**或**歧义** |
| `isBootstrapOnly(name)` | 禁止名单判定（精确名单 + 前缀，大小写不敏感） |
| `resolveDshHome(env)` | home 解析：显式 > `$DSH_HOME` > `~/.dsh`，空白视为未设置 |
| `buildEnvironmentModel(opts)` | **UI 的唯一数据来源**：逐层取值 + 生效层 + 逐层可写性 |
| `describeVariable(v)` | 单行诊断摘要 |

### 13.2 验证结果：136 项断言全过（`verify-env-model.mjs`）

关键的是**差分测试**，而不是我自己写的期望值：

- **38 例 `.env` 差分测试**：同一批输入分别喂给 `parseDotEnv` 与
  `node:util.parseEnv`，断言输出**逐位相同**。这是唯一能保证"UI 显示的东西
  与 DSH 真正读到的完全一致"的手段。
- **往返测试**：对 18 个刁钻值验证"写出的行能读回原值"，且覆盖
  `parseEnv` 与 `loadEnvFile` 两条路径。
- **合成层测试 21 项**：本机两个 `.env` 都不存在，所以真实快照证明不了遮蔽逻辑；
  构造临时 project + home 目录，同时喂三层，断言生效层、层序、逐层可写性、
  代理变量的 home 层例外、`DSH_*` 被拒。

### 13.3 这一轮实测推翻的三个假设

差分测试的价值在这一次体现得很直接 —— 我按文档和直觉写的解析器有 **5 处与
Node 真实行为不符**：

| 我原本以为 | 实测真相 |
|---|---|
| `#` 需要前导空格才截断 | `#` 在引号外**无条件**截断（`K=a#b` → `a`） |
| 双引号支持 `\t` `\\` `\"` 转义 | **只有 `\n`** 是转义，其余全部保留字面 |
| 反斜杠能转义引号 | **不能**：`"a\"b"` → `a\`（首个引号即收尾） |
| 键的包裹引号会被去掉 | **不去**：`"K"=v` 的键就是 `"K"` |
| 含单引号的值无法表示 | ✅ 可以，双引号内单引号是字面量 |

另外修掉两个自己写出的 bug：多行未闭合引号分支的**无限递归**
（用 `value + '\n' + rest` 递归但输入没变短），以及序列化器**忘了把 key 拼进去**。

### 13.4 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| P0 端到端验证（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里） | 需要重启 3080 实例（PID 59800） |
| 浏览器页签目视确认 | 同上；且需要人眼看 Settings → Plugins |
| P3 凭据域接入 | 未开始 |
| OS 用户级层（Windows 注册表） | 未开始 |

---

## 14. P2 进展：`.env` 写入层（2026-09-26）

新增 `lib/env-write.mjs`，把 §6.4 里那个"**必须自己处理**"的危险落地：
settings 的 revision 栅栏只保护 settings 文档，而我们写的是磁盘文件，
**没有任何现成的保护**。

### 14.1 三条不可妥协的规则

| 规则 | 实现 | 违反的后果 |
|---|---|---|
| **绝不静默写坏用户的值** | 写入前跑 `validateEdit`，值的可表示性不通过就整批拒绝 | 用户的值悄悄变了形，很久以后才以奇怪方式爆掉 |
| **绝不覆盖并发修改** | `revision`（sha256+size）作为 `expectedRevision` 栅栏 | 另一个程序刚写的改动被无声抹掉 |
| **绝不破坏用户文件** | 只改目标键；注释/空行/键序/行尾风格逐字节保留 | 用户的 `.env` 被重排、注释丢失 |

### 14.2 片段模型：为什么必须逐字节保留

把 `.env` 拆成"每行带自己的行尾"的片段数组，未触及的行**原样拼回**。
这样 `join(split(x)) === x` 天然成立，包括末尾空行、混合行尾、无末尾换行。

`verify-env-write.mjs` 里有一条断言直接证明这一点：

```
PASS  only the target line changed — ["BETA=\"changed\"\n"]
```

即一次编辑后，与原文的逐行 diff **只有一行**。

### 14.3 原子性与批量语义

写入是**整文件原子替换**：同目录临时文件 + `rename`。由此得到两个性质：

- **批量原子**：一次多键编辑要么全生效要么全不生效 —— `rename` 本身不会中途失败
- **不留垃圾**：`finally` 里清理临时文件；有专门的测试断言反复写 5 次后目录里只剩 `.env`

Windows 上 `rename` 可能因文件被短暂占用（杀软、编辑器、另一读取者）而失败，
所以带 `EPERM`/`EACCES`/`EBUSY` 重试；**其他错误直接抛出**，不掩盖真实故障。

### 14.4 权限

新建/改写后 POSIX 一律 `0600`。`.env` 可能含密钥，新建时绝不留默认权限窗口。

`checkPermissions()` 在 Windows 上返回 `checked: false`，理由是
`dsh-credentials-local` 自己就跳过了这项检查（"Windows has no mode to inspect,
so the check is skipped there rather than faked"）—— **我们也不假装通过**。

### 14.5 验证：90 项断言

| 组 | 覆盖 |
|---|---|
| 结构保留 | 注释、空行数、片段数、键序、末尾换行、CRLF、逐行 diff 只有一行 |
| 追加/删除 | 新键追加到末尾；删除不留空行痕迹；CRLF 文件里新增行也用 CRLF |
| 新建 | 嵌套目录、末尾换行 |
| **CAS** | 用陈旧 revision 写入被拒、外部改动**未被覆盖**、用新 revision 重试成功且保住外部键 |
| 禁止名单 | `DSH_HOME`/`PATH`/`XDG_*`/小写 `dsh_*` 被拒；代理变量项目层拒、home 层放行；一批里有一个非法则**整批不写入** |
| 有损值 | 同时含两种引号的值被拒，且文件**逐字节未变** |
| 值保真 | 14 个刁钻值穿过真实文件往返（含 `#`、两种引号、换行、反斜杠、`$`、`${}`、Unicode、前后空格、`=`、`:`） |
| 原子性 | 失败不留半截文件、不留临时文件 |
| split/join | 18 例恒等，含 `\r\n\r\n`、`\n\n\n`、混合行尾、无末尾换行、纯空白 |

### 14.6 这一轮实测/测试抓到的问题

| 问题 | 性质 | 根因 |
|---|---|---|
| **末尾空行被吃掉** | 真实 bug | `split('\n')` 对 `"A\n\n"` 只产出 2 个元素，`pop()` 一次就把用户的空行删了 |
| 正则空分支零宽匹配 | 真实 bug | `g` 标志下带空分支的模式在零宽匹配时 `lastIndex` 推进不可靠，产出假行 |
| 断言"含单引号的值有损" | 我的假设错 | 实测 `K="with 'single'"` 完美往返 |
| 空行数断言连错三次 | 我的测试写错 | 把"空行数"与"`split` 产出的空元素数"混为一谈 |

**方法论教训**：那条空行断言我先猜 3、再猜 2、再猜 3，三次都错。
最后改成**对照写入前的计数**——断言"写入不改变结构"这个真正的不变式，
而不是一个我手算的数字。凡是可以写成相对断言的，就不该写绝对值。

### 14.7 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| P0 端到端验证 | 需要重启 3080 实例（PID 59800） |
| 浏览器页签目视确认 | 同上 |
| P3 凭据域接入 | 未开始 |
| P4 客户端页签渲染真实模型 | 依赖 P0 验证通过 |
| P5 OS 用户级层 | 未开始 |

---

## 15. P3 进展：凭据域接入（2026-09-26）

新增 `lib/credentials.mjs`（`CredentialAccess`），围绕 `ctx.credentials` 的薄封装。
52 项断言，重点全在"**哪些东西没有被传出去**"。

### 15.1 只调用 `describe`，从不调用 `resolve`

`dsh-credentials` 的契约刻意让 `describe()` 的返回类型"没有可以搭载值的位置"，
所以本模块**只调用 `describe`**，整个文件没有一处返回值本身。
`resolve()` 一次都没被调用 —— 这一点由测试用记录调用的假 provider 断言：

```
PASS  describe never calls resolve
PASS  view does not contain the secret anywhere
PASS  set never calls resolve
PASS  post-set view has no value
```

### 15.2 遮蔽：把"拒绝"翻译成可行动的下一步

契约原文解释了为什么 `set()` 必须拒绝遮蔽情形：

> Rejects while a read-only source shadows the reference — **the write would
> appear to succeed while resolution keeps returning the shadowing value**.

这是正确行为：否则用户以为换了 key，实际没换。所以适配层做**双路径**处理：

1. **前置判断**：写入前先 `describe`，已配置且不可写就直接抛 `CredentialShadowed`，
   连 provider 都不碰（测试断言 `pre-check prevented the provider call`）。
2. **拒绝捕获**：provider 仍可能因两次调用之间的状态变化而拒绝
   （另一进程改了文件、watcher 刚观察到外部编辑）。捕获后**重新 `describe`**
   来判断是不是遮蔽，而不是把原始错误直接抛给用户。

两条路径都产出同一条可行动文案：

```
"X" 由「启动环境（继承自父进程）」提供，凭据库无法覆盖它。
请先在那一层修改，或移除它之后再写入凭据库。
```

### 15.3 拒绝要分类，不能一律叫"失败"

| 情形 | 异常 | 用户体验 |
|---|---|---|
| 名字被只读来源遮蔽 | `CredentialShadowed` | 说明是谁遮蔽的 + 下一步怎么做 |
| 值为空 | `CredentialRejected('empty-value')` | 提示"要移除请用删除操作"（凭据域把空值视为未设置）|
| 名字不是合法引用 | `CredentialRejected('invalid-ref')` | 说明命名规则 |
| 存储本身失败 | `CredentialRejected('set-failed')` | 保留 provider 的原始信息 |

测试专门断言"一般性失败不会被误报成遮蔽"（`generic failure is not misreported as shadowing`）。

### 15.4 一个反直觉的实测结论：cordis 拒绝访问未声明的服务

我原本把凭据探测写成"运行时探测"（不放进 `inject`，拿到就用、拿不到就降级），
理由是不想让整个插件因缺服务而加载失败。**这条路走不通**：

```
[env-manager] credential probe failed: cannot get property "credentials" without inject
```

cordis 对**未在插件 `inject` 里声明**的服务**直接抛错**，而不是返回 `undefined`。
所以任何想读的服务都必须声明 —— "晚一点再试试"这个思路在 cordis 里不成立。

修正后把 `credentials` 加进 `inject`，实测通过：

```
[env-manager] credentials service available (1 stored record(s): {"grant":1})
```

它读到了真实 `.credentials.yaml` 的**种类与数量**（不含值）。

### 15.5 引用名语法内联而非 import

`dsh-credentials` 的 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/` 被内联进
`credentials.mjs`，不 import 那个运行时导出 —— 本包并不声明 `dsh-credentials`
为依赖（由 profile 提供）。测试断言它与 `env-write.mjs` 的环境变量名规则
在 10 个样本上完全一致，避免两处正则各自漂移。

---

## 16. P4 进展：宿主 HTTP 面与客户端页签（2026-09-26）

新增 `lib/host-api.mjs`（2 条路由）并把客户端页签从静态文案改成**真实渲染**。
53 项断言。

### 16.1 三条传输约束

| 约束 | 实现 | 理由 |
|---|---|---|
| **不原样回传整个环境** | 长值摘要化为 `{preview, length, truncated}` | `PATH` 一项就能撑出几 KB，信息量在结构不在全文 |
| **敏感名不回值** | 只回 `valueLength`，连摘要都不给 | 摘要里就是真实值的前 60 字符 |
| **错误要能到达客户端** | 处理器自己捕获并回结构化错误 | webserver 把抛出的异常变成**空的** 400，UI 会失去原因 |

第二条是被测试抓出来的真实漏洞：先前版本给敏感变量标了 `redacted: true`，
却**仍然附带 `valueSummary`** —— 等于把密钥送到浏览器。断言
`projected state NEVER contains the secret value` 当场失败，修掉后才通过。

### 16.2 一个隐蔽的 bug：`this` 在注册时丢失

第一版把处理器写成 `handler: this.state`。webserver 以**裸函数**形式调用它，
于是 `this` 不再指向 api 对象，处理器抛错 → webserver 回一个**空的 400**。
症状是"路由像是完全没注册"，而日志里没有任何线索。

实测证据（同一段代码，修复前后）：

```
修复前： GET /api/env-manager/health  ->  400 （空响应体）
修复后： GET /api/env-manager/health  ->  200 {"ok":true,"pid":21344,...}
```

修法是注册前显式 `.bind(this)`。**已写进代码注释**，因为这类失败极难从症状反推。

### 16.3 用 `ctx.inject` 处理激活顺序

路由注册包在 `ctx.inject(['webServer'], cb)` 里，而不是在 `apply` 里直接读
`ctx.webServer`。`webServer` 与本插件行的激活顺序不保证，直接读会拿到
`undefined` —— P0 已经在 `shellEnv` 上踩过同一个坑。

释放用 `scope.effect()` 包住两条路由的 disposer，测试断言 disposer 真的
把两条路由都反注册掉。

### 16.4 宿主的实际输出（隔离实例实测）

```
GET /api/env-manager/health
-> 200 {"ok":true,"pid":21344,"uptimeSeconds":56,
        "routes":["/api/env-manager/state","/api/env-manager/health"]}

GET /api/env-manager/state
-> 200  32006 bytes
   counts = {"total":101,"shadowed":0,"forbidden":11,"sensitive":0,"runtimeManaged":4}
```

**这一轮最重要的验证**：客户端 bundle 真的被 `dsh-client-modules` 接受了。
认证后取 index，应用组合 URL 里赫然有我们这一项，夹在第一方插件之间：

```
.../dsh-client-ui-deliverables/client.js, dsh-env-manager/client.js, /dsh-typert-registry/client.js...
```

拉取该组合脚本（11 MB，53 个插件），确认我们的 bundle 内容在里面：

```
PASS  combo contains our bundle registration
PASS  combo contains our tab label (环境变量)
PASS  combo contains our fetch target (/api/env-manager/state)
```

这是在不重启用户实例的前提下能取得的最强证据：**数据面（宿主路由）与
代码面（客户端 bundle）都在真实 DSH 里跑通了**，只剩"人眼看一眼页签"。

### 16.5 一次回退：`blockedReason` 改成 `blockedCode`

最初每个层条目都带一句中文 `blockedReason`。实测 `reveal=0` 响应 **27.8 KB** ——
`process` 层每个变量都重复同一句话。改成机器可读的 `blockedCode`，
文案表 `blockedReasonText` 在响应里只传一次。这是更正确的传输契约
（文案本地化本来就是客户端的事），体积降到 24.5 KB。

**但要诚实说明：剩余体积的主因不是文案**，而是字段结构 —— 101 项 × ~240 字节，
每项带 `shadowed`/`forbidden`/`sensitive`/`runtimeManaged`/`layerCount` 等标志。
localhost 上 24 KB 可接受，故列为**已知优化项而非缺陷**：真要做可以加
`?view=names` 只回名字列表，详情改按需单取。

### 16.6 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| P0 端到端验证（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| 需要重启 3080 实例（PID 59800）|
| 浏览器页签目视确认 | 同上；代码面已证明被加载，只剩渲染效果 |
| P5 OS 用户级层（Windows 注册表）| 未开始 |
| 写入路径接入 UI（P2 的后端已就绪，尚未暴露写路由）| 未开始 |

---

## 17. P5 进展：Windows 注册表层（2026-09-26）

新增 `lib/registry.mjs`（`OsEnvironmentLayer`）并接入宿主 API，**四个层到此全部就位**。
65 项断言（50 项单元 + 15 项**真实注册表往返**）。

### 17.1 三条必须在 UI 里讲清楚的事实

| 事实 | 依据 | UI 后果 |
|---|---|---|
| Windows 上权威**只有注册表**，没有 profile 文件层 | PowerShell profile 只对 PowerShell 生效，不是 OS 环境 | 不要给 Windows 显示"shell profile"这一层 |
| **重启前不改变生效值** | 注册表值在启动时已被继承进 `process` 层，而 `process` 优先级更高 | 必须显示"注册表说 X，进程说 Y（生效）" |
| **PATH 是唯一合并的变量**（系统在前） | 实测两层都存在 `Path`；`mergePath` 按系统→用户拼接 | 必须标明改的是哪一份，否则"改了没用"无法排查 |

第二、三条正是设计文档 §6.2 那个"遮蔽展示"最有价值的场景。

### 17.2 实测的两个关键结论

**① `reg query` 接受缩写根，但输出用全名。** 这是本轮最难定位的 bug：

```
输入：reg query HKCU\Environment
输出：HKEY_CURRENT_USER\Environment      ← 全名！
```

我的 scope 判断用 `HKCU` 去比对 `HKEY_CURRENT_USER`，永远不匹配，症状是
**"解析出 0 个值"** —— 而不是报错，极具误导性。修法是 `normalizeKeyPath()`
把两种形式统一，并断言"子键块的值必须被排除"。

**② `reg.exe add` 不广播 `WM_SETTINGCHANGE`。** 设计文档 §2.1 原本写"写后需广播"，
实测确认 `reg.exe` 自己不做这件事。所以 UI 文案必须是"需重启 DSH / 重新登录"，
不能承诺"新开的程序立刻能看到"。

### 17.3 真实注册表往返（15 项，含无条件清理）

假执行器只能证明命令行拼对了，证明不了 `reg.exe` 真的接受它。所以做了一次**真实写入**，
用自建变量名 `DSH_ENV_MANAGER_RTT_<pid>`，`finally` 块无条件清理：

```
PASS  REG_SZ write reports success — {"ok":true,"type":"REG_SZ"}
PASS  independent readback matches — "rtt-plain-value"
PASS  type is preserved as REG_EXPAND_SZ — REG_EXPAND_SZ
PASS  the %VAR% text survives unexpanded in the registry — "%USERPROFILE%\\rtt-bin"
PASS  raw query confirms REG_EXPAND_SZ on disk — ... REG_EXPAND_SZ    %USERPROFILE%\rtt-bin
PASS  value is gone from the registry
PASS  no residue left in HKCU\Environment
```

**类型保留是这一层最重要的正确性要求**：`REG_EXPAND_SZ` 的值含 `%VAR%` 引用，
由 Windows 在进程启动时展开；写回 `REG_SZ` 会让 `%USERPROFILE%` 变成字面量。
实测确认类型与原文都被完整保留。

### 17.4 合并进复合模型后的实际效果

真实实例上 `Path` 现在有**三层竞争**，且生效层判定正确：

```json
{"name":"Path","effective":"process","shadowed":true,"layerCount":3,
 "layers":[
   {"layer":"process","writable":false,"blockedCode":"process-inherited",
    "valueSummary":{"preview":"C:\\Users\\qq651\\…","length":1834,"truncated":true}},
   {"layer":"os-user","writable":true,"registryType":"REG_EXPAND_SZ"},
   {"layer":"os-machine","writable":true,"registryType":"REG_EXPAND_SZ","requiresElevation":true}]}
```

1,834 字符的进程 PATH 被摘要化（这正是 §16.1 那条"不回传整个环境"的约束在起作用），
而注册表两层各带自己的类型与提权标记。

### 17.5 两个诚实的边界

| 边界 | 处理 |
|---|---|
| **Linux / macOS 不支持** | `supported === false`，读写都**明确拒绝**而不是假装成功。理由写在设计文档 §2.2/§2.3：macOS GUI 应用读 launchd 而非 shell profile，`launchctl setenv` 不持久；Linux 的 `environment.d` 只影响 systemd 用户会话 |
| **`reg.exe` 输出是控制台代码页** | 用 `TextDecoder('utf-8', {fatal:false})` 宽松解码：不抛错，ASCII 部分（变量名与类型名）完全正确，非 ASCII 的**值**可能带替换字符。已写进注释，**不假装精确** |

### 17.6 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| P0 端到端验证 | 需要重启 3080 实例（PID 59800）|
| 浏览器页签目视确认 | 同上；客户端已在渲染四层 |
| 注册表写路由接入 UI（`OsEnvironmentLayer.write/remove` 已就绪并实测）| 未开始 |
| `.env` 写路由接入 UI（P2 后端已就绪）| 未开始 |

---

## 18. P6 进展：写路由与写 UI（2026-09-26）

新增 `lib/write-routes.mjs`，并把编辑能力接进客户端页签 —— 四层从"能看"变成"能管"。
67 项单元断言 + 一次**真实 HTTP 端到端实测**。

### 18.1 最大的风险是路径注入，所以路径根本不接受

一个签了名的 HTTP 端点能写磁盘文件、能改注册表 —— 这是全插件爆炸半径最大的地方。
所以请求里给的是**层标识**（`project-env` / `user-env`），路径由宿主自己推导；
请求里若带 `path`，必须与推导结果**完全一致**，否则拒绝。没有这条，任何能访问
该端点的人都能覆盖任意文件。

端到端实测的拒绝消息（真实 HTTP 响应）：

```json
{"ok":false,"error":"write-failed",
 "message":"拒绝写入：请求声明的路径 \"C:\\Windows\\Temp\\evil.env\" 与 project-env 层推导出的路径 \"E:\\opensource-work\\dsh-environment-tray\\.env\" 不一致。本端点只接受层标识，不接受任意路径"}
```

### 18.2 三条写路径的完整实测结果

全部在隔离实例上通过**真实 HTTP** 完成：

| # | 操作 | 结果 |
|---|---|---|
| 3 | `env/read`（项目层不存在） | `{"exists":false,"revision":"absent"}` |
| 4 | `env` 写入新变量 | `{"ok":true,"revision":"sha256:7fd59f15bf1f28f0:33"}` |
| 5 | **磁盘上的文件** | `E2E_PROBE_VAR="written-via-http"` |
| 6 | state 读回 | `effective=project-env` —— 完整闭环 |
| 7 | 用陈旧 revision 重写 | **409** + 消息列出两个 revision |
| 8 | 批中含 `DSH_HOME` | **400**，整批拒绝，并给出"改为导出 DSH_HOME"的补救建议 |
| 9 | 路径注入 | 拒绝（见 18.1）|
| 10 | 注册表 `REG_EXPAND_SZ` 写入 | `reg.exe` 独立读回 `%USERPROFILE%\e2e-bin`，类型保持；删除后**无残留** |

第 7 条值得单独说：CAS 冲突回 **409**（可重试），校验失败回 **400**（不可重试），
凭据被遮蔽回 **409**（需要用户先去改那一层）。状态码本身携带了"下一步该做什么"。

### 18.3 测试抓到的真实 bug：响应链没有被 await

`respond()` 启动了 promise 链却**没有返回它**，而处理器是 `async` 的。
于是 `await routes.env(req, res)` 在响应真正写出**之前**就 resolve 了 ——
调用方读到 `undefined` 的 status/body。

这个 bug 在测试里的表现是"6 项断言说路由没反应"，看起来像测试替身的问题
（我也确实先怀疑了自己的假请求，并单独写了探针证明 `readJsonBody` 正常）。
根因是**实现的异步语义不完整**：`respond` 必须返回链条并让处理器 `await` 它。

HTTP 语义上这个 bug 更严重：**真实请求会挂住**而不是返回。所以端到端实测
能返回 200 本身就是这条修复的证据。

顺带修掉一个**掩盖问题的测试写法**：断言里用了 `json?.field`，在响应未写出时
静默返回 undefined，把时序 bug 伪装成"值不对"。现在改成缺 body 就直接抛。

### 18.4 客户端写入的并发契约

`.env` 的保存走**读取 revision → 带栅栏写入**两步，而不是直接写：

```
1. POST /env/read  → 拿当前 revision
2. POST /env       → 带 expectedRevision 写入
```

若两步之间文件被其他程序改动，写入被拒而不是覆盖对方的改动。UI 文案里明确
写了这一点，因为"保存失败"若不说清原因，用户会以为功能坏了。

注册表写入**沿用已有类型**（`type: layer.registryType ?? 'REG_SZ'`），
避免把 `REG_EXPAND_SZ` 降级成 `REG_SZ` 从而破坏 `%VAR%` 引用。

### 18.5 写 UI 的边界

| 情况 | UI 行为 |
|---|---|
| 层可写且我们有写路由 | 显示「编辑」按钮 |
| 层不可写（`process` 层、禁止名单）| 不显示按钮，展开各层时说明原因 |
| 密钥 | 草稿从**空**开始（宿主不回传值），用户必须重输 |
| 保存成功 | 提示 + 标注生效时机（🔄 需重启 / 🟢 立即）|
| 保存失败 | 逐条展示 `problems`（禁止名单、有损值等）|

### 18.6 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上；客户端 bundle、路由、写入面均已实测，只剩渲染效果 |
| 密钥写入的 UI 入口 | 后端 `/credentials` 已就绪并实测，UI 尚未接 |

---

## 19. P7 进展：密钥 UI 入口（2026-09-26）

新增密钥状态路由 `GET /api/env-manager/credential-state` 与客户端密钥面板。
**目标里"③ 密钥"到此在 UI 上闭环**，四层全部可看可管。88 项断言（宿主）+ 端到端实测。

### 19.1 密钥 UI 的硬约束：草稿从空开始

宿主**永远不回传密钥值**，所以输入框从**空**开始，用户必须重输。这不是保守的
UI 选择，而是 `dsh-credentials` 的契约（`describe()` 的返回类型"没有可以搭载值的
位置"）。**任何"显示已存密钥"的界面都必然违反该契约。**

于是界面只能表达三件事：已配置 / 未配置 / 被遮蔽（附原因）。

### 19.2 为什么密钥状态单独一条路由

不把密钥塞进主 `state` 响应，有两个理由：

1. 主 `state` 是**环境变量**的视图，密钥是**另一个键空间**（`CredentialRef` vs
   `CredentialKey`，契约明确说两者语法不相交）；混在一起语义含糊。
2. 客户端知道自己关心哪些名字（从 state 里筛出凭据形状的），按需查询即可，
   不必让每个 state 请求都多付一轮凭据读取。

响应里只有 `{ configured, writable, source, sourceLabel, editable, blockedReason }` ——
**没有可以搭载值的位置**，测试直接断言 `NO VALUE FIELD ANYWHERE`。

### 19.3 端到端实测：遮蔽翻译在真实 HTTP 上生效

这是本轮最有价值的证据。真实环境里 `SSL_CERT_FILE` 恰好同时是
`KEY` 形状、命中禁止名单、且被启动环境遮蔽 —— 一条请求就把完整的可行动诊断拿出来了：

```json
{"available":true,"refs":{
  "SSL_CERT_FILE":{"configured":true,"writable":false,"source":"env",
    "sourceLabel":"启动环境（继承自父进程）","editable":false,
    "blockedReason":"已由「启动环境（继承自父进程）」提供，凭据库无法覆盖。要改这个值，需要修改启动环境（导出该变量）后重启 DSH。"},
  "DEEPSEEK_API_KEY":{"configured":false,"writable":true,"editable":true}}}
```

这正是 `dsh-credentials` 契约里那条拒绝规则的用意：

> Rejects while a read-only source shadows the reference — the write would
> **appear to succeed** while resolution keeps returning the shadowing value.

### 19.4 写入与删除的泄露检查

```
POST /credentials {"ref":"MY_FAKE_SECRET","value":"sk-e2e-should-never-appear"}
-> {"ok":true,"view":{"configured":true,"source":"file",...}}
   响应含密钥: False          ← 关键断言

GET /credential-state?refs=MY_FAKE_SECRET
-> {"configured":true,"source":"file"}
   响应含密钥: False

POST /credentials {"ref":"MY_FAKE_SECRET","unset":true}
-> {"configured":false}
   隔离 home 的 .credentials.yaml 含密钥: False   ← 真的删掉了
```

### 19.5 隔离验证没有污染真实环境

每轮端到端都在独立 `DSH_HOME` 上跑，收尾时逐项确认：

| 检查 | 结果 |
|---|---|
| 探针 home 已删除 | ✅ |
| 3180 端口无监听 | ✅ |
| 注册表无残留（`HKCU\Environment` 里无 `DSH_ENV_MANAGER*`）| ✅ |
| **真实 `~/.dsh/.credentials.yaml` 未被写入探针密钥** | ✅ |

### 19.6 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 20. P8 进展：大小写不敏感键匹配的修复（2026-09-26）

这一轮没有加新功能，而是回头审计**已写代码里风险最高的一处遗漏**。
结果找到一个真实的静默数据故障。

### 20.1 故障：`.env` 写路径漏了 Windows 的大小写语义

`applyEditsToSegments` 用 `pending.get(seg.key)` 匹配已有键 —— **大小写敏感**。
而本设计文档 §1.1 自己就写着"Windows 上环境名大小写不敏感"，
`buildEnvironmentModel` 与 `mergeOsLayers` 都做了折叠，**只有写路径漏了**。

两个具体后果（回归测试实测输出）：

```
FAIL  Windows: only ONE line for a case-variant key
      ["MyVar=\"original\"","MYVAR=\"replaced\""]        ← 同一变量两行
FAIL  Windows: value was actually replaced
      {"MyVar":"original","OTHER":"x","MYVAR":"replaced"}
FAIL  Windows: unset matches a case variant
      "MyVar=\"a\"\nKEEP=\"k\"\n"                        ← unset 没删掉
```

第三条最严重：**用户在 UI 上删一个变量，它还在，而且界面显示成功**。
这正是本设计最想避免的那类故障 —— 静默、看起来成功、结果不对。

### 20.2 修复与保持的语义

引入 `editKey(name)`（win32 折叠大写，其余平台不动），与
`lookupKey`/`fold` 用同一套平台语义。修复后：

```
PASS  Windows: only ONE line for a case-variant key — ["MyVar=\"replaced\""]
PASS  Windows: the original casing is preserved — "MyVar=\"replaced\"\nOTHER=\"x\"\n"
PASS  Windows: unset matches a case variant — "KEEP=\"k\"\n"
```

**注意保留了原有拼写**：写 `MYVAR=replaced` 时命中的是文件里的 `MyVar` 行，
只换值不改名。用户的文件不会因为我们编辑而被静默重命名。

### 20.3 顺带确认的一条不变式

折叠后的 `pending` Map 天然让**同一批里的重复编辑只生效最后一条**：

```
PASS  duplicate edits produce exactly one line — "A=\"second\"\n"
```

这不是刻意设计出来的，是修 20.1 时顺带获得的性质 —— 但它值得一条断言守住。

### 20.4 两个测试自伤，值得记下来

写这个回归测试时我连续踩了两个坑，都不是产品代码的问题：

| 现象 | 根因 |
|---|---|
| `ENOENT ... case\.env` | `writeFileSync` 不建目录（`applyEnvEdits` 会，测试绕过了它）|
| `EnvEditRejected: "PATH" 只能由启动环境提供` | 我用 `Path`/`PATH` 做样本，但 `isBootstrapOnly` **折叠大小写**，所以 `Path` 也命中禁止名单 |

第二点其实是个好消息：它证明**禁止名单本身已经是大小写不敏感的** ——
用户写 `path=` 或 `Dsh_Home=` 都会被挡住。测试改用 `MyVar`/`MYVAR` 后正常。

### 20.5 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 21. P9 进展：请求鉴权缺口的发现与修复（2026-09-26）

这一轮没有加功能，而是继续审计 —— 结果找到一个**安全缺口**，
其严重程度高于此前所有问题。

### 21.1 缺口：我的路由完全绕过了 DSH 的鉴权

`dsh-host-webserver` 的 README 早就写明了这件事，是我先前读漏了：

> The server carries **no TLS, authentication, or origin policy of its own** —
> route owners such as `dsh-client-connection` enforce their own request policy.
> **Binding a non-loopback address still exposes unprotected routes.**

`dsh-client-connection` 为**它自己注册的**路由做了鉴权（Host/Origin 围栏 +
浏览器会话认证），而我把路由**直接注册在 webserver 上**，因此那道闸门对我无效。

### 21.2 实测证据（修复前）

对照实验 —— 同一实例、同样无 cookie：

```
第一方 /api/gateway              -> 401   ✅ 有鉴权
我的 /api/env-manager/state      -> 200   ❌ 无鉴权

攻击：POST /api/env-manager/env
      Sec-Fetch-Site: cross-site
      Origin: https://evil.example
-> 200 {"ok":true,...,"keys":["PWNED_BY_CROSS_SITE"]}
   磁盘：PWNED_BY_CROSS_SITE="yes"
```

**本机任何页面**只要 `fetch('http://127.0.0.1:3180/api/env-manager/env', {mode:'no-cors', ...})`
就能往 `.env` 写任意内容 —— 典型的 confused-deputy。而 `dsh-client-connection` 的源码
注释说明这类绕过的后果正是它存在的理由：DNS rebinding 与恶意页面的跨站请求。

### 21.3 修复：复用 DSH 自己的权威策略，而不是自研

新增 `createRequestGuard()`，直接调用 **`connection.requestRejection(request)`** ——
这是 `dsh-client-connection` 的公开方法，正是第一方 `/api` 用的那一个。

**为什么不自研**：一套自写的 Host/Origin/认证策略迟早会与上游漂移，而漂移的方向
通常是"悄悄变松"。复用它意味着第一方收紧时我们自动跟随。

闸门按返回值区分状态码：`403`（Host/Origin 围栏失败）与 `401`（未通过会话认证）。

**失败关闭**：拿不到 `connection` 时回 `503` 并说明原因，**绝不静默放行**。
`connection` 也已加入插件 `inject`，保证路由注册时闸门一定可用。

### 21.4 修复后的双向验证

**攻击面全部被封**：

| 攻击 | 修复前 | 修复后 |
|---|---|---|
| 跨站写 + 外部 `Origin` | 200 + **落盘** | **403**，未落盘 |
| 跨站读 `/state` | 200 | 403 |
| 无 cookie 裸请求 | 200 | **401**（与第一方一致）|
| `Host: attacker.example`（DNS rebinding 形状）| 200 | 403 |

**合法路径未受影响**（这一半同样重要 —— 修安全不能把功能修坏）：

| 操作 | 结果 |
|---|---|
| 用 `?token=` 换取会话 cookie | `dsh-auth-*` HttpOnly cookie 签发成功 |
| 带 cookie 读 `/state` | **200**，108 个变量、27 项遮蔽、OS 层正常 |
| 带 cookie 写 `.env` | **200**，`LEGIT_AUTHED_WRITE="ok"` 落盘 |
| 带 cookie 读密钥状态 | **200** |

读路由与写路由**共用同一道闸门**：`/state` 会回传完整环境结构（含敏感名与长度），
`/credential-status` 会回传密钥存在性，都不该让跨站页面读到。

### 21.5 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 22. P10 进展：UTF-8 BOM 导致的不可见变量名（2026-09-26）

继续审计数据保真度，找到一个**只在 Windows 上出现、且完全静默**的缺陷。

### 22.1 缺陷：BOM 会粘进第一个变量名

Windows 的记事本等工具常给文本文件加 UTF-8 BOM（`EF BB BF`）。
`readFileSync(p, 'utf8')` **不**剥离它，而 `node:util.parseEnv` 也不剥离 ——
于是第一个变量名变成 `\uFEFFFIRST`。实测码点：

```
parseEnv key codepoints: feff 46 49 52 53 54     ← 带 BOM
我的 key codepoints    : 46 49 52 53 54          ← 不带
keys identical?        : false
```

后果：**DSH 读到的变量名与界面显示的不是同一个**。BOM 没有字形，所以界面上
看起来就是 `FIRST`，用户既看不出差别，也无法通过界面把它删掉 —— 删 `FIRST`
不会命中 `\uFEFFFIRST`。

### 22.2 修复：剥掉，但把差异报出去

`parseDotEnv` 现在剥离开头的 BOM（与绝大多数工具一致），并通过 `warnings`
回调报告这一分歧。诊断一路传到宿主 API 的 `warnings` 字段，客户端在页签顶部
以 `⚠` 显示，附上文件路径。

**为什么不静默剥离**：剥离会改变含义（DSH 眼里的键名与我们的不同），
而这正是本设计最想避免的"静默不一致"。用户有权知道。

**为什么不擅自改文件**：写回时 BOM **原样保留**。我们只解释它，不删除用户的
字节 —— 有断言守住：

```
PASS  BOM is preserved on disk (we explain it, we do not delete it)
PASS  only the target line changed — "FIRST=\"one\"\nSECOND=\"changed\"\n"
```

### 22.3 差分测试的一个盲区（值得记下）

这个缺陷本来会让我的差分测试**误报通过**：我的解析器与 `parseEnv` 对同一份
带 BOM 输入给出不同结果，但那**恰恰是正确行为**（我们有意比 `parseEnv` 宽容）。
所以差分测试不能覆盖 BOM；BOM 语义由专门的用例守着，并在文档里声明为
**已知且有意为之的差异** —— 而不是让差分测试的红灯被"忽略掉"。

### 22.4 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 23. P11 进展：注册表删除的可撤销性（2026-09-26）

`.env` 的写入天然可撤销（改回原值即可），而**注册表删除是不可逆的** ——
`reg.exe delete` 没有回收站，删掉就没了。这一轮把撤销能力补上。

### 23.1 为什么备份必须在宿主侧取

UI 拿到的是**摘要**（长值被截断到 120 字符），所以"从 UI 记住原值"这条路走不通 ——
撤销时必须写回**完整原值**。因此 `remove()` 改为**先读一次再删**，把原值与类型
一并回传：

```json
{"ok":true,"scope":"os-user","name":"DSH_ENV_MANAGER_RTT_53236","removed":true,
 "undo":{"name":"DSH_ENV_MANAGER_RTT_53236",
         "value":"%USERPROFILE%\\rtt-bin",
         "type":"REG_EXPAND_SZ"},
 "appliesAfterRestart":true}
```

**类型必须一起回传**：写回时若降级成 `REG_SZ`，`%USERPROFILE%` 就会变成字面量 ——
那样"撤销"反而破坏了原值。

### 23.2 真实注册表上的删除 → 撤销 → 再删

假执行器证明不了 `reg.exe` 真的接受恢复写入，所以在真机上跑了一遍完整链路
（自建变量名，`finally` 无条件清理）：

```
PASS  remove captured the original value — {"name":"...","value":"%USERPROFILE%\\rtt-bin","type":"REG_EXPAND_SZ"}
PASS  remove captured the original type — REG_EXPAND_SZ
PASS  undo write reports success — {"ok":true,"type":"REG_EXPAND_SZ"}
PASS  undo restored the exact value
PASS  undo restored the type
PASS  second removal also succeeds
PASS  no residue left in HKCU\Environment
```

### 23.3 拿不到备份时如实报告

极端情况（只允许写、不允许读的 ACL）下备份会失败。这时**不能假装可撤销**：

```
PASS  missing backup is reported — {"backupUnavailable":true}
PASS  missing backup produces no undo record
```

UI 相应地显示"已删除；宿主未能取得原值，无法撤销。"，而不是给一个点了会失败的按钮。

### 23.4 顺带修好的一个真 bug

`remove()` 现在会先 `query` 再 `delete`，所以**第一次调用不再是 `delete`**。
这让原有的断言 `remove uses delete with /f` 失败 —— 它断言的是 `calls[0]`。
改成在整个调用序列里找 `delete`，并补上"必须先有备份读取"的断言。

### 23.5 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 24. P12 进展：`.env` 并发写入的静默丢失（2026-09-26）

上一轮结束时我说要查"两个并发 UI 保存是否会互相覆盖"。答案是**会**，
而且比预想严重 —— 这是本项目第二个"多个操作都报告成功、数据却丢了"的故障。

### 24.1 故障：CAS 对同进程并发无效

`applyEnvEdits` 是「读 revision（await）→ 校验 → 原子写（await）」。
CAS 挡得住**外部进程**（它们会改变磁盘上的 revision），但挡不住**同一进程内**
的并发请求 —— 两者的读取都发生在任何写入之前，于是都看到同一个 revision。

实测（10 个并发写入，全部带同一个 `expectedRevision`）：

```
报告成功 : 10
被拒     : 0
最终内容 : "SEED=\"1\"\nK1=\"v1\"\n"
存活     : 1 / 10
```

**10 个"成功"的保存，9 个静默消失。** 这是最坏的一类故障：用户看到保存成功，
数据却没了，而且没有任何错误提示。

### 24.2 修复：按路径串行化整个「读 → 校验 → 写」

新增 `withPathLock(path, task)`，用 Promise 链实现按路径的临界区（不需要锁原语）：

```
previous = writeChains.get(key) ?? Promise.resolve()
run = previous.then(task, task)          ← 前一个失败也要能继续
writeChains.set(key, run.then(noop, noop))  ← 链上不留未处理的拒绝
```

纯计算校验（禁止名单、有损值）留在临界区外，让"必然失败"的请求不占用队列。

修复后同一实验：

```
报告成功 : 1
被拒     : 9  {"stale-revision":9}
存活     : 1 / 10          ← 与成功数一致，不再有静默丢失
```

**这是正确的 CAS 行为**：一个成功，其余明确告知"文件已被修改，请重新读取"。

### 24.3 六项回归断言

| 断言 | 守住的语义 |
|---|---|
| `exactly one concurrent write succeeds` | 排他性 |
| `every other concurrent write is rejected as stale` | 拒绝必须**明确**，不能静默 |
| `no silent loss: successes equal surviving writes` | **核心不变式**：成功数 == 存活数 |
| `sequential retries persist every key` | 拒绝是**可恢复**的，不是死路 |
| `concurrent writes to different paths both succeed` | 临界区是**按路径**的，不是全局瓶颈 |
| `a later write still proceeds after a rejection` | 一次失败**不能毒化**该路径的链 |

### 24.4 对照结论：注册表**不需要**临界区

同类的担心不适用于注册表 —— 但这是实测结论，不是推理（上一轮的教训就是
"理论推导"靠不住）：

```
并发写入数   : 8
报告成功     : 8
独立读回存活 : 8
每个值都正确 : true
✅ 注册表没有同类竞态
```

原因是本质差别：`.env` 是**整文件**读-改-写（并发必然互相覆盖），
而 `reg.exe add` 是**按值的原子 OS 操作**（不同值之间不干扰）。

**这条对照值得记住**：不是"所有写入都要加锁"，而是"整文件读-改-写才需要"。

### 24.5 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 25. P13 进展：覆盖审计与文档收尾（2026-09-26）

### 25.1 覆盖审计发现 9 个未覆盖导出

写了 `audit-coverage.mjs`：把每个 lib 模块的 `export` 符号与全部测试套件做词边界匹配，
找出"看起来受保护、实际没有断言守住"的盲区。首轮结果：

```
导出符号总数 : 54
测试覆盖     : 45
完全未覆盖   : 9
```

其中三个是**安全关键常量**：`BOOTSTRAP_PREFIXES`（前缀禁令）、
`HOME_LAYER_PROXY_NAMES`（代理例外）、`SENSITIVE_ENV_PATTERN`（敏感名规则）。
它们此前只被间接使用，没有任何直接断言。

### 25.2 最强的一条新断言：与 DSH 源码差分

我没有满足于"给名单加几条断言"，而是**从 DSH 自己的实现里提取权威名单再比对**：

```
PASS  extracted the upstream BOOTSTRAP_NAMES list — 49
PASS  our BOOTSTRAP_NAMES is not missing any upstream entry
PASS  our BOOTSTRAP_NAMES has no entries DSH does not reject
PASS  BOOTSTRAP_PREFIXES matches upstream exactly — ["BASH_FUNC_","DSH_","DYLD_","XDG_"]
PASS  HOME_LAYER_PROXY_NAMES matches upstream exactly
```

这条断言的价值在于：**上游增删条目时它会立刻变红**，而"我认为名单是这样的"
这种断言只会在自己写错时才知道。

### 25.3 删掉一处死代码

`host-api.mjs` 里的 `defaultWorkspaceRoot` 没有任何引用（连测试都没有）。删掉，
连同只被它使用的 `node:path` import。

**这正是覆盖审计的用处**：它顺带找出了"写了但没人用"的导出。

### 25.4 新增 73 项断言，覆盖从 45/54 → 53/53

| 断言组 | 内容 |
|---|---|
| 禁止名单差分 | 3 个常量与 DSH 源码逐条一致 |
| 前缀禁令 | 4 个前缀各自真的挡住；不含前缀的名字不受影响 |
| 敏感名规则 | 6 个命中样本 + 4 个不命中样本 |
| 逐层可写性 | 11 项，含代理的 home 层例外与未知层 |
| `readEnvFile` | 存在/缺失/目录/警告带路径 |
| `normalizeKeyPath` | 缩写根与全名归一（本设计最难定位 bug 的回归测试）|
| `mergeOsLayers` | 层合并、信任序、晋升标记、**不修改入参**、空输入安全 |
| `runReg` | 返回 **Buffer** 而非字符串；不存在的键必须抛 |

### 25.5 交付清单

新增 `README.md`：代码结构表、验证命令、**探针清单（每个探针回答什么问题）**、
生效时机表、已知边界、开发注意事项。

README 里的内容经程序校验与磁盘实际一致：所有引用的文件存在、所有套件与探针
都被列出、**8 个套件的断言数与实测逐项相符**（合计 675）。

### 25.6 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 26. P14 进展：敌意输入审计（2026-09-26）

此前所有测试用的都是**我自己构造的输入**（加上少量已知攻击）。这一轮写了
`audit-hostile-input.mjs`，系统性地把畸形请求砸向**每一个** HTTP 处理器：
189 项断言，覆盖 14 种敌意查询串、18 种畸形请求体、12 种畸形凭据输入、
13 种畸形注册表输入。

判据不是"它拒绝了"，而是「**结构化地**拒绝，且不泄露内部信息」。

### 26.1 结果：没有崩溃、没有泄露

全部处理器在敌意输入下都返回结构化错误，没有未捕获异常，没有堆栈帧，
没有插件源码路径。包括：

- 传输中途抛错（模拟连接中断）→ 结构化 500，异常不逃逸出处理器
- `__proto__` 污染尝试 → `Object.prototype` 未被污染
- 300 KB 请求体 → 被上限拒绝并说明限制
- NUL 字节、换行、未转义百分号、5000 字符路径 → 都不崩
- 二进制垃圾作为请求体 → 结构化拒绝

### 26.2 两个检测器自身的缺陷（都是误报，值得记下）

审计脚本第一版报了 **15 项失败，全是误报**：

| 误报 | 根因 |
|---|---|
| `"at position 22"` 被当成堆栈帧 | 朴素的 `includes('at ')` 太粗 —— Node 的 JSON 解析错误消息里就有这个词 |
| 成功响应里出现 `node_modules` 被当成路径泄露 | 那就是 `PATH` 变量的**值**，而展示环境正是本工具的目的 |

第二个尤其值得记：我把"错误响应不该泄露内部路径"与"成功响应会包含环境值"
**混在一条检测里**，于是把功能正常当成了漏洞。修法是把判据按响应类别拆开，
并且只在错误响应上查泄露。

**这类"检测器误报"的危害不是噪音，而是它会训练人忽略红灯。**

### 26.3 审计暴露的一条真实边界，我把它写成了断言

审计输出里有这么一条：

```
['path traversal cwd', ...] -> {"cwd":"E:\\Windows","home":"C:\\Users\\qq651\\.dsh",...}
```

即：`cwd` 被 `resolve()` **解析**而不是被拒绝，所以 `..\..\..\Windows` 会变成
`E:\Windows`。我的路径白名单防的是「写任意**文件名**」，防不住
「写任意**目录下的** `.env`」。

**判定为可接受**，理由写在代码注释与断言里：

- 写端点已有请求策略闸门（§21）。能通过闸门的调用者持有会话 cookie，
  而该用户本来就能直接改文件 —— 限制 `cwd` 不增加真实防护。
- 限制 `cwd` 反而会误伤合法用法（多工作区、临时目录）。

所以我**把它写成断言**而不是留着不说：

```
PASS  cwd is resolved rather than rejected
PASS  an explicit path is still rejected regardless of cwd
PASS  the rejection names the derived path
```

第三条的实测输出正好说明了关键性质 —— **无论 `cwd` 是什么，显式 `path` 都挡得住**：

```
拒绝写入：请求声明的路径 "...\evil.env" 与 project-env 层推导出的路径 "E:\Windows\.env" 不一致
```

**宁可写明边界，也不假装比实际更强。**

### 26.4 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 27. P15 进展：重启前预检（2026-09-26）

用户的 3080 实例已近 100 分钟未重启。**重启只能试一次**，所以这一轮的目标是
把所有失败模式提前暴露，而不是把发现问题的机会浪费在重启上。

新增 `preflight.mjs`，按 DSH 启动的真实顺序检查 7 组共 46 项：

| 组 | 检查内容 |
|---|---|
| 1. profile 声明 | `dsh.profile.bundles` 含本包、依赖是 `link:`、`patchReload` 已声明 |
| 2. 包解析 | junction **真身**指向本工作区、`dsh.bundle.patch` 与 `dsh.client.platform` 齐备 |
| 3. 宿主可加载性 | 7 个模块**逐个真 import**（语法 + 依赖解析）|
| 4. cordis 契约 | `apply` 是函数、`inject` 三项齐备、**`apply` 在完全无服务时不抛** |
| 5. 客户端 bundle | 编译、注册工厂、工厂物化、**只 require `react`** |
| 6. 组合配置 | `dsh --dump-config` 成功、我们的行存在、**未被 disabled** |
| 7. 权限与残留 | 真实 `~/.dsh` 未被污染、注册表无残留、patch 层仍是空数组 |

### 27.1 预检自己抓到的两个缺陷（又是"检查脚本错了"）

首次运行报了 2 项失败，**都是检查脚本的问题，不是插件的问题**：

| 误报 | 根因 |
|---|---|
| "链接未指向本工作区" | `resolve()` **不解析 junction**，只做词法归一。改用 `realpathSync` |
| "`dsh --dump-config` 失败" | PATH 上的 `dsh` 在 Windows 只有 `dsh.ps1`（PowerShell 脚本），`execFileSync('dsh', ...)` 无法直接执行它。改用解析出的 bin 入口 + `process.execPath` |

第二条尤其值得记：**"预检失败"与"产品失败"必须分清**。如果我当时按预检的结论
去改 profile，就会把好好的配置改坏。

### 27.2 预检通过说明什么

46 项全过意味着：重启后**配置与加载路径上的失败模式已被排除**。
若重启后仍异常，问题就在浏览器侧或运行时交互，而不在"装没装上、能不能 import"。

这正是预检的价值：**把重启后的排查范围从"整条链路"缩小到"浏览器那一端"**。

### 27.3 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 28. P16 进展：遮蔽关系与注册表层回落的端到端验证（2026-09-26）

此前注册表层的验证都是**单向**的：写进去、读回来。但这一层的设计核心是
「同一个名字可能同时存在于多个权威层，UI 要展示竞争关系」——
那条链路**从没被端到端验证过**。这一轮在隔离实例上补齐。

### 28.1 全链路结果（真实 HTTP + 真实注册表）

| 步骤 | 结果 |
|---|---|
| 写注册表（`os-user`）| `state` 里出现，`effective=os-user`，带 `registryType: REG_SZ` 与值 |
| 独立 `reg.exe` 读回 | `ENVMGR_LAYER_TEST  REG_SZ  registry-value` |
| 再写同名 `.env`（`project-env`）| `layerCount=2`、`shadowed=true` |
| **信任序判定** | **`effective=project-env`** —— 高层遮蔽低层 |
| 层序 | `project-env,os-user`（符合 `SOURCE_ORDER`）|
| 两层元数据各自保留 | `.env` 层带**文件路径**，注册表层带**原始类型** |
| 删掉 `.env` 层 | 生效层**回落**到 `os-user`，`shadowed=false` |
| 再删掉注册表层 | 变量**完全消失** |

`verify-*` 套件里那些断言是**单元级**的（拿合成数据喂函数）；
这一轮证明的是**真实链路**：HTTP → 路由 → 注册表 → 复合模型 → 投影 → 响应，
而且遮蔽与回落都正确。

### 28.2 一个意外收获：禁止名单挡住了我自己的测试

第一版测试用了 `DSH_ENV_MANAGER_LAYER_TEST` 作变量名，`.env` 写入**被拒绝**：

```json
{"ok":false,"error":"validation-failed",
 "problems":[{"code":"bootstrap-only",
   "message":"\"DSH_ENV_MANAGER_LAYER_TEST\" 只能由启动环境提供 … 请改为导出 …"}]}
```

我一开始以为是测试 bug，但**那正是规则该做的事** —— 而且它证明了禁止名单
不只在单元测试里生效，**在 HTTP 层真的挡住了写入**。改用非 `DSH_` 前缀的
名字后测试通过。

**这条值得记**：一个安全规则挡住自己的测试，是好消息而不是坏消息。

### 28.3 验证脚本的定位

`e2e-shadowing.ps1` 需要**运行中的 DSH 实例**与 token，所以不在常规套件里。
它和 `verify-registry-roundtrip.mjs` 属于同一类：**会真实触碰系统状态**
（前者写 `HKCU\Environment`，后者也是），都在 `finally` 里无条件清理。

### 28.4 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **P0 端到端验证**（`DSH_ENV_MANAGER_LIVE` 出现在 shell 调用里）| **需要重启 3080 实例（PID 59800）** |
| 浏览器页签目视确认 | 同上 |

---

## 29. P17 进展：重启后一条命令（2026-09-26）

用户选择重启 3080。但我发现一个此前没有确认的事实：

> **3080 的 server 与 agent 会话运行时是同一个进程（PID 59800）。**

也就是说重启会终止当前对话所在的会话 —— 这解释了为什么我不能自己执行它。
好消息是 DSH 的会话历史是持久化的，重启后可以在新实例里恢复。

于是这一轮的目标变成：**让重启立刻产生最大信息量，并且在新会话里可执行**。

### 29.1 `post-restart-probe.ps1`

只依赖 HTTP（外加一个隔离实例），所以在新会话里能直接跑。六组检查：

| 组 | 内容 |
|---|---|
| 1. 旧进程 | 确认 PID 59800 真的退出了（还在跑就明确报告）|
| 2. 新进程 | 3080 上有监听、且**启动时间 < 5 分钟**（防止把旧进程当成新的）|
| 3. 静态预检 | 复用 `preflight.mjs` |
| 4. 测试套件 | 9 个文件全跑 |
| 5. **运行时行为** | 起隔离实例，验证插件日志、请求闸门、四层数据、客户端 bundle |
| 6. 残留 | 注册表、`.env`、探针 home |

第 5 组的实测输出（脚本自身已验证可用）：

```
[env-manager] plugin loaded (pid=58372, uptime=17.3s, DSH_SHELL=1)
[env-manager] contributor registered: DSH_ENV_MANAGER_LIVE (marker=unset)
[env-manager] credentials service available (1 stored record(s): {"grant":1})
PASS  health route exists and is gated (401)
PASS  cross-site request is refused (403)
PASS  foreign Host is refused (403)
PASS  authenticated state request succeeds
      variables: 109   shadowed: 27   os layers: user=19 machine=18
PASS  client bundle is in the boot graph
```

### 29.2 写这个脚本时踩到的三个坑（都在交付前修掉了）

**这正是"交付前先自己跑一遍"的价值** —— 否则用户会在重启后才发现工具本身坏了。

| 坑 | 根因 |
|---|---|
| 探针实例起不来 | 我硬编码了 `$env:APPDATA\npm-cache\...`，而实际在 **`AppData\Local`**。改为从 profile 的解析结果里定位 dsh 的 bin |
| index 拿到 0 字节 | `/?token=` 回 **303** 到 `/`，`curl` 不加 `-L` 只拿到重定向响应 |
| "index 只有 47 字节"的假象 | PowerShell 把 curl 的多行 stdout **拆成数组**，`$idx.Length` 变成了**行数**。改用 `curl -o 文件` 再读文件 |

第三条尤其隐蔽：它报出的是一个看起来合理的数字（47），而真实原因是**度量对象错了**。
这和之前那次"用 `?.` 把时序 bug 伪装成值不对"是同一类错误。

### 29.3 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **端到端验证** | **等用户在修好的版本上重启** |
| 浏览器页签目视确认 | 同上，唯一需要人眼的一项 |

---

## 30. P18 进展：真实启动失败与两个默认行为的修正（2026-09-26）

用户重启后遭遇**真实启动失败**，并指出两个我不该做的默认行为。这一节记录根因与修正，
因为它暴露了我验证方法上的一个系统性漏洞。

### 30.1 根因：客户端插件也必须声明 `inject`

用户贴出的错误原文：

```
Failed to load plugins
dsh-env-manager
failed to apply loader entry 37f9efcc (dsh-env-manager):
cannot get property "slots" without inject
```

**这是同一个坑，我踩了第二次。** 宿主机半边的 `credentials` 早就报过
`cannot get property "credentials" without inject`，我当时把它写进了本文档
（§12.1「任何要读取其他服务的 DSH 插件都必须声明 `inject`」），
却**没有把它应用到客户端半边**。

第一方包的做法是在 `package.json` 的 `dsh.client.inject` 里列出
**提供该服务的包名**：

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-settings-plugins"]
  }
}
```

修好后实测 boot manifest 里出现了该字段（此前根本不存在）：

```json
{"id":"dsh-env-manager","rev":"93bf3510c15b2b16-48",
 "inject":["@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-ui-settings-plugins"]}
```

（顺带确认：`dsh-client-ui-slots` 在模块图里**没有** `/client.js`，因为它是
**种子模块** —— 第一方 `settings-plugins` 也直接 `require` 它。按包名 inject 是正确用法。）

另外给客户端 `apply` 加了二道防线：`ctx.slots` 缺失时**只 warn 不抛**
（抛错会让 loader 报 "failed to apply loader entry"，把"少声明 inject"
掩盖成"插件坏了"）。

### 30.2 我的验证方法有一个系统性漏洞

**此前所有客户端验证都只检查了「bundle 被加载」，从没检查「apply 能不能真的跑」。**

- `preflight.mjs` 检查了工厂能物化、只 require `react`
- `check-p0.mjs` 检查了 `apply()` 能注册槽位

但两者都用**我自己造的假 ctx**，而假 ctx 里 `ctx.slots` **总是存在的**。
真实 cordis 会因为缺少 inject 声明而**拒绝提供该属性**，这个差异从未被触及。

**教训**：用自造替身验证"代码能跑"是必要但不充分的 —— 替身必须与被替代者的
**约束**一致（这里：cordis 对未声明服务是**抛错**，不是返回 `undefined`），
否则它只证明了"在我想象的世界里能跑"。

修正：`check-p0.mjs` 新增一组断言（8 项）覆盖 `dsh.client.inject` 的声明、
与第一方包对照约定一致（不靠我的记忆）、以及缺 `slots` 时的降级行为。

### 30.3 两个不该做的默认行为

| 问题 | 修正 |
|---|---|
| **bundle 装完即启用** | `cordis.patch.yml` 改为 `disabled: true`。挂载与启用是两个决定，合并会让"只是想装一下"变成"我的 DSH 行为变了"；而一旦启动出问题，用户直接失去 DSH。这与 `dsh-web-app` 里 `ui-schedule` 的写法一致 |
| **preflight 把"被禁用"报成失败** | 早先断言 `our row is not disabled` 与 `profile patch layer is empty`，于是用户按设计关掉它时会看到 FAIL —— 把**用户的正常选择**误报成配置损坏 |

第二个尤为讽刺：我的检查工具在**指责用户做了正确的事**。现在它把启用/禁用
如实报告为状态，只对"重复行"这类真问题报错。

### 30.4 仍未完成的

| 项 | 阻塞原因 |
|---|---|
| **端到端验证** | 等用户在修好的版本上再重启一次 |
| 浏览器页签目视确认 | 同上 |

---

## 附录：事实来源

- 本机 DSH 安装：`C:\Users\qq651\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`（240 个包，v0.1.5-rc.3）
- 本机 DSH home：`C:\Users\qq651\.dsh\`（含 `settings.yaml`、`.credentials.yaml`、`profiles/web/`）
- 关键包：`dsh-app-boot`（`loadEnv` / `BOOTSTRAP_NAMES` / `BOOTSTRAP_PREFIXES` / `readEnvLayer` / `loadLayeredEnv` / `watchUserPatches`）、`dsh-launch-environment`（`SOURCE_ORDER` / `lookupKey`）、`dsh-shell-env`（`RESERVED_BASH_ENV_KEYS` / `keyOwners`）、`dsh-subprocess`（`scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN` / `DSH_ENV_PREFIX`）、`dsh-bash-local`（spawn env 组装）、`dsh-credentials`、`dsh-credentials-local`、`dsh-settings`、`dsh-client-ui-settings`（`contract/slots.d.ts`）、`dsh-client-ui-settings-plugins`、`dsh-client-modules`、`dsh-host-webserver`、`cordis`（`src/reflect.ts` 的 `set`/`provide` 契约、`src/context.ts` 的代理机制）
- **§11 热重载结论的来源**：
  - `cordis/src/reflect.ts` —— "Only the fiber that provided the service may set it" → 换掉 `launchEnvironment` 槽位不可行
  - `dsh-subprocess` —— `scrubbedParentEnv()` 每次 spawn 从 `process.env` 重建；清洗 `/KEY|PASSWORD|SECRET|TOKEN/i` 与全部 `DSH_*`
  - `dsh-app-boot` —— `loadLayeredEnv` **已导出**，可复用来保证"热重载语义 == 重启语义"
  - `dsh-app-boot` —— `if (process.env[name] === void 0) process.env[name] = value` → 继承环境优先，`.env` 只补空缺
  - `dsh-llm-deepseek` / `dsh-web-search-deepseek` / `dsh-webhook-github` —— 每次请求调 `credentials.resolve` → 凭据对 DSH 内部本来就是热的
  - `dsh-shell-env` —— `resolve(execution)` 每次执行都跑 → 贡献变量本来就是热的
- Node 内置 API：[`util.parseEnv`](https://nodejs.org/api/util.html#utilparseenvcontent)、[`process.loadEnvFile`](https://nodejs.org/api/process.html#processloadenvfilepath)、[`process.env`](https://nodejs.org/api/process.html#processenv)
- **本机实测项（不可从文档推出，已实跑验证）**：
  - Node 版本 `v24.16.0`（Volta 安装）；运行中的 DSH 进程 `execPath` 与之相同，故解析语义一致
  - `.env` 不做变量展开：`$VAR` / `${VAR}` / `%VAR%` 全部字面量（`parseEnv` 与 `loadEnvFile` 双路径均已验证）
  - `.env` 接受 `export` 前缀；**冒号分隔行被静默丢弃**；双引号支持跨行与转义
  - `DSH_HOME` / `DSH_WEB_URL` **不在** `HKCU\Environment`（该键下只有 `Path`）→ 证实运行时注入
  - `.credentials.yaml` 的 Windows ACL：`SYSTEM` / `Administrators` / 当前用户 三方 `FullControl`
  - `http://127.0.0.1:3080` 有服务在监听（未认证请求返回 401），即 `DSH_WEB_URL` 指向的活服务
