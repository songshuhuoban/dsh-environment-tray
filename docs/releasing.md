# 发布 `dsh-environment-tray`

插件的 npm 包名是 `dsh-environment-tray`，用户可见名称随界面语言切换：中文为 **环境变量管理器**，英文为 **Environment Variable Manager**。`dsh-environment-tray` 是 Cordis 行 ID，升级时保持稳定。发布包内有已构建的 Host 和 Client，可从 DeepSeek Harness 桌面客户端的**插件 → 添加插件**安装，安装者无需构建 TypeScript。

## 分工

GitHub 的 [`Release checks`](https://github.com/songshuhuoban/dsh-environment-tray/blob/master/.github/workflows/release-check.yml) 工作流只在 `master` 推送或 PR 时运行类型检查、测试、README 审计与 npm 打包清单检查。**它不发布到 npm，也不读取 `NPM_TOKEN`。** 发布由维护者在本机运行 `npm publish`，完成 npm 要求的浏览器验证或一次性验证码。不要把 npm token、OTP 或会话凭证写入仓库。

`0.1.0` 已由维护者手动发布到 npm，`v0.1.0` 标签指向发布记录中的 `gitHead`。此前的自动发布因 npm 返回 `EOTP` 而未成功，现已改为本机交互式发布。

`0.1.1` 适配 DSH `0.2.0-rc.2` 桌面客户端：启用插件时同步激活组件，新会话与已有会话都能使用右上角入口；新增中英文插件介绍，并精简用户 README、加入入口截图。README 面向普通用户，只说明在桌面版填写 npm 包名安装、入口位置和使用方法；发布记录及验证流程保留在本文，已发布版本以 npm registry 为准。

插件列表的名称和介绍来自随安装包发布的 `locale/en.json`、`locale/zh.json` 中的根级 `meta.title`、`meta.description`，不依赖客户端弹窗的语言注册。`0.1.0` 不包含这些文件，会回退为包名；已安装的旧包需要在桌面插件页面升级后才能显示中文。发布前用真实桌面 Host 验证两种语言的元信息，并检查打包清单包含两个语言文件，避免源码有翻译而安装包缺失。

`0.1.2` 统一插件显示名称与介绍：中文名称为「环境变量管理器」，英文名称为「Environment Variable Manager」，两种语言均说明环境变量、.env、凭据、Windows 用户级与系统级变量，以及会话右上角入口。npm 安装预览的回退介绍与语言文件保持功能一致。

## 后续版本发布

1. 确认 `package.json` 中的包名和版本。用 `npm view dsh-environment-tray version --registry=https://registry.npmjs.org/` 查看已发布版本；新发布必须使用从未发布过的版本号。
2. 更新版本和变更说明，提交源码及生成的 `lib/`，推送到 `master`。等待 GitHub `Release checks` 通过。`cordis.patch.yml` 的包名与 `tsdown.config.ts` 的客户端 bundle ID 应保持一致。
3. 在准备发布的提交上，本机执行 `pnpm install --frozen-lockfile` 和 `pnpm run release:check`。打包清单检查使用 dry-run；确认中英文介绍及 README 截图随包发布，插件介绍应说明「新会话或已有会话 → 右上角 → 环境变量双滑杆图标」。在桌面客户端验证立即启用、新会话和已有会话打开弹窗，以及中英文介绍；源码构建成功不等于桌面集成验证通过。
4. 用有该包发布权限的 npm 账号登录官方 registry：`npm login --registry=https://registry.npmjs.org/`，并用 `npm whoami --registry=https://registry.npmjs.org/` 确认账号。在仓库根目录运行 `npm publish`，按 npm CLI 提示完成浏览器验证或输入一次性验证码。`prepublishOnly` 会重跑发布检查，`prepack` 会重建 `lib/`。
5. 用 `npm view dsh-environment-tray@<版本> version --registry=https://registry.npmjs.org/` 确认发布成功。然后给**刚发布的提交**创建对应版本标签，并推送标签。更新本文的发布状态，再按 README 的桌面客户端步骤填入 `dsh-environment-tray` 安装验证。升级测试需先卸载旧版，再安装新版；DSH 的桌面 `desktop` 与命令行 `web` profile 相互隔离。

如果 npm 返回 `EOTP`，不要在 CI 重试同一 token；改在维护者本机完成 npm 的交互式验证。npm 的具体 2FA 要求取决于账号、包设置和凭证类型；这里采用人工发布流程。参考：[npm 发布和 2FA 要求](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)、[DSH 桌面插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-plugin-manager/README.zh.md)、[DSH 插件展示元信息](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)。
