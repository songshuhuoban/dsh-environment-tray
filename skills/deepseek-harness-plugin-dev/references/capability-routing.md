# 从需求选择公开扩展点

基础地图：[Capability services](https://deepseek-harness.github.io/deepseek-harness/en/reference/capability-seams)、[Extension patterns](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook)、[Subsystems](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems)。

| 要实现的行为 | 首选扩展点 | 深入参考 |
| --- | --- | --- |
| 模型可调用能力 | `ctx.tools.register` | tools-and-policy.md |
| 前置/后置 hook、最终 audit | `tools/*`、`agent/*` 所属契约 | tools-and-policy.md、model-and-context.md |
| 单 Agent capability/prompt/policy | `agent.ctx` scoped contribution；必要时 preset 的 isolate realm | cordis-and-packaging.md |
| 模型 provider 或模型目录 | `ctx.llm.registerAdapter` 与 adapter metadata | model-and-context.md |
| 稳定提示词/动态模型状态 | `systemPrompt.section`/`context` | model-and-context.md |
| 单次上下文通知/新回合输入 | `agent.inject`/`followup`/`steer` | model-and-context.md |
| 可替代文件或进程世界 | `ctx.fs` 与 `ctx.subprocess` 相匹配的 providers | execution-and-automation.md |
| Shell / PTY / LSP | `ctx.shell`/`ctx.terminals`/`ctx.lsp` | execution-and-automation.md |
| 后台任务 | `ctx.jobs`，producer hooks | execution-and-automation.md |
| 程序执行/代理编排 | `ctx.codeRuntime`/`ctx.workflowEngine` | execution-and-automation.md |
| 命名代理 backend/可续接 children | `ctx.subagents` | execution-and-automation.md |
| 人类命令/普通问答/审批 | `ctx.commands`/`ctx.userQuestions`/`ctx.approval` | tools-and-policy.md、execution-and-automation.md |
| 同 Session objective / 提醒 | `ctx.goals` / Schedule 契约 | execution-and-automation.md |
| 插件设置/密钥/领域持久数据 | `ctx.settings`/`ctx.credentials`/Storage domain | sessions-and-storage.md |
| durable Session state / replay projection | SessionEventMap / `ctx.sessionProjections` | sessions-and-storage.md |
| Session storage/query/title/telemetry | 各对应 seam/provider | sessions-and-storage.md |
| Session 引用/Workspace 归属 | session-reference / workspace public API | sessions-and-storage.md |
| Web provider / skill provider / spill backend | `ctx.web`/`ctx.skills`/`ctx.spillStore` | execution-and-automation.md |
| UI 动作、设置卡、工具卡 | `ctx.slots` 的现有声明 | client-ui.md |
| Chat 业务节点 | Conversation Definition + keyed renderer | client-ui.md |
| 右侧 tab / 文件 viewer / 地址元数据 | sidebar tab definition、documentPreview、resources provider | client-ui.md |
| Host unary RPC / streams / download | generated Remote / 当前逻辑 stream / exact Fetch route | client-ui.md |
| webhook 触发 Session | 当前 `ctx.webhookRuntime` 与 provider adapter | 在 capability map 中定位 owning package，再核对源码；本次 reference 未提供独立 webhook subsystem 页面 |

服务名不是包名。先确认 definition 包、provider 包、consumer 包与 profile 已挂载能力；接入现有 seam 时只实现所需角色，不复制 loop 或其他 provider 的业务逻辑。

三个生成目录用途不同：

- [Config catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/config-catalog)：部署可配置字段、runtime-only 字段注释与 Requires；不是 service method reference。
- [Tool catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-catalog)：模型实际看到的内置 schema 与默认配置分支；不是 typed output 的全部运行时契约。
- [Persistence catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/persistence-catalog)：durable event envelope、payload、surface/log-only 与 owning declaration；不是 Cordis live-event 名称列表。

API 方法和 event signature 在对应 subsystem 的 generated Cordis API；框架能力在 cordis-api 与 inherited 页面。目录中零散引用源码是下一层证据，不表示所有 GitHub 页面都属于本次 `/en/reference/` 抓取范围。

需要未列出的新扩展时先查 [来源索引](source-index.md) 和 live declarations。若确无 seam，明确设计 interface/provider/consumer 与清理/错误契约，再决定是否需要仓库变更。
