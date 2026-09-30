# 官方参考来源与覆盖范围

## 桌面版专项核对

2026-09-30 核对官方发布 [0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) 的源码提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。安装 UI、桌面 profile 隔离、`dsh-app://app/` 转发、Connection registry 和插件展示元信息见 [桌面版安装与通信](desktop.md)，其中按契约链接到固定提交的官方源码。这次是源码专项核对，没有重新抓取下方 68 个网页；`sources.json` 仍记录 2026-09-28 的原始抓取。

## Reference 页面抓取

抓取完成：2026-09-28 00:42:18（Asia/Shanghai）；UTC：`2026-09-27T16:42:18.926069+00:00`。

范围为给定 `/en/reference/` 前缀中从页面链接可发现的文档。共完整抓取 68 个可访问页面，下载失败 0 项，发现 47 个返回 404 的链接。锚点不是独立页面；网站其他栏目及 GitHub 外链不计入此覆盖范围。

skill 按开发场景提炼契约，生成目录和完整类型留在官方来源按需查询。正文缓存位于系统临时目录，不随 skill 复制手册。这里的覆盖表示正文获取与主题归档；没有宣称逐个执行所有示例或验证每个 Harness 版本。

逐页 URL、原始 HTML 的 SHA-256、正文字符数和抓取时间见 [sources.json](sources.json)。调用新的 API 时核对项目版本；主分支文档与已安装包可能有差异。不同页面发生代际描述差异时，以目标包声明、实现和当前组合验证结果决定。

