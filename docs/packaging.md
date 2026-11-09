# 0.1.0 Windows 打包与验证交接

本轮完成打包代码和安装文档，改动保留在 `packaging` 工作区。任务文件明确禁止 `git add/commit`，且共享 worktree 的 Git 元数据只读，因此没有提交、推送、打 tag 或发布。

## 实现

- 插件身份为 `theone@theone-codex`，显示名 `TheOne`，npm 包名 `theone-codex`；插件目录为 `release/theone`。描述改为一个主聊天自动路由到各话题的 Codex 会话。原生入口引用和验证脚本同步改名。
- package/lockfile/两份插件 manifest 为 `0.1.0`。任务同时禁止修改 `src/service.ts`：因此 `scripts/release-metadata.mjs` 在构建时统一 bundle 和 dist 中的公开版本、MCP 名称和更新比较基准，源文件中的历史字符串保持不动。实际编译产物的服务状态、MCP 握手和更新比较已验证为 `0.1.0`。历史导出 source 身份、数据库目录名不改。
- `installer/install.mjs` 提供可注入依赖的安装和卸载接口。Windows 包的两个中文 cmd 入口调用包内 Node；实际插件文件安装到 `%LOCALAPPDATA%\TheOne\packages\<version>-<unique>\`，支持失败重试和重复安装。
- `scripts/package.ps1` 固定 Node `24.21.0` Windows x64，下载官方 zip 与 `SHASUMS256.txt` 并校验，再生成 `release/TheOne-for-Codex-0.1.0-windows.zip` 及 `.zip.sha256`。保留 Node LICENSE 和第三方依赖许可证；修复 worktree 的 node_modules 联接导致依赖许可漏收集的问题。
- `INSTALL.md` 包含中英文助手安装流程、逐步验证、配置修改的授权范围、迁移和故障处理。
- `.github/workflows/release.yml` 在 `v*` tag 上使用 Windows runner，核对版本、运行 `npm ci`、`npm run check` 和离线打包测试，构建适配代码并生成 zip/SHA256，上传 GitHub Release。没有在本轮触发该 workflow。

## 数据迁移和卸载

原服务的默认顺序是 `THEONE_DATA_DIR` → `PLUGIN_DATA/theone` → `~/.gpt-theone`。安装器优先使用明确配置/已有安装状态，其次检查旧 MCP 自定义目录、`$CODEX_HOME/plugins/data/agent-plugins/*/theone` 和 home 旧目录。确定的原路径写进新 MCP 的 `env.THEONE_DATA_DIR`，话题和 SQLite 数据原位保留，不在线复制数据库。

在移除旧身份前保存数据选择和安装进度。先检查并复制完整安装包，再执行旧插件 remove、旧 marketplace remove、新 marketplace add 和新插件 add；复制预检提前是为了避免坏包先卸掉旧插件。多个数据候选会停止并说明设置 `THEONE_DATA_DIR` 的办法；数据位于会被删除的插件缓存/安装副本时要求先备份迁出。

旧开发版快捷方式的归属从旧插件清单的 `release/gpt-theone` 来源推导，并保存以便中途失败后重试。只移除精确指向该来源的 TheOne VBS 快捷方式；其他同名快捷方式不覆盖。旧仓库中手工生成的客户端副本不删除。新安装器自己的副本和快捷方式均在卸载范围内。

卸载默认保留数据，不询问删除。只有显式 `--uninstall --delete-data`，且用户在交互终端输入 `DELETE` 后才删除数据；无交互输入不会删除。保留一个记录数据路径的安装状态文件，供重新安装复用。

## Node 和客户端适配

已只读核对本机 CLI 顶层帮助、现有插件配置以及 CLI 内嵌的 Agent Plugins 配置校验文本。其 stdio command 接受 bare executable 或插件内 contained `./` path；cwd 支持 `${PLUGIN_ROOT}`。因此 Windows staging 中两份 MCP 配置都使用 `./node/node.exe`、`${PLUGIN_ROOT}/server/main.mjs` 与 `${PLUGIN_ROOT}` cwd，Node 放在插件自己的 `node/` 中，随插件复制进 Codex 缓存。原始跨平台配置仍用 PATH 上的 `node`。

CI 不需要 Codex 桌面版，也不打包其二进制。`build-client-payload.mjs` 在构建机预编译适配代码；安装时复用 `buildClient` 和 `installLauncher`，用包内 Node 在用户机器生成客户端副本。匹配桌面 `26.1103.4239.0` 且渲染器哈希正确才构建。无桌面/版本不符时只安装插件；其他适配错误报告插件成功、适配失败，退出码为 2。安装不会自动启动客户端，记录仍为 `runtimeLaunchVerified: false`。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript `tsc --noEmit` 和编译 | 通过 |
| 完整业务测试 | 215/215，通过仓库进程内 AppServer 测试边界执行 |
| 现有客户端测试 | 38/38，使用实际 esbuild 输出和本机原渲染资源 |
| 新增安装、客户端打包接口、发布元数据测试 | 20/20 |
| PowerShell 离线打包检查 | 6 类检查通过：正确哈希、篡改拒绝、缺失哈希拒绝、zip 内容、便携 MCP、跨平台源配置保留 |
| 发布产物检查 | 服务状态、更新基准、MCP 名称/版本通过；bundle 语法和第三方许可证通过 |
| 预编译适配包 | 对本机两个原始渲染资源在内存中补丁成功，原文件未写入 |
| 修改范围和空白检查 | `git diff --check` 通过；所有 README、service.ts、desktop-ui.mjs/css、foam-adapter.mjs 未改 |

标准 `npm.cmd run check` **未完整通过**：类型检查完成后，在 UI esbuild 启动子进程时被当前沙箱拒绝（`spawn EPERM`）。受限环境下由 PowerShell 直接运行真实 esbuild 二进制，并用仓库已有预编译测试接口/进程内协议 fixture 执行测试。发布构建的收尾逻辑使用这些真实编译输出运行，测试桥同时核对构建选项与源码转换结果；这不能代替无沙箱环境的标准流水线验收。

日志在 `.theone/pack-tests.log`、`.theone/pack-client-tests.log`、`.theone/pack-installer-tests.log` 和 `.theone/pack-standard-check.log`。这些是本地忽略文件，不进入 Git。

本轮未下载 Node，未运行真实安装器或 `codex plugin` 命令，未改真实 Codex 配置，未进行真实快捷方式创建/卸载、客户端启动或视觉验收。PowerShell zip 测试使用临时夹具，并非可发布安装包。

## 后续在正常终端执行

合并本工作区和并行功能改动、完成用户负责的 README 更新后，先运行：

```powershell
npm.cmd run check
npm.cmd run package:test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1
```

最后一条会实际下载并校验 Node，构建适配 payload，生成 zip 和 SHA256。解压后在干净用户环境或测试机验收安装/升级/卸载与原话题保留，确认桌面入口及实际启动。CI 的 tag 发布步骤应在完成这些验收之后，由用户按发布安排触发。当前 `.git` 只读，提交也需在有写权限的环境完成。
