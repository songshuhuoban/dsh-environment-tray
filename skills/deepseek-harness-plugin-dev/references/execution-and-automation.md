# 执行能力与自动化扩展

读取本文后，按任务到 [来源索引](source-index.md) 打开对应 subsystem 的完整类型与 generated API。下面说明选能力和跨包约束，不代替某版本的 request/spec 定义。

## 文件、Shell 与 Subprocess

[Filesystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/filesystem) 使用 opaque targetKey/version 与 provider 的路径映射。远程 provider 的 target 不能用 Host 路径拼接解释；跨能力坐标用 `processPath`/`processPathFromHostPath`/`fileUrl`/`contains` 等公开方法。

模型 write/edit 调用除 fs provider 还依赖独立 observation policy。裸 provider 可以无 guard 修改，read-before-write/edit 由 fs intent events 的 listener 决策，不能宣称 FileSystem 天然保证它。guarded write 区分 createIfAbsent 与 replaceIfVersion，edit 在同一原子临界区验证 version 和执行 literal match。

存在、缺席和从未观察三种状态要分别处理；成功的窗口 read 可以授权 unchanged file，不存在所谓 full/partial observation 权限。`fs/observed` listener 是同步记录且不应抛错；它可能发生在文件已修改后。stat 不读内容，完整 readBytes 有明确 cap，lstat 用于 no-follow 信任边界。文件 syscall 没有可强制终止的 timeout 契约，按公开 signal 尽力取消。

[Shell](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/shell) 先从 request `resolve()` 到 fully explicit spec；stdout/stderr 保留 truncated/spill 事实。exitCode、signal、timedOut、aborted 独立，不能因退出码为 0 就宣称取消/超时后的成功。sandbox mode/错误按 [工具与策略](tools-and-policy.md) 处理。

[Subprocess](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subprocess) 的 cwd、executable、stdio 和资源限额由 spec 明确指定，argv 不经过 shell 字符串解释。backend 与 fs 必须处于同一个 execution world。consumer 拥有 deadline 的原因判定，provider 提供 exit facts、managed termination 和 awaited quiescence。

`DSH_*` 是 Harness 管理的子进程事实，provider 清除 ambient DSH_* 再合并显式 snapshot。shell 工具从 `ctx.shellEnv` 收集贡献；不要直接写 process.env 来模拟 registry。新 shellEnv key 的语法、reserved names 与重复规则读目标版本配置/API，别固化一份会漂移的禁止名单。

[PTY](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/terminal) 使用 `ctx.terminals` 和 subprocess terminal primitive，不能用普通 pipe spawn 冒充 controlling terminal。exact Agent ownership 用于访问和清理；PTY 字节保持进程内，模型调用和有界返回经正常 tool 路径持久化。

[LSP](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/lsp) 通过 provider 的规范化查询，不暴露任意 JSON-RPC。seam 坐标是零基 UTF-16，model-facing tool 转换一基游标；provider id/扩展名独占且原子注册，canonical workspace URI 用于位置解释。

## 后台任务、代码与工作流

[Jobs](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/jobs) 拥有 id、访问、status、owner cleanup 与 admission；producer 拥有资源。done 在清理结束后才 settle，cancel 不能仅改变 displayed status。访问基于 owner Session，cleanup/admission 基于 exact Agent，id 难猜不是访问控制。

readOutput 若 consuming 要明确语义，不能让两个读者无意抢同一 delta。终态 notice 的 reported 用于防止重复呈现，不是删除审计。发布后任务取消与 call 等待取消分开，参考 [工具与策略](tools-and-policy.md)。

[Code runtime](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/code-runtime) 运行程序与 Host async bindings；bindings args/results 为无损 JSON。run 的程序失败由结果字段报告，不等同 seam 调用抛错。区分超时、abort、异常和 substrate death；`isolation: worker-thread` 只是执行描述，不是安全隔离承诺。跨 run 不留状态，dispose 等待终止。

[Subagents](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent) 有多个命名 provider。start-time descriptor 与 live Agent 能力分别发现，需求超过能力时开始前明确失败。result、cancel、dispose、continuable child activation 各有契约，不能把“一次运行结束”等同“可续接 child 被删除”。