| 页面 | 何时查阅 |
| --- | --- |
| [Agent Turn And Step Lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/reference/agent-lifecycle) | turn/step、持久 settlement、live stream 与恢复 |
| [API Gateway](https://deepseek-harness.github.io/deepseek-harness/en/reference/api-gateway) | Typert unary Remote、生成产物、参数约束和 SRC 限制 |
| [Capability Seams And Core Services](https://deepseek-harness.github.io/deepseek-harness/en/reference/capability-seams) | definition/provider/consumer 的归属与连接 |
| [Plugin Config Catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/config-catalog) | 部署字段、Requires、runtime-only 字段与默认值 |
| [Cookbook: adding a workspace package](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-package) | monorepo 包布局、build graph、发布与 README 门禁 |
| [Cookbook: adding a settings card](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card) | Host namespace、Client keyed card、bundle 与 revisions |
| [Tool authoring reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool) | typed canonical output、PTC、UI projection 与后台任务 |
| [Cookbook: adding an LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-an-llm-adapter) | adapter 注册、StreamChunk 协议与 replayState |
| [Cookbook: extension plugin shapes](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook) | tool/hook/UI/protocol driver 的选型 |
| [Context](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/context) | extend/isolate/intercept、service store 与低级查询 |
| [Events](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/events) | emit/waterfall/parallel/serial/bail 与 listener |
| [Fiber](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber) | effects、await/restart/update、错误与异步卸载 |
| [Inherited Cordis API](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/inherited) | loader/HMR/timer 与框架继承 API |
| [Registry](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/registry) | plugin shape、inject 与 dependent lifecycle |
| [Service](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/service) | Service 构造、生命周期和静态 symbols |
| [Cordis Primer](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer) | 注入、dispatch modes 与 reversible effects |
| [DeepSeek Harness Architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/) | 架构、profile、bundle、应用入口与 extension map |
| [Session Persistence Event Catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/persistence-catalog) | durable payload、surface/log-only 与声明归属 |
| [Subsystems](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems) | 子系统总览与角色定位；其部分相对链接失效，使用本表正式 URL |
| [User Approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval) | 一次授权、ask/never、closed outcomes 与 audit |
| [Client Modules](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules) | package discovery、lazy-CJS、boot graph、revision 与 HMR |
| [Client Resources](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-resources) | protocol address、metadata stream、holders 与 failure snapshot |
| [Code Runtime](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/code-runtime) | program/bindings、失败分类、输出限额与 runtime isolation |
| [Human Commands](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/commands) | 直接命令、rawInput、descriptors 与结果关联 |
| [Compaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction) | pressure/overflow、pruning、summary 与 surface replacement |
| [Conversation assembly](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/conversation) | 稳定 context、target、replay、predecessor 与 keyed renderer |
| [Core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core) | Agent 创建、ownership、输入 receipt、interception 与 branded ids |
| [User Credentials](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/credentials) | ref/record、每操作 resolve、shadow 与 serialized refresh |
| [Filesystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/filesystem) | opaque targets、atomic guards、observation policy 与错误 |
| [Same-session goals](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/goal) | revision CAS、durable lifecycle 与 process activation |
| [Runtime Invariants](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/invariants) | 包拥有的可观察 invariant、installer 与 companion |
| [Background Task Runtime](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/jobs) | producer hooks、admission、owner、status 与 consuming output |
| [LLM Streaming](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/llm-streaming) | 消息、stream、adapter、prepared call、reasoning 与 usage |
| [LSP navigation](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/lsp) | 规范化查询、UTF-16 坐标与 exclusive provider 注册 |
| [Permission Presets](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/permission-presets) | sandbox/approval 组合及 derived custom |
| [Session Persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence) | handle、flush、crash recovery 与版本 generation |
| [Plan Mode](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/plan) | soft guidance、pending selection、exit review 与 durable mode |
| [Process Sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox) | argv confinement、full/partial 与 fail-closed 错误 |
| [Session-local Schedule](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/schedule) | 明确时区、UTC、固定间隔、catch-up 与 live delivery |
| [Scoped Registration](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/scope) | 注册 scope、opaque carrier 和 quiescent disposal |
| [Sessions](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session) | append、surface ordering、history derivation 与 enclosure |
| [Session Projections](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-projection) | 增量 fold、stateOf、snapshot 与 registry 缺席 |
| [Session Query](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-query) | typed filters、全文搜索、lineage 与 bounded event reads |
| [Session References](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-reference) | 文件 candidates、prepared messages 与授权引用 |
| [SessionTelemetryBackend](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-telemetry) | capture policy、分享披露、backend 与 redact waterfall |
| [Session Titles](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-title) | 单 title provider、durable title 与辅助请求 |
| [User Settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings) | defaults/base/user、secret redaction、revision 与 path mutation |
| [Bash Executor](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/shell) | request/spec、shellEnv、sandbox 与独立退出事实 |
| [Right Sidebar](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sidebar-right) | tab definition/body、导航、document preview 与 Session 布局 |
| [Skills](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills) | provider registry、scope/rank、发现、invocation 与 catalog |
| [Web Client Slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots) | declaration owner、cardinality/scope、props 与 inject hooks |
| [Spill Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/spill) | save request、截断内容保存与恢复 |
| [Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage) | backends、domain schemas、write ordering 与 durability |
| [Subagent](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent) | 多 provider、live capability、continuable children、depth 与 seed |
| [Subprocess](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subprocess) | execution world、argv、stdio、managed range 与 terminal primitive |
| [System Prompt Assembly](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/system-prompt) | sections、context、variables、scope 与 assembly |
| [Persistent PTY Sessions](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/terminal) | PTY ownership、send/read、retained output 与 disposal |
| [Token Meter](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/token-meter) | revisioned measurement、route pricing 与 surface 顺序 |
| [Tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools) | schema DSL、immutable execution、限制、guards 和结果投影 |
| [Typert remote calls](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/typert) | lookup/Context providers、strict codecs 与 Remote contribution |
| [User Interaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/user-questions) | question id、intent、labels、自定义回答与取消 |
| [Web Access](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web) | search/fetch providers、selection、HTTP 状态与网络策略 |
| [Web Client architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client) | Host/Client models、slots、conversation 与 reconnect |
| [HTTP Server](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-server) | named routes、response ownership、index injection 与 carrier 边界 |
| [Workflow](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workflow) | script/meta、caps、fatal failures、run 清理与 durable Chat records |
| [Workspaces](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workspace) | canonical path、Session account 与非破坏性删除 |
| [Tool Schema Catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-catalog) | 内置工具 schema、工具与 capability 包映射 |
| [Tool Execution Pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline) | 策略管线、guards、finalize 与 PTC 子调用 |

## 失效链接

以下链接在本次抓取返回 404，保留以便审计。不要把对应内容当作已成功读取；相关主题可从上表的正式 subsystem 页面访问。刷新时重新发现，不把旧路径写成 API 依据。

- [approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/approval) — HTTP 404
- [client-modules](https://deepseek-harness.github.io/deepseek-harness/en/reference/client-modules) — HTTP 404
- [client-resources](https://deepseek-harness.github.io/deepseek-harness/en/reference/client-resources) — HTTP 404
- [code-runtime](https://deepseek-harness.github.io/deepseek-harness/en/reference/code-runtime) — HTTP 404
- [commands](https://deepseek-harness.github.io/deepseek-harness/en/reference/commands) — HTTP 404
- [compaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/compaction) — HTTP 404
- [conversation](https://deepseek-harness.github.io/deepseek-harness/en/reference/conversation) — HTTP 404
- [core](https://deepseek-harness.github.io/deepseek-harness/en/reference/core) — HTTP 404
- [credentials](https://deepseek-harness.github.io/deepseek-harness/en/reference/credentials) — HTTP 404
- [filesystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/filesystem) — HTTP 404
- [goal](https://deepseek-harness.github.io/deepseek-harness/en/reference/goal) — HTTP 404
- [invariants](https://deepseek-harness.github.io/deepseek-harness/en/reference/invariants) — HTTP 404
- [jobs](https://deepseek-harness.github.io/deepseek-harness/en/reference/jobs) — HTTP 404
- [llm-streaming](https://deepseek-harness.github.io/deepseek-harness/en/reference/llm-streaming) — HTTP 404
- [lsp](https://deepseek-harness.github.io/deepseek-harness/en/reference/lsp) — HTTP 404
- [permission-presets](https://deepseek-harness.github.io/deepseek-harness/en/reference/permission-presets) — HTTP 404
- [persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/persistence) — HTTP 404
- [plan](https://deepseek-harness.github.io/deepseek-harness/en/reference/plan) — HTTP 404
- [sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/sandbox) — HTTP 404
- [schedule](https://deepseek-harness.github.io/deepseek-harness/en/reference/schedule) — HTTP 404
- [scope](https://deepseek-harness.github.io/deepseek-harness/en/reference/scope) — HTTP 404
- [session](https://deepseek-harness.github.io/deepseek-harness/en/reference/session) — HTTP 404
- [session-projection](https://deepseek-harness.github.io/deepseek-harness/en/reference/session-projection) — HTTP 404
- [session-query](https://deepseek-harness.github.io/deepseek-harness/en/reference/session-query) — HTTP 404
- [session-reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/session-reference) — HTTP 404
- [session-telemetry](https://deepseek-harness.github.io/deepseek-harness/en/reference/session-telemetry) — HTTP 404
- [session-title](https://deepseek-harness.github.io/deepseek-harness/en/reference/session-title) — HTTP 404
- [settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/settings) — HTTP 404
- [shell](https://deepseek-harness.github.io/deepseek-harness/en/reference/shell) — HTTP 404
- [sidebar-right](https://deepseek-harness.github.io/deepseek-harness/en/reference/sidebar-right) — HTTP 404
- [skills](https://deepseek-harness.github.io/deepseek-harness/en/reference/skills) — HTTP 404
- [slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/slots) — HTTP 404
- [spill](https://deepseek-harness.github.io/deepseek-harness/en/reference/spill) — HTTP 404
- [storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/storage) — HTTP 404
- [subagent](https://deepseek-harness.github.io/deepseek-harness/en/reference/subagent) — HTTP 404
- [subprocess](https://deepseek-harness.github.io/deepseek-harness/en/reference/subprocess) — HTTP 404
- [system-prompt](https://deepseek-harness.github.io/deepseek-harness/en/reference/system-prompt) — HTTP 404
- [terminal](https://deepseek-harness.github.io/deepseek-harness/en/reference/terminal) — HTTP 404
- [token-meter](https://deepseek-harness.github.io/deepseek-harness/en/reference/token-meter) — HTTP 404
- [tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/tools) — HTTP 404
- [typert](https://deepseek-harness.github.io/deepseek-harness/en/reference/typert) — HTTP 404
- [user-questions](https://deepseek-harness.github.io/deepseek-harness/en/reference/user-questions) — HTTP 404
- [web](https://deepseek-harness.github.io/deepseek-harness/en/reference/web) — HTTP 404
- [web-client](https://deepseek-harness.github.io/deepseek-harness/en/reference/web-client) — HTTP 404
- [web-server](https://deepseek-harness.github.io/deepseek-harness/en/reference/web-server) — HTTP 404
- [workflow](https://deepseek-harness.github.io/deepseek-harness/en/reference/workflow) — HTTP 404
- [workspace](https://deepseek-harness.github.io/deepseek-harness/en/reference/workspace) — HTTP 404
