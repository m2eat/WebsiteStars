# GitHub 构建与发布

## 自动流程

| 触发方式 | 执行内容 | 产物 |
| --- | --- | --- |
| 分支 push、Pull Request | 锁文件安装、TypeScript、单元/集成测试、打包、包校验、全部 Chromium 浏览器测试 | Actions 中的扩展 ZIP、SHA256SUMS、浏览器报告 |
| Actions 页面手动运行 CI | 同上 | 同上，不创建 Release |
| 推送 `vX.Y.Z` 标签 | 复用全部 CI 检查，成功后创建 GitHub Release | `websitestars-X.Y.Z-chrome.zip`、`SHA256SUMS`、自动生成的发布说明 |

配置位于 `.github/workflows/ci.yml` 和 `.github/workflows/release.yml`。运行环境为 Ubuntu 24.04、Node.js 22；使用 `npm ci`，Playwright 安装完整 Chromium 及系统依赖，因为扩展测试使用 `channel: 'chromium'`。浏览器用例使用临时资料库和本机测试 HTTP 服务，不需要真实 AI Key，也不运行可选的本机 Ollama 质量评测。

CI 只读仓库。仅 Release 的发布任务取得 `contents: write`，使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需配置个人访问令牌。Actions 固定到官方提交 SHA；更新时同时更新旁边的版本注释。

发布任务下载同一次工作流、同一次尝试中已经通过测试的附件，不再次构建。ZIP 与实际测试的 `.output/chrome-mv3` 必须逐文件一致，生成 SHA-256 校验文件；下载后再次检查校验值。已存在的 Release 不自动覆盖，推送标签后不会自动发布 Chrome Web Store。

## 首次接入

将项目提交并推送到 GitHub 仓库，包含 `package-lock.json`、`.github/workflows/` 和 `scripts/verify-package.py`。本地生成的 `.output`、`.wxt`、`node_modules` 和测试报告保持忽略。

在仓库 Actions 页面确认允许 GitHub Actions 运行。建议在默认分支保护规则中将 CI 的 `Test and package Chrome extension` 设置为必需检查；可在首次成功运行后从检查列表选择。若组织策略禁止 `GITHUB_TOKEN` 写入 Release，需要由仓库管理员允许发布任务申请的权限。

工作流文件需先进入默认分支，Actions 页面才会显示 CI 的手动运行按钮。来自 fork 的 PR 使用只读检查，不执行发布。

## 发布版本

版本使用三个数字段，例如 `0.1.0`、`0.2.0`。暂不支持 `-beta` 等后缀；Chrome 清单的版本段不能超过 65535，不能全部为零。

1. 在工作分支更新版本并提交，`npm version` 会同步更新 `package.json` 与锁文件：

   ```sh
   npm version 0.2.0 --no-git-tag-version
   git add package.json package-lock.json
   git commit -m "chore: release 0.2.0"
   ```

2. 按仓库流程合入并推送发布提交，等待 CI 通过。在该提交上创建并推送标签：

   ```sh
   git tag -a v0.2.0 -m "WebsiteStars 0.2.0"
   git push origin v0.2.0
   ```

   若首次发布当前的 `0.1.0`，可省略版本更新，在已推送且包含工作流的提交上创建 `v0.1.0` 标签。

3. 查看 Actions 的 Release 运行。它会重新执行标签提交的全部检查，通过后发布附件和 GitHub 自动生成的说明。标签必须严格等于 `v` 加 `package.json` 版本，否则校验失败且不发布。

4. 用户下载 ZIP，解压后在 `chrome://extensions` 开启开发者模式，通过「加载已解压的扩展程序」选择解压目录。GitHub Release 不提供浏览器自动更新；商店分发需要另行接入商店账号与发布凭据。

## 校验与排错

本地检查已构建的包：

```sh
npm run zip
python3 scripts/verify-package.py --tag v0.1.0
(cd .output && shasum -a 256 -c SHA256SUMS)
```

替换为当前版本标签；仅校验开发构建时可省略 `--tag`。校验要求输出目录只有一个当前版本的 Chrome ZIP。如果本地留有旧版本 ZIP，先将旧包移动到输出目录以外保存，再运行校验；GitHub 干净检出不存在此问题。

CI 失败时，打开对应步骤日志；浏览器报告及失败 trace 保存 7 天，已通过所有检查的扩展附件保存 14 天。报告可下载后用 `npx playwright show-report <目录>` 查看。

- 类型、测试或包校验失败：修正代码并重新提交；尚未公开的标签按仓库规则处理，不要覆盖已发布版本。
- 网络或 runner 临时失败、且 Release 尚未创建：重新运行整个 Release 工作流（Re-run all jobs）。附件名称包含运行尝试号，仅重跑发布任务无法复用上次尝试的包。
- 发布 API 或附件上传失败：先检查 Releases 中是否留下草稿；当前流程不会覆盖已有草稿或已发布内容。确认并处理残留后再重跑，或发布新的版本。
- 已发布版本需要修复：升级版本并创建新标签，保留原版本附件。

本地只能验证构建命令、产物和工作流静态语法；GitHub runner、仓库权限及 Release API 的实际运行需在代码推送后确认。
