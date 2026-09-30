# 桌面版插件安装与通信

核对日期：2026-09-30（Asia/Shanghai）。版本基线：[0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)，源码提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。后续版本先核对实际应用与相同版本源码，不能把本文当成永久的“最新版”契约。

## 安装、启用与升级

下载安装的 Desktop 自带匹配的 Harness、Node 与 pnpm。用户从左侧栏 **插件 → 添加插件 → 包名或地址** 输入实际的 npm spec（可带版本）、Git 地址、压缩包或本地绝对目录，点击 **安装**，成功后点击 **立即启用**。安装 UI 先以 `enabled: false` 安装；关闭成功对话框会保留已安装但未启用的组合包。

组合包开关选择 `dsh.profile.bundles` 中的层；组件开关分别修改该行的 `disabled`。因此 **立即启用** 不会覆盖 bundle patch 内的 `disabled: true`：这种包还需进入详情打开组件开关。编写新 bundle 时明确默认组件状态，不要让普通用户安装后还需要猜第二个开关。

当前 UI 说明插件暂不自动更新；升级经插件页面卸载旧版，再添加明确版本的新 spec。本地目录必须已经包含可加载的 Host 输出、Client factory bundle 与 patch，不能把仅有 TypeScript 源码的目录当成可安装成品。通常 HMR 会在交易完成前重组；以返回的激活状态为准，仅在提示需要重启时要求重启。安装成功、组合包启用、Host 行 active 与 Client 入口可见是不同的验证事实。

Desktop 独占 `$DSH_HOME/profiles/desktop`。CLI 与 Desktop 可以共享受支持的产品数据，但不共享可执行包、插件激活、锁文件或 `node_modules`；该 profile 不向 CLI profile 查找暴露。面向桌面用户的安装说明使用应用内入口，不要求先安装全局 CLI、Node 或 pnpm，也不让 `dsh plugin --profile web add ...` 修改另一个环境。

DSH 在安装和加载组合入口检查 `peerDependencies` 中的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 范围，按唯一运行时版本比较并包括预发布版本；`engines.dsh` 不参与这道检查。遇到 `incompatible-version` 先核对实际使用的 API 与声明范围，不能用删除 peer 或新增豁免掩盖未验证的兼容性。版本豁免需要用户对精确插件/运行时组合明确授权，普通修复不隐含这种授权。

依据：[插件管理页面](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-plugin-manager/README.zh.md)、[插件管理服务](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/plugin-manager/README.zh.md)、[Desktop 状态归属](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/README.zh.md)、[Profile 兼容性](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/README.zh.md)。

## 应用 origin 与 Host 通信

Desktop 页面使用 `dsh-app://app/`，静态资源由应用提供，其他路径经桌面壳转发到它持有的 Web Host。壳交换 Host 启动 token，保存并向转发请求加入 Host cookie；renderer 的 hostname 不是 `localhost`，cookie 也不由插件管理。Client 继续声明 `dsh.client.platform: "web"`，通过现有 lazy CommonJS loader 挂载 `./client`。

- 已有业务操作调用生成的 `ctx.remote.<namespace>`，按声明注入依赖，不另造 JSON wire envelope。
- 确需自有普通 RPC channel 时，Host 的 `ctx.connection.rpc.handle('/<channel>', handler)` 与 Client 的 `ctx.connection.rpc.call('/<channel>', '<endpoint>', payload, signal)` 成对使用。Host handler 返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`；Connection 管理认证、correlation 与 envelope。此版本的自有 channel 注册还使用 WebServer，不能推广为所有无 WebServer carrier 均可用。
- 非 RPC 的下载、raw body 或 `Response` 通过 Host 的 `ctx.connection.fetch.register()` 注册精确 `/api/` 路径。声明 `methods`（`GET`/`HEAD`/`POST`）、`requestBody`（`buffered`/`streaming`）与 `fetch(Request): Promise<Response>`；注册归属调用 fiber。Client 使用页面相对 URL，例如 `fetch('api/my-plugin/status', { signal })`，Client `ConnectionHandle` 没有 `fetch` 方法。
- 不拼接内部 Host 的随机 localhost 端口，不读取 renderer cookie 或手动添加 launch token，不以 `location.hostname` 是否 loopback 拒绝桌面。需要本机权限分类时核对 `ctx.connection.isLoopback` 的平台语义；它不是认证替代品。
- 旧 WebServer route 并非自动获得 Connection 的认证；保留时要通过当前 Connection 的 admission 并完整管理响应。新增动态功能优先进入已认证的 `/api` registry，测试取消、卸载与 Host 重连。

依据：[Desktop protocol 分派](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/main.ts)、[Host 认证及请求转发](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/web-document.ts)、[Connection 契约](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/rpc.ts)、[Host registry 实现](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/rpc-host.ts)、[Client Connection](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/connection/src/client/index.ts)。

## 插件介绍与配置入口

已安装的卡片、详情和组件行读取 `locale/en.json`、`locale/zh.json` 中的 `meta.title` 与 `meta.description`；缺失字段分别回退到 manifest 名称/描述。保留 `en.json` 作为发现入口，合并 `exports["./locale/*.json"]`、`exports["./package.json"]` 并把 locale JSON 加入 `files`。安装预览仍读取 `package.json.description`，因此更新插件介绍时按需求同时维护这两处。

描述要告诉用户功能入口的实际位置。例如环境变量插件的入口为 **新会话或已有会话 → 页面右上角的环境变量双滑杆按钮**。其他插件按最终 slot、图标与按钮文案描述自己的入口，并核对未创建 Session、空白 Session 和已有消息的 Session 三种状态；不要把“启用后生效”当成用户能找到入口的说明，也不要为未注册的设置或侧栏入口编造导航路径。面向普通用户的 README 只保留桌面安装、使用与入口说明；开发和发布流程另存文档，已发布插件直接填写 npm 包名安装。

此版本的 **设置 → 内置插件** 展示清单与状态。自带配置插件使用插件页面子槽：`plugins.item`（list，官方独立项）、`plugins.bundle.config`（key 为包名）、`plugins.row.config`（key 为 `<包名>#<patch 行 id>`）。配置 slot 由页面 owner 延迟声明，贡献用 `ctx.slots.inject()` 管理；页面 API 与表单 props 仍要按目标源码核对。

依据：[展示元信息格式](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)、[插件页面配置槽](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-plugin-manager/README.zh.md)。
