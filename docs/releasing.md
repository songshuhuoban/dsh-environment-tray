# 发布 `dsh-environment-tray`

插件的 npm 包名是 `dsh-environment-tray`，用户可见名称是 **DSH Environment Tray（环境变量管理器）**。`env-manager` 是现有 Cordis 行 ID，升级时保持稳定。npm 包随附构建好的 Host 与 Web Client，用户安装时不需要允许构建脚本。

## 发布凭证

GitHub 仓库是 [`songshuhuoban/dsh-environment-tray`](https://github.com/songshuhuoban/dsh-environment-tray)。工作流从仓库 Secret `NPM_TOKEN` 读取 npm 发布凭证，并在 `npm publish` 步骤作为 `NODE_AUTH_TOKEN` 提供给 npm。发布者本机的用户级环境变量不会自动进入 GitHub Actions，需将其值单独保存为同名仓库 Secret。不要把 token 写入仓库、`.npmrc` 或命令行参数。

首次发布前用 npm 官方 registry 验证 token。可在临时的 `.npmrc` 中只写 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，通过 `npm whoami --registry=https://registry.npmjs.org/` 检查，随后移除该临时文件。若返回 401，先更新 token。需要能够发布该包的 npm 凭证；在 GitHub Actions 中使用时还需符合 npm 对自动发布和双重验证的要求。参考 [GitHub 的 npm 发布说明](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages) 与 [npm 访问令牌说明](https://docs.npmjs.com/about-access-tokens/)。

## 发布新版本

1. 确认 npm 上 `dsh-environment-tray` 的发布权；首次发布前运行 `npm view dsh-environment-tray version --registry=https://registry.npmjs.org/`。首次发布时返回 404 是正常的，若已被他人占用则先调整包名及 bundle 引用。
2. 更新 `package.json` 的 `version` 与变更说明，提交源码和生成的 `lib/`。保持 `cordis.patch.yml` 的包名与 `tsdown.config.ts` 的客户端 bundle ID 一致。
3. 在 Windows 上运行 `pnpm install --frozen-lockfile` 和 `pnpm run release:check`。检查包括类型检查、完整测试、README 断言校验和 npm 打包清单检查。
4. 推送提交；创建与 `package.json` 版本一致的标签，例如 `git tag v0.1.0`，然后推送标签。`.github/workflows/publish.yml` 会验证标签与版本完全相符，在 Windows runner 上重跑检查，然后用仓库 Secret 发布到 npm。首次版本也可走此流程。
5. 发布后用 `npm view dsh-environment-tray@<版本> version --registry=https://registry.npmjs.org/` 核对版本，并按 README 的步骤从 npm 安装到 DSH Web 测试 profile。

工作流只在 `v*` 标签推送时发布。`prepublishOnly` 再次运行发布检查，`prepack` 重建 `lib/`；token 只供发布步骤使用。若发布失败，先看 GitHub Actions 日志中的具体 npm 错误，确认 token 权限与该版本是否已存在，不要重用已发布的版本号。

参考：[DSH 插件打包与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)、[GitHub 发布 npm 包](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)、[npm package.json](https://docs.npmjs.com/files/package.json/)。
