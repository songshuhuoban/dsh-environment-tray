# 模型适配器与上下文

依据：[Adding an LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-an-llm-adapter)、[LLM streaming](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/llm-streaming)、[Agent lifecycle](https://deepseek-harness.github.io/deepseek-harness/en/reference/agent-lifecycle)、[Core](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core)、[System prompts](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/system-prompt)。

## LLM adapter

继承 `LlmAdapter` 实现 `stream(options): AsyncIterable<StreamChunk>`，插件声明依赖 `llm`，通过 `ctx.llm.registerAdapter(providerRoutes, adapter)` 注册。重复 route 抛错，多 route 一次注册应全成功或全失败。model id 由请求送入 adapter，模型目录是提示性 metadata，不是允许列表。

协议要逐项满足：usage 在 finish 前；finish 后不再产生任何 chunk；block index 按首次出现分配，同 block 后续 delta 复用；tool arguments 保留原始 JSON 字符串片段；tool id 与 result id 正确关联。provider 若最后才发 usage，缓冲结束信息后按契约输出。

transport/protocol 故障以 `LlmError` 抛出，provider 的 in-band failure 可按契约生成 error/aborted finish。两类失败与正常结束分开，不吞错误伪造成功。传递 `options.signal`，不支持的 GenerateOptions 明确拒绝，而非静默丢弃。

`resolveModel()` 返回当前 provider/model 的可核实身份和可选容量、reasoning metadata，支持取消。reasoning id 是 adapter 定义的有序 opaque 值，不擅自改成某家的 wire spellings、截断或 clamp。没有 metadata 不代表 model 不合法。

若 provider 要原生 response id/signature 等才能续接，finish 的 replayState 只保存必要的无损 JSON，恢复时校验。运行时只在历史 route 与目标 route 当前由相同 adapter 实例拥有时传递；provider/model 同名本身不能证明状态可复用。

调用路由与可用能力以实际 prepared call 为准。loop 的 `prepareCall()` 绑定一次注册，连接 model resolution、header 和 dispatch，不能在插件里又独立 lookup 出不同 provider。直接使用 LlmRuntime 的公开流接口，避免缓存已卸载 adapter。

凭据使用 credential reference，按每次模型请求重新 resolve，详见 [会话与存储](sessions-and-storage.md)。不要为一个 adapter 发明额外的隐藏密钥文件协议。

## Prompt 与动态 context

稳定规则注册 `ctx.systemPrompt.section({ name, order, text })`；变动状态适合 `ctx.systemPrompt.context(...)` 的 cache-safe runtime snapshot。仓库内 section/context order 使用所属命名 allocation；独立包选择明确、有限的 order 并验证相邻位置。

scoped contribution 会遮蔽同名 global contribution；同层 duplicate 抛错。prompt variable 取值缺席而模板引用它时会失败。`complete: true` 是整个 prompt 的替换，最多一个有效贡献；别把附加说明标成 complete。

`system-prompt/assemble` 是全 assembly transform，返回值权威。只有确需整体改写时使用，并保留下游 PTC/structured-output 贡献。工具过滤使用 `ctx.tools.restrict()` 保持 schema、lookup、execution 同步。

渲染的 system prompt 经 `system/message` 成为历史，不直接插到私有 request 字段。新系列、surface replacement 与 route 的 prompt-update capability 会影响缓存与 prompt 合并；不要自行重排旧消息修缓存。

`agent.inject()` 提供下一次被接受请求的持久 context，但不唤醒 idle Agent。需要启动/追加用户回合用 `followup()`，需要当前运行阶段 steering 用 `steer()`，参数按当前 UserMessage 工厂与类型构造。不能以注入成功推断模型已经看到了内容。

## Agent hooks 与恢复

`agent/pre-step` 处理 claimed input，决定 enter/reject；包裹 downstream decision 时保留 `startsRequestSeries` 等字段。`agent/request` 修改调用 envelope，不能秘密改 model-visible messages。`agent/turn-stopping` 是 serial，没有 next，可经公共 Agent 接口追加工作。

准备 request 期间的取消不应抢先提交 system 或 users。request-error 重试不重新执行普通 input admission/assembly；不要在这些 hooks 中重复追加 user message。普通驱动提交的持久事实与 transient stream 分开消费。

[Compaction](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction) 通过既有 seam 处理。summary 的 log-only 记录与实际 user/message surface replacement 不是一件事；range 以 surface 位置解释，不能把 seq 当位置排序。自动 pressure 与 canonical overflow 的触发/恢复由 provider 管理，只有 surface 真有进展才重试。

[Token meter](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/token-meter) 返回带 logRevision 的 detached measurement。按照 route 的 image pricing、相同 envelope 的 usage anchor 和 positional surface 定价，不把字符数冒充精确 token 或默认所有模型容量相同。

## 验证

adapter 覆盖文本、reasoning、交错 tool deltas、usage/finish 次序、原生 replay、取消、malformed stream、不支持参数和 route 重载。模型可见变化验证日志重建出的 request、scope 与重试行为。实际 provider 检查按项目政策和任务授权执行，区分协议单测通过与 live integration 已验证。
