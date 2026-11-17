# 个人版本更新

本分支的桌面更新源为 <https://github.com/superman2003/OpenMausBot/releases>。
安装包中的 `resources/app-update.yml` 必须包含 `owner: superman2003`、
`repo: OpenMausBot` 和 `provider: github`。仓库及正式 Release 需要公开，客户端无需 GitHub Token。

## 发布 Windows 版本

1. 保留本分支的功能，修改 `package.json` 中的版本号，使其高于已安装的版本。
   运行 `node scripts/record-data-format.mjs` 记录该版本的数据格式兼容信息，将这两项一起提交并推送到 `main`。
2. 在 GitHub Actions 运行 **Release Windows to personal repository**，选择 `main`。
   默认创建草稿；勾选 `publish` 后会在构建和验证通过后直接发布。
3. 工作流从同一个提交构建 Windows x64 安装包，检查更新目标、版本、文件大小与 SHA-512，
   上传安装程序、`.exe.blockmap`、`latest.yml` 和 SHA-256 校验文件。

也可本地运行 `pnpm package:win` 与 `node scripts/verify-windows-release.mjs`，
再把这些文件上传到本仓库版本号对应的 `vX.Y.Z` Release。已发布的版本不覆盖，修改后递增版本号。

客户端只检查本仓库的正式 Release；草稿和预发布版本不用于正常自动更新。
从原版切换时，需要先安装一次本分支的 EXE：正在运行的原版只认识原作者的更新源，
无法自行发现本仓库的第一次发布。替换安装应在当前任务完成、从托盘彻底退出后进行。

原作者的多平台签名与旧仓库镜像发布流程仅在原仓库运行。本流程发布 Windows x64，
手机 App、自托管 Docker 和第三方浏览器组件各自保留原来的发布渠道。
