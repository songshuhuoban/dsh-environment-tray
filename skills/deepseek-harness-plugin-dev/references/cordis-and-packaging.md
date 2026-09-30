# Cordis、生命周期与包组合

主要依据：[Architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/)、[Primer](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer)、[Context](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/context)、[Registry](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/registry)、[Fiber](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber)、[Events](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/events)、[Service](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/service)、[Scopes](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/scope)。

## 插件与服务

Cordis 接受函数、`{ apply }` 对象及 `Service` 子类。常见 npm 入口导出 `name`、`inject`、`apply(ctx, config)`，需要配置校验时导出符合标准 schema 的 `Config`。`Service` 子类通过 `super(ctx, serviceKey)` 提供服务；普通插件可用 `ctx.provide()`。声明合并用于暴露类型，服务注册用于提供运行时实现，两者不能互相替代。

必需服务进入插件的 `inject`。`ctx.inject(deps, callback)` 是一个依赖服务的子插件：服务换代时卸载并重新调用 callback，必须使用回调获得的 context。`ctx.get(name)` 在当前参考中允许不经 inject 的低级查询，缺席返回 undefined；它适合明确的诊断或可选查询，不负责消费端的依赖生命周期。旧版本或项目自行声明的接口可能不同，应核对实现。

`ctx.extend()` 创建子 context；`ctx.isolate(serviceKey, label)` 改变服务解析域；`ctx.intercept(serviceKey, config)` 给下方消费者叠加服务配置。它们用途不同。服务替换通过组合/隔离完成，避免直接覆盖他人提供的服务。`ctx.set()` 仅允许提供该服务的 fiber 使用。

## 效果与事件

`ctx.on()`、`ctx.provide()` 以及明确记录为 effect-based 的业务注册会跟随调用 context 清理。手动 API 返回的裸 disposer 则纳入 `ctx.effect()`，先查其所有权契约，避免重复注册或遗留资源。效果按反向顺序拆除；异步 disposer 可等待。启动错误经 fiber 暴露，不应一律吞掉；仅按产品需要为可选功能降级。

| dispatch | 行为 |
| --- | --- |
| `emit` | 同步通知，不等待返回值 |
| `parallel` | 并行调用，等待所有 listener 结束 |
| `serial` | 依次等待，遇到 bail 值结束 |
| `bail` | 同步寻找第一个 bail 值 |
| `waterfall` | listener 包裹后续调用，`next()` 委托并返回后续结果 |

waterfall 是否异步取决于事件返回类型；不能因 dispatch 方法本身不是 async 就不等待 `next()`。观察/包装时保留下游结果，只有负责决策的 listener 才短路。`prepend` 会改变次序，只在契约确有需要时使用。事件声明及 `@mode` 应与 dispatch 一致。

Agent 局部工具、提示词和策略从 `agent.ctx` 注册，visibility 与清理归属同一 scope。`dsh-scope` 是库而非 `ctx.scope` 服务；使用其现有载体和工厂，不自建第二套全局 scope 路由。

## 独立 npm 插件

先检查目标版本的可用依赖和 loader 解析方式。一般需要 ESM Host 输出、对应 `exports`、类型声明和正确的 `files` 清单。Cordis 与其他需共享身份的 Harness 包按消费者实际版本声明兼容 peer，构建用 dev 依赖匹配；不要为复用 UI 打包第二份 React 或 Cordis。

需要作为 bundle 安装时，`package.json` 的 `dsh.bundle.patch` 指向随包发布的 patch。例如下面是新增插件行的形状，名称由实际包决定：

```yaml
- insert:
    - id: my-plugin
      name: my-dsh-plugin
```

有 Client 半边时增加 `./client` export 和 `dsh.client` 元数据，具体 bundle 契约见 [客户端 UI](client-ui.md)。不要因已有 Host 行又人为添加一条重复 Client Host 行。

仅目标为 CLI Web 且请求包含安装时，按 CLI 的当前帮助确认命令，常见流程为 `dsh plugin --profile web add <package-or-local-directory>`，然后检查 `dsh --profile web --dump-config`。本地包采用何种 link、bundle 列表何时重读、是否需重启由版本与 profile 决定。下载安装的桌面应用走 [桌面版安装与通信](desktop.md) 的插件页面，不能通过全局 CLI 安装到另一个 profile。

## Profile 与 patch

组合顺序为：profile 中列出的各 bundle → profile 自身 patch → Harness home patch → `--patch` 覆盖。配置 patch 按行 id 定位；替换 `config` 是整块替换，不是任意深度合并。为新行选稳定唯一 id，确认插件被插入到正确的域、依赖 provider 已存在。

CLI 应用由 `dsh` 和命名 profile 启动。`web` 支持 live patch；已发布的 headless、SDK、ACP profile 为启动时一次组合。Desktop 使用保留的 `$DSH_HOME/profiles/desktop`、精确绑定的 Harness 版本和应用内插件交易流程；它不向 CLI profile 查找暴露该目录，不共享 CLI 的可执行包、激活配置、锁文件或 node_modules。HMR 是否即时应用按目标组合与管理结果核对。

## Monorepo 内置包

只在 Harness 仓库内使用 [Adding a package](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-package) 的 root aggregates、vendor project references、共享构建 preset、版本一致性与发布约束。独立包没有这些内部路径。

按角色决定 Service Definition、Provider、Consumer 是否拆包；只有存在可替換契约时才设计 seam。普通库、组合包和单个功能服务不应为形式统一强行拆成三包。Host/Client TypeScript 图遵循仓库的分阶段规则，普通包不复制 `api/remotes` 的特殊 split。

README 描述包所拥有的 API、事件、模型可见内容、token/KV cache 变化及真实限制。`./invariant` companion 按该仓库约定实现；仅断言自己拥有的可观察事件/数据关系，不把依赖方法存在性写成运行时 invariant。生成 catalog 与文档使用所属生成器，不能手改生成区。

检查公开入口、发布文件、类型消费和真实组合；不能仅从源码 import 成功就认定 npm 包可用。
