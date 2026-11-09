# 移植证据与复查

当前插件 alpha.9 / 客户端 0.4.2：`history-parallel-check.log`（132 项核心测试、类型与构建）、`client-adapter-tests.log`（26 项客户端测试）、`local-installation-ui.json`（本机安装、43 个原生工具、模型选择接口与安装哈希）、`client-adapter-runtime.json`（原有聊天和细胞操作回归）、`client-adapter-install.json`（最终桌面快捷方式）。alpha.8 合批回归保留在 `history-speed-check.log`（121 项）；alpha.7 模型选择回归在 `history-model-check.log`（118 项），alpha.6 历史回归在 `history-implementation-check.log`，不能用旧截图代替新版客户端验证。

`history-pipeline-before.json` / `history-pipeline-after.json` 使用真实 Luna / medium / standard，对照相同 4 段合成聊天、16 轮及两个已有话题，耗时 39335 → 15149 ms，并发峰值 1 → 2，输出 JSON 大小 2060 → 606 字节，保留全部 32 条消息。`history-pipeline-cold.json` 则从空目录整理两段合成会话，经过两次并发分类和一次归属核对生成 2 个话题，耗时 19735 ms。首次全库整理没有相同旧版对照，不能将约 61.5% 的增量样本提速推广到全部历史。JSON 字节数不等于 token 或账单用量。

`history-performance-before.json` / `history-performance-after.json` 记录相同 16 轮合成输入从两批改成一批，Luna / medium / standard 的总耗时从 18078 ms 降到 9368 ms。逐轮归属通过真实校验器检查。它是单次小样本比较，不是用户历史的完整性能基准，也不代表固定可获得 48% 提速。

`history-real-model.json` 验证本机原生目录/历史结构，以及 GPT-6 Luna / medium / standard 对两条合成内容的真实分类。`history-desktop-runtime.json` 验证经济默认、中度思考、闪电开关及其能力限制、设置保存后恢复、首次询问、跳过后手动启动、会话排除、气泡生成和草稿保留；该桌面测试使用合成历史和受控分类结果。`history-setup.png` 与 `history-generated-cells.png` 来自该隔离客户端，不是用户真实历史整理结果。截图为手动点亮闪电后的状态；快速默认关闭。安装不会改变已有历史许可。

`dsh-046-source-match.json` 核对移入的两个细胞前端文件与远端 main `a943701` 提交内容一致。`client-native-navigation.png` 与 `client-topic-directory.png` 是适配客户端真实窗口的截图，话题为隔离测试库的合成样本。该窗口仅将 TheOne 工具连接到隔离真实 MCP 服务，原生导航与输入框不替换，没有发送模型消息。实际安装的原生工具传输另行验证；不要把两项合称完整真实模型链路验收。

alpha.2 历史证据：`ui-implementation-check.log`（90 项回归、类型与构建）、`native-ui-validation.json`（原生草稿桥接，模拟宿主）与 `package-validation-ui.json`（隔离安装）。被弃用的独立聊天 UI 测试截图不代表当前界面。

历史桌面入口复查：`global-discovery-diagnosis.json` 证明无 thread 上下文的全局清单能发现入口；`desktop-entrypoint-diagnosis.json` 记录重启后的桌面入口缓存与用户确认。该阶段的全局入口固定到应用总导航，后来通过单独客户端适配实现「新聊天」下方的主聊天卡片和细胞团。

实现阶段证据：`implementation-check.log` 保存类型检查、全套测试与构建输出；`package-validation.json` 保存隔离 Codex 安装和协议调用结果；`live-codex-validation.json` 保存虚构数据的真实模型回合结果；[local-installation.json](local-installation.json) 保存真实用户配置中的安装、启用、包哈希核对、技能发现和原生 MCP 调用结果。当前结论见 [实现记录](../docs/implementation-status.md)。下文为最初准备阶段的历史记录，其「本次」不包含之后的实施、真实会话测试与本机安装。

日期：2026-11-09，Asia/Shanghai。

| 文件 | 用途 |
| --- | --- |
| [baseline.json](baseline.json) | 当前源码提交、分支、工具版本与本次动作范围 |
| [source-inventory.json](source-inventory.json) | 50 个源码模块的 SHA-256、大小、行数及静态依赖 |
| [capabilities.json](codex-0.167.0-alpha.3.2/capabilities.json) | CLI 导出的方法、通知、请求和选定参数形状 |
| [verification.json](verification.json) | JSON 解析、源码及协议哈希、基础方法和本地文档链接的检查结果 |

本地另有 `codex-0.167.0-alpha.3.2/schema/` 和 `schema-experimental/`，保存完整生成协议，并被 `.gitignore` 排除。源码清单的行数按换行分隔计算，含文件末尾分隔后的空项；它用于规模和哈希复查，不是代码覆盖率。

## 已执行的检查

- 读取源码 package、README、执行入口、路由、会话、存储、审批、项目队列与测试夹具。
- 只读检查源项目 Git 状态与提交：已跟踪内容无差异，存在未跟踪本地内容。
- 使用本机 CLI 导出普通和实验 JSON Schema，两次命令退出码均为 0。
- 从生成的协议提取 106 个普通客户端方法、74 个仅实验导出包含的方法，并核对 13 个基础方法均存在。
- 对源文件记录哈希；对 ClientRequest、ServerRequest、ServerNotification 的普通协议记录哈希。

生成时 CLI 对用户目录中的临时 PATH alias 清理输出了访问警告；协议文件正常产出。没有修改全局配置来消除警告。

## 可复查命令

在 `D:\doc\ChatGPT\gpt-theone` 内执行。先检查版本；升级后的 schema 必须输出到对应的新版本目录。

```powershell
codex --version
node --version
git --no-optional-locks -C 'D:\doc\GitHub\dsh-theone' status --short --branch
git -C 'D:\doc\GitHub\dsh-theone' rev-parse HEAD
codex app-server generate-json-schema --out 'D:\doc\ChatGPT\gpt-theone\evidence\codex-0.167.0-alpha.3.2\schema'
codex app-server generate-json-schema --experimental --out 'D:\doc\ChatGPT\gpt-theone\evidence\codex-0.167.0-alpha.3.2\schema-experimental'
```

13 个基础方法是：`thread/start`、`thread/resume`、`thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/inject_items`、`thread/compact/start`、`turn/start`、`turn/steer`、`turn/interrupt`、`hooks/list`、`model/list`。

## 证据边界

本次未调用模型、未读用户聊天历史、未创建真实会话、未安装插件、未修改 Codex 全局配置、未修改 DSH 源码或数据库、未提交或推送。未运行原项目完整测试，也未验证 Codex 的运行时会话连接、原生 UI 或账号能力。

schema 导出证明本机二进制包含这些协议定义，不证明每个接口已获当前账号授权或适合第三方插件使用；普通导出与实验导出的区别也不能替代运行时能力协商。

官方材料均于本次打开核对：[插件包](https://developers.openai.com/plugins/build/plugins)、[Hooks](https://learn.chatgpt.com/docs/hooks)、[App Server](https://learn.chatgpt.com/docs/app-server)、[MCP](https://learn.chatgpt.com/docs/extend/mcp)、[插件扩展](https://developers.openai.com/plugins/build/extensions)、[MCP UI](https://developers.openai.com/plugins/build/chatgpt-ui)、[MCP Events](https://developers.openai.com/plugins/build/mcp-events)。
