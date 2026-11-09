# TheOne for Codex · 0.1.0

客户端首次启用可选择整理模型、思考强度和会话范围，或稍后从 TheOne 设置 → 整理历史启动。默认 GPT-6 Luna＋中度思考，⚡ 快速默认关闭；开启快速会增加消耗。选择保存后只作用于历史整理，可随时暂停后更换。支持会话/文件夹排除、暂停和增量续接；完成的批次自动生成气泡，继续使用 Codex 原有聊天。仅安装插件时可通过对应历史工具操作。

本地 Codex 话题插件。需要 Node.js 24+ 和已登录、支持 App Server 的 Codex CLI。服务器及 JavaScript 依赖已经打包在 `server/main.mjs` 中。

安装后，主侧栏的 TheOne 入口请求打开 Codex 原生聊天草稿，并预填启用内容。你可以补充任务后发送。原生会话面板中的「TheOne 话题」用于创建或选择话题，选择后将话题引用加入当前原生输入框。具体侧栏位置由宿主决定，插件不能指定紧贴「新聊天」下方。宿主未提供原生消息扩展时，会明确显示不支持，不改用独立聊天界面。

也可在选定的项目聊天中说「用 TheOne 管理这个项目的话题」，或使用 `$theone`，由技能调用工具。两种入口共用本地话题库。

独立话题通过 App Server 工作，原生聊天中的技能负责调用和呈现。工作目录由技能在所选项目聊天中配置，默认只读。当前没有 DSH 气泡布局与原生工具卡片镜像；这是本地 alpha。

运行检查：`node server/main.mjs doctor`。程序按 `THEONE_CODEX_BIN`、Windows Codex 安装目录、PATH 的顺序寻找 Codex。数据放在 `THEONE_DATA_DIR`，或宿主 `PLUGIN_DATA/theone`，或 `~/.gpt-theone`。卸载插件不删除用户数据或原生 Codex 会话。

模型路由可选：为服务器配置 `THEONE_ROUTER_URL`（完整 `/chat/completions` URL）、`THEONE_ROUTER_MODEL` 和可选 `THEONE_ROUTER_KEY`，然后将网关 `routerMode` 设为 `model`。该服务会收到经过限长与基础脱敏的话题目录和路由上下文。默认 `rules` 不调用外部分类模型。工作会话仍使用用户已有的 Codex 登录。

可选 hook 在 `optional-hooks/hooks.json`，默认未启用。需要时将 OpenAI manifest 的 `hooks` 指向该文件；主入口须配置为实际 Codex 聊天 ID，并在宿主「Review hooks / Settings > Hooks」中审阅信任。hook 只提醒已启用的入口使用工具，不拦截响应、不自动批准操作。MCP 与 hook 必须指向同一数据目录。

历史导入接受 TheOne version 1 JSON，按来源 ID 去重，默认私密。原生 Codex 历史仅在用户同意后按所选范围整理，不直接读取 DSH 原库。两段聊天可并行分类；新话题有并发冲突时会用同一模型额外核对归属，已整理的内容增量复用。只读持续任务仅支持公共 GitHub PR，进程退出时停止检查，下次启动恢复。

来源和 MIT 许可见 `UPSTREAM.md`、`LICENSE`。
