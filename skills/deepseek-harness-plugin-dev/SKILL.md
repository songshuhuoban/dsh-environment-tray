---
name: deepseek-harness-plugin-dev
description: 为 DeepSeek Harness（dsh）创建、修改、调试和审查 Cordis 插件，包括桌面版安装兼容、npm 包与 profile/bundle 组合、工具与 hooks、模型适配器、设置和 Web/桌面客户端扩展。用户提到 Harness plugin、dsh 插件或上述扩展时使用；不用于 Codex 的 .codex-plugin 插件或独立 DeepSeek API 调用。
metadata:
  reference-reviewed: "2026-09-30"
  desktop-reference-version: "0.2.0-rc.2"
---

# DeepSeek Harness 插件开发

把需求落实为可加载、可卸载、与目标 Harness 版本匹配的插件。用公开服务、事件和客户端扩展点组合行为。以目标项目的源码、类型声明和运行配置核对官方参考，避免凭记忆编造 API。

## 开始工作

1. 读取项目指令、`package.json`、锁文件、构建配置、插件入口和已有测试。确定是独立 npm 插件还是 Harness monorepo 内置包；确认目标是下载安装的桌面应用、CLI Web 还是其他嵌入环境，再确定 Host、Client 与实际 profile。
2. 查看目标环境版本及必要的包声明。桌面任务从应用版本或对应发布源码核对，不用全局 `dsh --version` 代替桌面版本。仅 CLI 任务按需要使用 `dsh --version`、`dsh --profile web --dump-config` 等只读命令；没有 CLI 时直接检查依赖，不为读取版本启动应用。
3. 先读 [Cordis 与包组合](references/cordis-and-packaging.md)，再按下表选相关文件。一般任务只需一到三个参考文件。
4. 对要调用的服务方法、事件签名、slot 键和配置字段，在已安装 `.d.ts`、相同版本源码或当前官方页面中核实。网页随主分支更新，本 skill 的核对日期不是最低兼容版本。

| 需求 | 读取 |
| --- | --- |
| 下载安装的桌面版、插件安装/升级/启用、应用 origin、兼容性拒绝、插件介绍 | [桌面版安装与通信](references/desktop.md) |
| 工具、输入输出 schema、PTC、hooks、权限、用户提问 | [工具与策略](references/tools-and-policy.md) |
| 浏览器 bundle、Slots、设置卡、Remote、Chat 节点、右侧栏 | [客户端 UI](references/client-ui.md) |
| LLM adapter、提示词、模型上下文、重试与压缩 | [模型与上下文](references/model-and-context.md) |
| Session 日志、投影、查询、持久化、Storage、凭据、Workspace | [会话与存储](references/sessions-and-storage.md) |
| 文件系统、Shell、Subprocess、PTY、后台任务、子代理、工作流、定时提醒、skill provider | [执行与自动化](references/execution-and-automation.md) |
| 不确定扩展点；需要查其他服务或生成式目录 | [能力路由](references/capability-routing.md)，必要时查 [来源索引](references/source-index.md) |

## 实现时保持的边界

- 必需服务通过 `inject` 声明；可选服务用 `ctx.inject()` 管理出现、替换和移除。不要用定时等待模拟依赖加载。
- 注册与外部资源归属插件 fiber 或明确的 Agent scope。使用 Cordis 管理的 disposer；自建监听器、文件 watcher、进程和订阅要有可等待的清理。
- 区分持久 Session 事件、进程内 `agent/*`/能力事件，以及传给模型的历史。新的模型可见信息必须经日志支持的通道进入。
- 一次 Agent 专属贡献从 `agent.ctx` 注册。服务隔离、注册可见性和资源生命周期分别核对，不能把修改全局注册表当成局部配置。
- Host 拥有业务状态、校验和变更顺序；Client 模型拥有镜像与订阅；组件通过派生 props、observable hooks 和回调交互。跨 feature 包使用服务与 slots，运行时共享只使用明确的静态公共包。
- 最小示例说明 API 形状。实际依赖、类型导入、构建输出与权限配置以目标版本为准；本地项目约定不要提升为所有插件的规则。

## 完成与验证

完成源码、声明、exports、实际发布文件和组合配置。按改动验证：静态类型与构建；插件真实注册和卸载；新增工具的参数/结果、取消与策略；UI 的 owner 重挂载及历史重放；涉及持久化时再验证恢复、冲突和迁移。

独立插件运行自身脚本并检查打包清单。桌面目标按桌面插件页面验证安装、组合包与组件启用、入口可见及通信，不以 CLI Web 成功代替桌面验证。monorepo 包遵循仓库测试政策和现有 `doc-sync`、constraints、typecheck、lint、build、hygiene 等门禁；不要向独立插件套用不存在的根命令。生成式目录通过所属生成器更新。

报告交付文件、扩展点、已执行的检查和未验证的集成条件。仅当请求包含安装、启用、重启或发布时操作相应目标；编写插件本身不意味着要改变正在运行的用户环境。

## 查阅与更新文档

官方入口：[Reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/)。[来源索引](references/source-index.md) 分别记录 2026-09-28 抓取的 68 个参考页面，以及 2026-09-30 核对的 `0.2.0-rc.2` 桌面源码；细节按任务读取，不默认载入全部目录。

附带的 [reference_docs.py](scripts/reference_docs.py) 只依赖 Python 标准库。命令相对于本 skill 目录执行：

```sh
python scripts/reference_docs.py refresh
python scripts/reference_docs.py list
python scripts/reference_docs.py read subsystems/tools
python scripts/reference_docs.py search presentationMeta --limit 10
```

`refresh` 递归读取官方 `/en/reference/` 范围内的页面，将正文保存在系统临时目录；输出下载失败和 404 链接数量，不改业务项目或 skill。`read`/`search` 使用缓存，输出中的抓取时间用于判断新鲜度。网络不可用时用来源索引打开必要的官方页，或使用目标环境的声明与源码；明确无法核对的版本事实。
