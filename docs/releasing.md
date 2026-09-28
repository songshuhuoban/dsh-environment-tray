# 发布 `dsh-environment-tray`

插件的 npm 包名是 `dsh-environment-tray`，用户可见名称是 **DSH Environment Tray（环境变量管理器）**。`env-manager` 是 Cordis 行 ID，升级时保持稳定。发布包内有已构建的 Host 和 Web Client，安装者无需构建 TypeScript。

## 分工

GitHub 的 [`Release checks`](https://github.com/songshuhuoban/dsh-environment-tray/blob/master/.github/workflows/release-check.yml) 工作流只在 `master` 推送或 PR 时运行类型检查、测试、README 审计与 npm 打包清单检查。**它不发布到 npm，也不读取 `NPM_TOKEN`。** 发布由维护者在本机运行 `npm publish`，完成 npm 要求的浏览器验证或一次性验证码。不要把 npm token、OTP 或会话凭证写入仓库。

当前 npm 包尚未首发。仓库此前的 `v0.1.0` 标签触发过一次自动发布，但 npm 返回 `EOTP`，没有发布任何版本。手动发布成功后再创建版本标签。

## 首次发布与后续版本

1. 确认 `package.json` 中的包名和版本。首发前用 `npm view dsh-environment-tray version --registry=https://registry.npmjs.org/` 检查名称仍可用；404 表示该包尚不存在。后续发布要使用从未发布过的新版本号。
2. 更新版本和变更说明，提交源码及生成的 `lib/`，推送到 `master`。等待 GitHub `Release checks` 通过。`cordis.patch.yml` 的包名与 `tsdown.config.ts` 的客户端 bundle ID 应保持一致。
3. 在准备发布的提交上，本机执行 `pnpm install --frozen-lockfile` 和 `pnpm run release:check`。需要时再用 `npm pack --dry-run --json --ignore-scripts` 人工检查文件清单。
4. 用有该包发布权限的 npm 账号登录官方 registry：`npm login --registry=https://registry.npmjs.org/`，并用 `npm whoami --registry=https://registry.npmjs.org/` 确认账号。在仓库根目录运行 `npm publish`，按 npm CLI 提示完成浏览器验证或输入一次性验证码。`prepublishOnly` 会重跑发布检查，`prepack` 会重建 `lib/`。
5. 用 `npm view dsh-environment-tray@<版本> version --registry=https://registry.npmjs.org/` 确认发布成功。然后给**刚发布的提交**创建标签，例如 `git tag v0.1.0`，执行 `git push origin v0.1.0`。再按 README 的步骤从 npm 安装到 DSH Web 测试 profile。

如果 npm 返回 `EOTP`，不要在 CI 重试同一 token；改在维护者本机完成 npm 的交互式验证。npm 的具体 2FA 要求取决于账号、包设置和凭证类型；这里采用人工发布流程。参考：[npm 发布和 2FA 要求](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)、[DSH 插件打包与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。