depth 取持久 header 与 runtime 的有效值，冷恢复不能降低深度。fork seed 仅来自平衡的已完成 turn 前缀，不复制尚未结束的 parent turn。child/message 权限从公共 runtime 路径实现，别用 service 内部 map 绕过 lineage/ownership。

[Workflow](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workflow) 的 meta/args 是 JSON 数据，script 才是代码，不能执行 script 来取得配置。parent 必需，provider/agent caps 是 consumer policy，不能由 script 偷改。fatal hook misuse 不作为 per-item null 成功吞掉。live run 在所有路径 dispose，result settled 后仍需 child quiescence。

Workflow durable display facts 与 observe-only snapshot events 区分，observer 不能获得 cancel/dispose handle。top-level run records 保持合法前缀，nested transport 不重复写；缺失 terminal at log tail 展示 interruption。

## 人类命令、目标与提醒

[Commands](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/commands) 用 `ctx.commands` 注册，直接作用于 exact Agent，不产生隐含模型回合。definition、descriptor、parsed input 与 handler result 分开；rawInput 保留 adapter 给出的后缀，discovery 不泄露 handler。

[Goals](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/goal) 用 durable goal/change 与 revision CAS 管理同 Session objective；process activation 不是 durable phase。continuation driver 调公共 Agent API，round 归属被接受的 user-message turn，不能通过计时器自增历史轮次。

[Schedule](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/schedule) 是返回原 Session 的提醒，并非通用 Cron 平台。当前协议支持 after、显式 at 与至少 300 秒 fixed-rate every；绝对时间要求 offset-bearing RFC3339 或显式 time_zone 的 local-calendar 对象。保存 canonical UTC，不从机器时区猜测输入。

每个 recurring record 独立推进；cold/busy 后只补最近一次 overdue occurrence，不能扩张成重放所有遗漏 tick。存在记录不表示能唤醒不可用 Session；按当前 live delivery 契约处理 scope 与恢复。

## Skills、Web 与 spill

[Skills](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills) 的 provider factory、list/get 与 scoped registry 有明确契约。发现摘要，不预载完整 body；full get 每次重读。incomplete snapshot 不能作为“所有技能删除”的权威结果。

local provider 优先级为 project-dsh、project-agents、custom、user-dsh、user-agents、bundled。同层 rank/order 处理冲突，最近 scope 的同名 skill 遮蔽更远层。只发现直接 bundle/flat entry，不支持任意深度递归 SKILL.md。

本 skill 使用 name/description 的通用 frontmatter，可放入 `$DSH_HOME/skills/deepseek-harness-plugin-dev`、项目 `.agents/skills/deepseek-harness-plugin-dev` 或已配置 custom root。Codex 的 `agents/openai.yaml` 是附加 UI 元数据，不是 Harness invocation policy。Harness 自身的 `disable-model-invocation`/`user-invocable` 是另一套 frontmatter 语义，按用户要求配置，不相互替换。

[Web](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web) search/fetch 共用 registry，但 provider contract 与工具 schema 分开。多个 available providers 需显式选择，不能按注册顺序挑第一个；available 是本地廉价判断，不能网络探测。fetch HTTP 404/500 也可为正常资源结果，网络/策略失败才按 WebError 报。

file sandbox 不限制 Web 网络。HTTP provider 的公网地址、DNS pinning、redirect、size 和 timeout 由其契约实现；替换 provider 时保持声明的网络限制，不因工具是只读就假定任意网络目的地获准。

[Spill](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/spill) 使用 `ctx.spillStore` 保存超出展示限额的内容，renderer 提供截断和可恢复事实，不能把截断结果标成完整。owner、索引与保存失败按 request/result 的现有字段处理。

## 验证

执行改动覆盖取消、子资源退出、owner disposal、跨 owner 拒绝、真实截断边界和 provider 替换。带 guarded IO 验证并发 stale/create races。涉及固定时刻或 schedule replay 时控制时钟与明确时区，避免靠实际等待测试。
