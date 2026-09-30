# 工具、hooks 与交互策略

依据：[Adding a tool](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool)、[Tools](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools)、[Execution pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline)、[Extension patterns](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook)、[Approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval)、[User interaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/user-questions)。精确内置参数看 [Tool catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-catalog)。

## 工具形状

使用 `ctx.tools.register(defineTool(...))`；`defineTool` 来自 `@deepseek-ai/dsh-tools`。下面示例仅展示纯工具的最小契约，实际项目核对类型与包版本后采用：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'example-text'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'example_text',
    description: 'Return the supplied text.',
    parameters: {
      text: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => args.text,
  }))
}
```

typed parameters 是属性映射，各字段用 `required: true`；参数根是开放对象。显式 object 节点必须声明 `additionalProperties`。输出用 `ValueSchemaSpec`，根可以是对象、数组、标量或 null；`execute` 返回该 schema 推导的 canonical JSON 值，`output.render` 再转换成模型内容块。

不要从 body 返回 `{ content, isError }` 冒充 typed output。用结构化字段表达成功的业务结果，即使其中包含非零退出状态；基础设施故障抛错，经 registry 规范化为工具失败。raw JSON-Schema `ToolDefinition` 可以直接注册，但输入校验由定义自己负责，不能假设 `defineTool` 自动覆盖它。

`defineTool` 校验可表达的参数与返回值；非空字符串、跨字段规则等仍需 owner 校验。值须为无损 JSON，不能包含 undefined、BigInt、循环、类实例等。注册后定义与 schema 被借用为 readonly，不修改 callback 或 schema；热替换先清理旧 effect 再注册。

body 使用 `exec.signal` 取消工作。`exec.arguments`、名称、call id、Agent、token 与 parent token 为固定身份；不要改写输入来绕过策略或令历史与实际执行不一致。调用 `exec.deferContext()` 时按当前类型核对，使用它将嵌套执行产生的上下文延后到合法的外层结果位置。

## 选对扩展点

| 需求 | API / event |
| --- | --- |
| 可组合的 allow/deny/ask | `tools/pre-execute` |
| 后续 listener 无法取消的最终拒绝 | `ctx.tools.guard()` |
| timeout、retry、执行期间计量 | `tools/execute` |
| 变更返回值、呈现内容或附加上下文 | `tools/post-execute` |
| 记录最终结果、审计、观察 | `tools/result` |
| 一致地隐藏工具：schema、查找、执行 | `ctx.tools.restrict()` |
| 成功 terminal tool 后结束当前 turn | body 的 `concludeTurn()`，按当前类型核对 |

管线顺序是 pre waterfall → monotonic guards → execute waterfall → post waterfall → definition `finalizeContent` → result 通知。waterfall 包装需返回 `next()` 的结果。只有 execute wrapper 的操作视图允许替换 signal，并在自己的生命周期内恢复；caller 的取消不能被解除。

post 的内容替换保留 canonical value，不是保密机制。要阻止程序获得敏感结果，block 或替换 value；替换 value 会重新验证并重算 renderer/meta。`tools/result` 接收到规范化后的不可变权威结果，只观察，不再改写。

PTC 自动把可见工具暴露为 `await tools.<name>(args)`，所有子调用仍走同一策略管线。程序得到最终 canonical value，失败抛真实 `ToolCallError`，不会返回需要解析的人类 prose。只改 system-prompt 中的 tools 列表不会约束可执行集合。

## 后台工作与呈现

长任务通过 `ctx.jobs.start({ kind, label, owner: exec.agent, run })` 注册，返回含 job id 的 typed handle。发布之前先完成 preflight；发布之后的工作使用任务拥有的取消信号，不能被已结束的外层 `exec.signal` 误杀。producer 提供同步 cancel、资源释放后才完成且不拒绝的 done，按需要提供 consuming readOutput。详见 [执行与自动化](execution-and-automation.md)。

`presentationMeta` 从 canonical value 产生可重放的结果事实。Host 的 `presentCall`/`presentResult` 必须是纯投影，无 I/O、时钟、随机或 Session 状态读取。界面格式不进入 canonical value。Web Client 不直接消费这些 Host presenters；专用 Web 卡片注册 `tool.call.toolview` 并读取 durable meta，详见 [客户端 UI](client-ui.md)。

## 权限、sandbox 和 plan

`ctx.approval` 只回答一次具体动作是否获准：仅 `allowed-once` 放行；rejected、cancelled、unavailable 都不放行。answerer 不拥有请求则委托 `next()`。approval policy 的 `never` 表示不进行询问并拒绝 ask，不等于允许所有动作。请求需要开放的 turn，审计由 approval service 写入。

[Permission presets](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/permission-presets) 组合 sandbox mode 和 approval policy；它自身不实现执行限制。`custom` 是推导显示态，不能作为切换目标。

[Sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox) 的 mode 约束文件效果，不涵盖网络/进程可见性。confined 模式缺少 backend 必须失败；partial enforcement 不能包装成 full。远程容器 execution world 是 filesystem/subprocess 等 seam 的替代，不天然是同机 argv wrapper 的实现。

[Plan mode](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/plan) 是软指导，执行限制仍由 sandbox/approval 实现。选中态可能 pending 到下一次被接受的 pre-step；不要在客户端按钮点击时直接假定 durable plan state 已变化。

普通提问通过 `ctx.userQuestions`，不要用审批事件替代。保留问题 id、选项 label、自定义回答和 skipped 的含义；无 provider 或取消是明确失败，不当作用户同意。

## 验证

测试代表性合法与非法参数、输出 schema、抛错、pre-denial、取消和 post 变换。嵌套 PTC 要验证策略仍执行且 value 无泄漏。涉及局部贡献时测试跨 Agent 隔离、重复注册、卸载重载。UI 事实必须能由持久事件重新构造。
