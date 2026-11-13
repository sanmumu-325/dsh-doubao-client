# 1.8.0 插件市场提交说明

## 当前交付状态

- 已准备安装 tarball、源码 ZIP、市场条目 YAML、PR 正文、更新说明和 SHA-256 校验文件。
- 1.8.0 增加设置页首次向导、签名与端口归属核对、明确授权的一键启动及默认关闭的按需自动启动；保留 `maxConcurrent: 2`、`busyWaitMs: 20000`。最终离线测试数量与实际安装/界面验证范围见交付包 `VERIFICATION.txt`，不把模拟启动说成真实启动验证。未额外发送上游并发压测请求。
- **这不等于已发布、已提交 PR 或已合并。** 当前环境无 `gh` 命令，npm `whoami` 返回 401，源码仓库没有配置 Git remote。未推送源码、未发布 npm、未创建市场 PR。

## 市场格式

目标：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
贡献指南：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md

按已保存的贡献指南，市场读取 `data/plugins/*.yml`，README 是生成结果，**不要手改市场 README**。公开页面本次可访问；GitHub API 重新读取被 403 拒绝，因此提交前仍须复核当时规则，不能把本地保存指南当成永久不变的规范。

市场提交文件已准备在：

- `marketplace/data/plugins/sanmumu-325__dsh-doubao-client.yml`：仅复制这一份 YAML 到市场仓库同名路径。
- `marketplace/PR-BODY.md`：PR 正文草稿。

条目分类为 `model`。不声明尚未上传的 Release tarball URL，不附虚构截图。市场位图图标可选，暂不填 `icon`，因此市场可回退到作者头像；插件包内仍有原创 SVG 图标。

## 发布顺序

1. 在 GitHub 创建/确认公开仓库 `sanmumu-325/dsh-doubao-client`，推送本项目，添加 `dsh-plugin` topic。仓库名、owner 若变化，应同时修改 package 元数据及市场 YAML。
2. 核对包内容与 `SHA256SUMS.txt`，选择 npm 或 GitHub Release：
   - npm：执行 `npm login`，确认有 `@sanmumu` scope 的发布权限，再对预打包 `.tgz` 执行 `npm publish ... --access public`。
   - 不发 npm：将 `.tgz` 上传到 GitHub Release `v1.8.0`，再给市场条目增加已实际存在的固定版本 `tarball` URL。
3. 按市场当时规则检查仓库年龄；已保存指南要求创建至少满一天，不能靠修改提交日期绕过。
4. Fork 市场仓库，建立分支，只添加自己的 `data/plugins/sanmumu-325__dsh-doubao-client.yml`，提交 PR。
5. 等待 CI 和维护者审核。创建 PR、CI 通过、合并和市场索引更新是不同状态，不能相互替代。

## 可复制命令（由有权限的作者执行，尚未执行）

### 推送源码

在解压后的源码目录打开终端：

```sh
git init
git add .
git commit -m "Release Doubao Desktop Models 1.8.0"
git branch -M main
git remote add origin https://github.com/sanmumu-325/dsh-doubao-client.git
git push -u origin main
```

若使用原有开发仓库，保留原有历史，不要重复 `git init` / 初始提交；只需在确认 origin 后推送。

### 发布预打包 npm 文件

在交付目录执行：

```sh
npm login
npm whoami
npm publish ./sanmumu-dsh-doubao-client-1.8.0.tgz --access public
```

若该版本已存在，先检查公开版本；不要覆盖、撤销或盲目重复发布。npm 可能要求浏览器确认、2FA 或细粒度发布 token；不要把凭据写进仓库或交付文件。

### GitHub Release（可替代 npm）

在已推送且 `gh auth status` 正常的源码仓库内，用真实交付文件路径执行：

```sh
gh repo edit --add-topic dsh-plugin
gh release create v1.8.0 /path/to/sanmumu-dsh-doubao-client-1.8.0.tgz /path/to/SHA256SUMS.txt --title "Doubao Desktop Models 1.8.0" --notes-file CHANGELOG.md
```

上传并核实下载后，可给 YAML 增加：

```yaml
tarball: https://github.com/sanmumu-325/dsh-doubao-client/releases/download/v1.8.0/sanmumu-dsh-doubao-client-1.8.0.tgz
```

这只是上传后的目标 URL；发布前不能声称它可用。

## 安全与能力声明

本机集成不等于本地推理：系统提示、对话、工具 schema 会发送给豆包，图片上传至豆包存储。插件不导出登录凭据，不启用豆包原生任务/沙盒，不自动登录、重试或绕过风控。标称 256k/300k 不是本插件已验证的实际容量。当前两个上游同时生成的效果仍需真实使用验证；离线测试只验证本地调度与隔离。

请勿将 `_market` 研究目录、用户配置、Cookie、账号资料、真实聊天、用量台账、客户端安装文件或 `.git` 凭据配置放进公开发布包。分发包使用 package 文件白名单，源码归档不包含 Git 历史及本机用户状态。
