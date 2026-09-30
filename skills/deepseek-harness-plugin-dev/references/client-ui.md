# Web/桌面客户端、设置与通信

依据：[Web Client](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client)、[Client Modules](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules)、[Slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots)、[Settings card](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card)、[API Gateway](https://deepseek-harness.github.io/deepseek-harness/en/reference/api-gateway)、[Typert](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/typert)。

## 双面包与 bundle

Host 和 Client 是两个 Cordis 环境。Host 入口提供业务服务；浏览器入口通过 `exports["./client"]` 与 `dsh.client.platform: "web"` 发现。桌面版也复用这个 Web 客户端平台，不应另造 `platform: "desktop"`。桌面 origin、安装与启用差异见 [桌面版安装与通信](desktop.md)。`dsh.client.inject` 是包依赖边，Cordis `inject` 是服务依赖；不要把 slot 键、服务名和 npm 包名混成一套标识。

浏览器 loader 使用 lazy CommonJS factory table。加载脚本注册 factory，materialize 时同步 require 依赖；普通浏览器 ESM 输出或裸 CJS 文件都不能据此认为是有效 bundle。仓库内使用共享 `clientBundle` preset；参考没有提供独立包可直接导入的已发布 preset。外部包需依据目标 loader 复现 factory 包装，并用真实 loader 或同契约测试运行构建产物。

Host 组合 boot graph 与 revisioned `/plugins` combo URL。包 id 使用 owning manifest 的 package name。已装包的 manifest/导出元数据可能缓存到重启；bundle 字节变化通过 `rebuilt(id)` 更新 graph，开发 watcher 是否挂载是另外的组合事实。不要宣称所有修改都会自动 HMR。

React、Cordis 等公共身份应使用目标平台种子/受支持共享模块；核对 bundle 中所有外部 specifier。跨 feature 包只 `import type` 声明，业务协作用注入服务，界面用 slots。`dsh.client.external` 不是绕过 purity 边界的捷径。

## Slot 扩展

先从当前 SlotMap 或 live inspect 核对目标键的 owner、cardinality、scope 与 props。其他 feature 的子槽通过 `ctx.slots.inject(key, callback)` 等待 declaration；callback 中 `ctx.slots.register(metadata, Component)`，这样 owner 被卸载后贡献会同步清理，重挂时恢复。

| cardinality | 扩展方式 |
| --- | --- |
| list | 新增唯一 `id`，通过 `order` 排序 |
| keyed | 注册 `key`，由 owner 的 entryKey 分派；占用现有 key 会替换 |
| single | 优先级赢家；想添加多个元素需另一个 list/child slot |
| chain | 纯 `select(owner)` 返回匹配值或 null；按 priority 选第一个 |

`root` 是唯一由 `ctx.slots.renderSlot()` 直接渲染的内置槽。子槽由声明它的组件通过授权 render props 渲染。只在真正拥有该位置的组件声明 children，不在外部 feature 抢占 declaration。

组件 props 通过 `PropsRuntime<K>` 及相关组合类型派生；组件不收到 ctx。services 留在 apply closure，用 registration `inject` 投影数据、回调及 bare observable。`hooks: { status }` 由 renderer 转成 `useStatus(selector)`；保持 source 与未变 snapshot 的身份稳定，不在 feature 内另建框架 hook 绑定。

常见位置需按版本确认：`conversation.session.header.utilities` 放会话工具入口，`conversation.session.header.actions` 放动作，`settings.plugin.item` 以 namespace 为 key，`tool.call.toolview` 以 wire tool name 为 key。头部按钮、设置卡和右侧栏是不同产品位置，按需求选择。

`0.2.0-rc.2` 的 Session 工具区在空白会话中会被 `hideChrome` 隐藏；未创建 Session 时连 Session header 都不会挂载。需要新会话也能访问的全局功能，可使用始终渲染的 `conversation.header.leading`（single、root scope），再按产品位置布局。先核对 single slot 是否已有 occupant，避免替换原生侧栏等控件；同时验证未创建 Session、空白 Session、已有消息和状态切换。依据：[ConversationHeader](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx)、[ConversationSessionHeader](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx)。

## 设置卡

先核对目标版本的配置宿主：`0.2.0-rc.2` 的自带配置插件使用插件页面的 `plugins.item`、`plugins.bundle.config` 或 `plugins.row.config`；设置中的插件清单为只读。具体 keyed 身份、展示元信息与来源见 [桌面版安装与通信](desktop.md)。下述 settings namespace/card 指南用于仍提供这些契约的版本或自有配置宿主，不据此把新插件配置放进只读清单。

同一个包提供 Host settings namespace 与对应 Client keyed card，key 拼写必须一致。拥有 entry config 的 consumer 优先使用目标版本的配置注册 API；`settings.installSection(owner, ns, schema, entry, hooks)` 等旧参考签名需先核对，settings 缺席时仍可使用组合 config。按 [会话与存储](sessions-and-storage.md) 保持 defaults → base → user 层次。

浏览器通过 `ctx.settingsScope.bind({ namespace })` 的 scope 读取 value/base/user，`set` 与 `unset` 带读取时的 revision。override 取决于 raw user 层是否拥有 key，不取决于值是否相同。卡片负责自己的 UI 和 staging，不能运行时导入另一个 feature 的 card chrome。

secret role 字段只写不读。基于脱敏 descriptor 的编辑用 path ops，不能根据不完整值 wholesale replace，否则会删掉未返回的密钥。`applies: 'restart'` 是时机提示，owner 自己负责是否监听变化。

## Host API

已有业务 RPC 使用 generated `ctx.remote.<namespace>`。实际调用者按目标版本声明 `remote` 与 `remote.<namespace>` 依赖。新 Host Remote 需要协议声明、严格生成 artifacts 和 Client composition 显式选择贡献；仅添加 decorator 不会让浏览器自动发现方法。

Typert unary method 要求 public、非静态、非泛型、具体实现，参数为必需的简单名称，不能用 optional/default/rest/destructure。可选性表达在值的联合类型中。Host final `signal: AbortSignal` 是 out-of-band 取消，生成的 Client 允许 optional final signal。

对象通过 `TypertLookupMap` 的 wire identity 映射；scoped receiver 通过 Context provider 解析。静态声明与运行 provider 都要存在。根应用先 Host build 生成 `./typert` 与 `./remote`，再 Client build 消费；SRC fallback 只缓解 Host dispatch，不生成客户端 codecs/types。

逻辑 stream、游标分页与实时状态使用对应 stream 协议，不塞进 unary descriptor。Connection 拥有 carrier、代际与信任边界；普通通知不重放，stateful domain 应有 snapshot/cursor/query。

需要文件下载或 browser-native response 时使用当前 Connection 的 exact Fetch route。`0.2.0-rc.2` 的 Host 使用 `ctx.connection.fetch.register({ path: '/api/<owned-path>', methods, requestBody, fetch })`，Client 没有对应的 `connection.fetch` 方法。若确实贡献 [WebServer](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-server) route，owner 负责鉴权与完整 response 生命周期：WebServer 自身不带认证或 Origin 策略。当前桌面版将应用 origin 的动态请求转发到自有 Web Host，插件应使用页面相对 URL；其他无 WebServer 的 carrier 必须另核对支持范围。不要用浏览器 hostname 是否为 loopback 来拒绝 `dsh-app://app/` 的合法桌面请求。

## Chat 节点、右侧栏与资源

[Conversation](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/conversation) 的业务节点由 `ConversationNodeDefinition` 相关契约关联稳定 `(kind, id)`、折叠事件 State、投影 target node，再注册 keyed renderer。使用 Session 已有 event window，不另开一条历史 stream 或扫描 DOM。live chunks 与持久 compact Assistant settlements 的最终显示必须一致；分页 prepend、replace、registry rebuild、缺失 terminal record 都需可重放。

工具 Web 卡片从 `ToolCallBlock` 与 durable result.meta 校验并派生 props，畸形/旧数据回退 generic。Host 的 presentCall/presentResult 不能自动生成 Web 专用卡片。

[Right Sidebar](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sidebar-right) 扩展有两半：tab type definition 与以 definition.id 为 key 的 body slot。definition.id、kind、content address 含义不同。导航用 `openResource` 或 `openTab`，不要操作内部 dockkit。布局是 Session 内存态，不能承诺页面刷新后保留 tabs。

[Client Resources](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-resources) 按 `dsh-resource://` protocol 提供流式元数据。provider 在 effect 内注册，返回 baseline 后发变更，遵循 signal。失败为 `ok:false` frame，消费者保留 last-good value 并显示失败。内容通过所属 Host 服务读，file address 携带授权 Session，不借用当前 UI 选择来补缺失身份。

## 验证

检查发布后的 factory artifact、module id、所有 externals、Host/Client 发现与依赖等待。测试 slot owner 卸载重挂、无 Session、Session 切换、设置冲突、取消和 reconnect。涉及 Chat/card 的修改同时测试 live 与历史 replay，不仅看页面能打开。
