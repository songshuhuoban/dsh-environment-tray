# 会话、持久状态、设置与凭据

依据：[Sessions](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session)、[Persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence)、[Event catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/persistence-catalog)、[Projections](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-projection)、[Storage](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/storage)、[Settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings)、[Credentials](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/credentials)。

## Session 是事件源

Session 保存 append-only typed events，model history 由 surface 与 `deriveMessages()` 重建。`session/event` 是 Cordis 通知，payload 内的 durable type 不是一个可随意 `ctx.on(type)` 订阅的 Cordis event。

额外 durable 数据通过实际 owning module 的 `SessionEventMap` declaration merge（当前参考使用 `@deepseek-ai/dsh-session/types`）声明。log-only 事件没有 surfaceOp，不自动进入模型上下文；模型可见信息用已支持的 message 通道，不能只在内存 request 里插入。新增 surface 类型会影响所有 renderer、derivation、持久格式与迁移，不作为普通第三方插件的默认办法。

seq 是 append 顺序，surface replacement 后的模型位置不能以 seq 数值重新排序。compaction 的 start/end boundary 是 surface 位置跨度。事件 payload 必须无损 JSON；避免将临时对象、buffer、函数和进程句柄塞入日志。

append 遵守 turn/step enclosure；idle 写入的操作使用既有 standalone/owner API，先读相应契约，不自造 turn/start/end。Assistant 成功 settlement 保存 compact timed stream；失败/取消/重试可保存 assistant/attempt，live chunk 本身不持久化。硬崩溃发生在 settlement 前可能没有可重建流。

插件创建的 Agent 持有 `AgentHandle`，卸载时等待 dispose 到停止、unregister 和 scope 清理完成。不要把 MessageId 与某次 turn/end 强行配对取得“该 prompt 的结果”；队列可以跨多个请求与输入，返回 enqueue receipt 与整体状态各有契约。

## Persistence、projection 与 query

`SessionPersistence` provider 实现 create/open/stat/list/export 等当前声明的方法；handle 管理读取、append、flush 和 close。flush checkpoint 不能在 provider durability 之前报完成。stat/list 用 header 与 revision 做轻量发现，不因列目录扫描全部 event body。

当前 JSONL provider 在版本命名的 generation 中选最高规范版本；read open 可以内存迁移，write open 才验证并独占发布 successor。旧 artifact 保持不变，future format 必须拒绝。普通 third-party plugin 不修改全局 Session format version；若任务确为仓库格式升级，则按相邻 migration package 和官方格式教程实施。

`ctx.sessionProjections` 统一折叠 committed events；Host 读 `stateOf()`，client carrier 读裁剪的 snapshot。依赖 registry/key 的 owner 明确依赖或在访问时失败，不能缺席时默认为空从而覆盖历史。投影 cache 是派生 hint，不是真相源。

[Session query](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-query) 负责 provider-independent 搜索、lineage、bounded event reads 与关系追踪；使用其 typed filters、分页结果和 failure，不直接解析某个 SQLite provider 的表结构。

[Session references](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-reference) 负责文件 candidate、prepared message 与对应错误；通过该路径准备引用，不让 UI 任意字符串冒充已授权的持久附件。

[Titles](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-title) 使用 `ctx.sessionTitle` 的单 provider；辅助 LLM 请求按 title 记录契约保存，不伪造主对话消息。

[Telemetry](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-telemetry) 根据 capture policy 与 disclosed sharing 构造逻辑记录。`session-telemetry/record` waterfall 可脱敏，观察插件不能藉日志把秘密送往另一 backend。按实际同意与任务范围选择 capture。

## 插件领域数据

会话历史外的领域持久数据使用 Storage domain。`ctx.storage` 是 backend/form hub，不是单一数据库。backend 名称可并存，domain facility 负责 route selection。`defineDomain()` 定义名称、版本、table schemas 与 global slot；这里只用其实际要求的 schema 库，不能因其他配置使用 schemastery 就替换 domain 的 Zod 契约。

domain write 链先达到 backend durability，再改 authoritative memory，最后发 domain/changed。失败不更新内存；原子 read-modify-write 用 table update，不对 get 返回的对象就地修改。backend 单次写原子但不替调用方排序。consumer 持有 domain handle 并等待 close，provider 卸载还须关闭自己的底层 backend。

[Workspace](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workspace) 以 canonical path 建身份，但 Session membership 由持久 account 与 header cwd 联合验证。删除 workspace 注册不会删除目录或 Session 日志。不要为 UI 的目录展示复制一个不符合此契约的注册表。

## Settings 与 credentials

Settings resolution 是 schema defaults → composition base → user section。namespace 只放用户可编辑子集，profile/bundle wiring 仍属 composition config。`register` 归属 owner fiber；需要可选 settings 的 owner 用 `installSection` 并保留 fallback entry config。

写入先 schema/业务 validate，再持久化与 commit。外部非法编辑保留 last-good value；初次注册时没有 last-good，应明确拒绝。wire describe 必须 `redactSecrets: true`，revision 用于 expectedRevision compare-and-set；已脱敏 caller 用 mutate path ops，不以缺失的字段构造整节 replace。

CredentialRef 是环境变量式 reference，CredentialKey 是 plugin 记录 identity，不能混用。运行操作每次 `resolve(ref)`，不要跨操作缓存，空值视为 absent。配置 UI 只 `describe` 或 `describeRecord`，不调用 resolve/readRecord 再想办法遮罩。

read-only source 遮蔽 writable store 时 set/unset 必须拒绝，不能报告写入成功却继续使用旧值。record 刷新使用 `modifyRecord` 的串行 read-modify-write，不拆成竞争的 read + write；authorization attempt 的成功要在本次 attempt 内真正提交 record。

## 验证

验证 full replay 与 incremental fold 等价、fork/resume 与 seed boundary、崩溃尾部、read/write open 差别、异步 flush/close。配置/凭据检查 stale revision、external edits、secret 不出 wire 与 shadow 拒绝。仅涉及无状态工具时无需扩展成整套持久化测试。
