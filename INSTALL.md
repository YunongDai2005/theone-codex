# Install TheOne for Codex

## 给 AI 编程助手的安装流程

用户说“帮我安装 https://github.com/YunongDai2005/theone-codex”时，先确认系统、Codex 是否已安装，以及用户是否已经授权修改插件配置。**安装/卸载插件、增删 marketplace、创建桌面快捷方式都属于实际配置修改**，需要用户授权；明确要求完整安装可以作为该安装范围的授权，不要重复确认。下载、解压、读取版本与检查哈希不改变 Codex 配置。不要代替用户登录、处理验证码或更改账户设置；遇到这些步骤说明原因并交还用户。不要在聊天记录中打印凭据。

### Windows x64

1. 查询固定仓库的 [最新 Release](https://github.com/YunongDai2005/theone-codex/releases/latest)，选择同版本的 `TheOne-for-Codex-<version>-windows.zip` 与 `.zip.sha256`；不要用 GitHub 自动生成的源码 zip 代替安装包。如果尚无 Release，明确报告尚未发布，不编造下载地址。下载这两个文件后，用 `Get-FileHash -Algorithm SHA256 -LiteralPath <zip>` 与校验文件核对；不一致就停止并重新下载。
2. 完整解压。检查 `node/node.exe`、`installer/install.mjs`、`theone/node/node.exe`、`.agents/plugins/marketplace.json` 和两个中文 cmd 文件均存在；运行包内 `node/node.exe --version` 应得到 `v24.21.0`。不需要系统 Node。关闭正在运行的 Codex/TheOne 客户端后再安装，避免旧进程继续使用旧插件。
3. 在解压目录用 PowerShell 执行 `& .\node\node.exe .\installer\install.mjs`。人手操作可双击 `安装 TheOne.cmd`。使用直接命令可避开 cmd 包装器最后的“按任意键”，便于自动化；安装器本身没有选择弹窗，也不会自动登录。退出码 `0` 表示插件安装成功（可能仅插件），`2` 表示插件成功但客户端适配失败，`1` 表示安装流程失败。读取完整中文结果，不要只看退出码。
4. 安装器查找 `THEONE_CODEX_BIN`、`%LOCALAPPDATA%\OpenAI\Codex\bin` 和 PATH 上的 Codex，调用 `plugin list --json` 与 `plugin marketplace list --json`；先保留原数据路径，将包复制到 `%LOCALAPPDATA%\TheOne\packages\<version>-<unique>\`，再移除旧 `gpt-theone@theone-local` 与 `theone-local`，注册新源并安装 `theone@theone-codex`。复制预检在卸载前完成，以免坏包先卸掉旧插件。已安装的新身份也会重新注册以支持更新。进度保存在 `%LOCALAPPDATA%\TheOne\install-state.json`；失败可原样重试，不要手工删除数据。
5. 验证 `codex plugin list --json` 的 `installed` 数组含 `theone@theone-codex` 且 `enabled: true`；检查稳定目录的 `theone/.mcp.json` 与 `mcp.json` 均使用 `./node/node.exe`，且 `env.THEONE_DATA_DIR` 指向原数据目录。安装器也会执行插件清单验证。原始跨平台构建仍使用 `node`，只有 Windows zip 中的配置改成便携 Node。
6. 客户端适配仅支持 `26.1103.4239.0`，还会校验原渲染器 SHA256。匹配时在稳定目录生成副本、保留原客户端，建立桌面“Codex TheOne”快捷方式；不会启动副本。版本不匹配或未安装桌面版时只安装插件并明确提示。完全退出 Codex 后，从新快捷方式启动；仅插件模式则重启原 Codex，并在插件中启用 TheOne。通过 TheOne 状态工具确认版本 `0.1.0`、既有话题可见，再检查主聊天入口；这些运行时/界面检查才是用户机器上的实际验收。

**数据与卸载。** 原服务目录优先级为 `THEONE_DATA_DIR` → `PLUGIN_DATA/theone` → `~/.gpt-theone`。安装器会读取已保存的安装状态/旧 MCP 自定义目录，并检查 `$CODEX_HOME/plugins/data/agent-plugins/*/theone` 与旧 home 目录；把确定的原路径写入新 MCP 的 `THEONE_DATA_DIR`，不改名、不搬动正在使用的 SQLite 文件，也不重建话题。发现多个候选时停止，不猜测；设置 `THEONE_DATA_DIR` 为希望使用的绝对目录再重试。自定义 `CODEX_HOME` 必须在安装、验证和卸载时保持一致。卸载双击 `卸载 TheOne.cmd` 或执行 `& .\node\node.exe .\installer\install.mjs --uninstall`；仅移除插件、源、受管理快捷方式和安装副本，默认保留话题数据及记录其路径的小状态文件。确实要清除数据时，由用户在交互终端加 `--delete-data` 并输入 `DELETE`；自动化不要传此选项。旧开发版在仓库中手工生成的客户端副本不属于此安装器的管理范围。

**常见错误。** 找不到 Codex：先安装或更新 Codex，并验证 `codex --version`；npm 安装的 CLI 需要其原本的依赖完整。CLI 不识别插件命令/清单格式：更新 Codex 后重试，不手改私有配置格式。桌面版本或 SHA256 不匹配：保留插件模式，等待兼容的 TheOne 安装包，不强行修改原客户端。权限/文件占用：退出 Codex 后按当前用户重新运行，保留错误信息。旧开发版快捷方式：安装器会根据旧插件清单的来源目录识别并移除精确匹配的 TheOne 启动器；无法确认归属的同名快捷方式需要用户检查目标后删除或改名，再重试。话题为空：检查记录的 `dataDir`、自定义 `CODEX_HOME` 和 `THEONE_DATA_DIR`，不要创建替代数据或删除数据库。备份完整数据应先停止服务，复制整个目录（包含 SQLite WAL/SHM）；仅导出话题 JSON 不等于完整备份。

### macOS / Linux

仅提供源码安装，需要系统 PATH 中的 Node 24+、npm、git 和支持插件的 Codex。在稳定位置 clone 仓库，然后运行：

```sh
git clone https://github.com/YunongDai2005/theone-codex.git
cd theone-codex
npm ci --ignore-scripts && npm run build
codex plugin marketplace add "$PWD/release"
codex plugin add theone@theone-codex
codex plugin list --json
```

构建成功后应存在 `release/theone/server/main.mjs` 和 `release/.agents/plugins/marketplace.json`；`mcp.json` 的 `command` 应为 `node`。若从旧版迁移，在删除旧插件前确认实际数据目录，并在 `release/theone/mcp.json` 和 `.mcp.json` 的 `mcpServers.theone.env.THEONE_DATA_DIR` 中固定该绝对路径，然后运行 `codex plugin remove gpt-theone@theone-local` 与 `codex plugin marketplace remove theone-local`，再执行上述新身份安装命令。保留该 clone/release 目录供 marketplace 使用。校验清单包含已启用的新插件，重启 Codex 后用 TheOne 状态工具检查版本和原话题；此路线不安装 Windows 客户端适配。构建失败先处理 npm/Node 错误，不能跳过构建直接注册空目录。

## Instructions for an AI coding assistant

When asked to install this repository, establish the OS, the installed Codex CLI and authorization to change its plugins/marketplaces and create a desktop shortcut. Explicit authorization for a complete installation covers these steps; do not ask again. Stop and hand control back for login, verification codes or account changes. Downloading, extracting and hashing files does not modify Codex configuration. Never expose credentials.

On Windows x64, fetch the matching Windows zip and `.zip.sha256` from the repository's latest GitHub Release, compare SHA256, extract everything and check the bundled Node version (`v24.21.0`). If no release exists, report that fact. Close Codex, then execute `& .\node\node.exe .\installer\install.mjs` from PowerShell in the extracted directory. This avoids the double-click wrapper's final pause. The installer stages files under `%LOCALAPPDATA%\TheOne`, pins the existing topic directory, removes `gpt-theone@theone-local` and its marketplace, and installs `theone@theone-codex`. It verifies the enabled plugin entry. Exit code 0 may mean plugin-only installation, 2 means the plugin succeeded but desktop adaptation failed, and 1 means installation failed; always read the report. The adapter is generated locally only for desktop `26.1103.4239.0` with matching renderer hashes. CI does not redistribute a Codex desktop binary. Restart Codex or use the new “Codex TheOne” shortcut, then verify version 0.1.0 and the original topics through TheOne's status tool and inspect the actual UI.

On macOS/Linux, install Node 24+ and a plugin-capable Codex, clone the repository to a stable location, run `npm ci --ignore-scripts && npm run build`, then `codex plugin marketplace add "$PWD/release"` and `codex plugin add theone@theone-codex`. Verify build files and `codex plugin list --json`, restart Codex and check TheOne status/topics. These builds use `node` from PATH and do not include a Windows desktop adapter. Before migrating a legacy identity, pin its actual data directory in both built MCP configurations as `env.THEONE_DATA_DIR`, then remove the old plugin and marketplace before installing the new one.

Data is kept in place: `THEONE_DATA_DIR`, otherwise the old `PLUGIN_DATA/theone`, otherwise `~/.gpt-theone`. Windows installation remembers and pins the selected directory across retries and upgrades; ambiguous candidates stop with instructions to set an explicit path. Keep `CODEX_HOME` consistent. `--uninstall` removes managed files and registrations but preserves data without asking; `--uninstall --delete-data` additionally requires an interactive `DELETE` confirmation. Never request deletion during unattended installation. Missing Codex requires installation/update; hash mismatch requires a fresh download; unsupported desktop requires plugin-only use or a compatible adapter release; locked files require quitting Codex. Do not overwrite unrelated shortcuts or edit account settings to work around failures.
