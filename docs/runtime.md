# 本地运行与使用

## 入口与数据

`node dist/main.js serve` 启动 stdio MCP；`node dist/main.js doctor` 只初始化本机 Codex 并读取一个模型目录条目；`node dist/main.js hook` 从 stdin 读取 hook JSON。

数据目录按 `THEONE_DATA_DIR` → `PLUGIN_DATA/theone` → 用户目录 `.gpt-theone` 选择。分别保存 `topics.db`、`runtime.db`、`tasks.db`，使用 SQLite WAL。备份应停止服务器后复制全部数据库，或用 SQLite 一致性备份；JSON 导出只覆盖话题/消息，不是执行状态、任务、学习记录和合并日志的完整灾备。工具不会直接修改 Codex 私有数据库。

`THEONE_CODEX_BIN` 可以指定 Codex 可执行文件。Windows 自动寻找 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`，否则使用 PATH 中的 `codex`。工作进程通过 stdio App Server 使用现有 Codex 登录；插件不读取或保存其账户令牌。

## 主聊天闭环

原生历史整理使用同一 [Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 `thread/list`、`thread/read` 和分页历史接口。首次只有会话目录；用户同意后才读取正文和调用分类模型。分类运行在临时会话中，使用结构化输出并禁用执行工具、插件和 MCP 集成，按 DSH 提示及校验器归类。该分类与下文可选的外部 HTTP 路由器分开，不需另配 API Key。

`theone_history_consent` 保存同意/跳过，`theone_history_sessions` 和 `theone_history_exclude` 选择会话/文件夹，`theone_history_refresh` 手动增量整理，`theone_history_pause` 暂停，`theone_history_status` 显示进度。目录读取不发送给分类模型，正文在同意范围内以有长度上限的摘录送给所选的整理模型。已完成批次、来源、指纹和暂停状态落盘；原生会话不修改。进程关闭时停止，重新运行后可续接。

`theone_history_models` 只读取 `model/list` 元数据，返回模型、支持的思考档位、Fast 能力和已保存选择，不消耗推理额度。`theone_history_consent` / `theone_history_refresh` 接受 `modelSettings: { model, effort, fast }`，验证成功后保存到 TheOne 的 runtime.db。默认优先 GPT-6 Luna，其次旧版 GPT-5.6 Luna，中度思考、快速关闭；都不可用时要求手动选择，不继承全局昂贵模型。推荐依据为 2026-11-09 的 [官方模型说明](https://developers.openai.com/api/docs/models/gpt-6-luna) 和 [费率](https://developers.openai.com/api/docs/pricing)，不是对未来模型自动比较价格。

每个分类请求显式传递模型、推理强度和 `serviceTier`：标准为 `default`，快速使用模型目录声明的 `priority` / `fast`。不改变原生聊天和全局配置；不支持的模型、档位或快速选项会报错，已完成内容不会因换模型而重新收费分类。当前尚无 token 用量统计或总费用上限。

alpha.8 将固定 8 轮改为按文本长度合批：最多 16 轮，通常最多 9600 字符的历史摘录；单轮超大摘录单独处理，不能拆掉同一轮的归属。模型输出仍逐轮验证完整覆盖、不重复及已有话题 ID，最多允许 16 个独立话题。

alpha.9 最多同时分类两段不同聊天，同一聊天内的批次仍按顺序推进，入库始终串行。已有话题允许只返回 contextId、turns 和 update（无变化时为 null），省略标题和分组；增量字段按最新数据库记录应用。两批同时提出新话题时，后提交者先针对本轮新目录做一次短小的语义核对；仅同名不会强制合并。归属核对沿用所选模型、思考强度和快速设置，也计入每轮 64 次调用限制。剩余额度不足时自动串行，避免突破限制。

预算用完且存在可处理积压时，一秒后继续；空闲、忙碌会话、暂停及失败不触发快速空转。目录候选只解码最多 24 条话题；单话题与消息来源通过索引读取，不再反复解码全话题表或扫描全部消息正文。投影指纹用于恢复跨数据库写入中断，已存在的历史消息不重复写入。每轮调用限制不是总费用上限。

1. `theone_configure`：选定 `gatewayId`、现有项目目录和沙箱。为 hook 配置时 gatewayId 必须是实际聊天 ID。`workspace-write` 只用于已授权的项目写入。
2. `theone_dispatch`：传本轮原文、稳定的 inputId；可指定 topicId。返回 runId 或澄清问题。同一请求重试不更换 ID；新的请求使用新的 ID。
3. `theone_wait`：一次最多等待 20 秒。queued/running 不是完成；等待期间继续观察，或按用户要求取消。
4. 等待审批或问题时，把原请求内容交给用户，再用精确 runId/approvalId 回答。支持命令、文件变更、用户问题；不支持的宿主请求返回错误，不会自动授权。
5. 呈现最终结果后 `theone_acknowledge`。结果落盘后可补发，不重做工具动作。

MCP server 关闭会中断自己拥有的正在执行/排队任务。进程意外死亡的运行会标记 interrupted，保留已收集输出；不自动重试不确定的回合。多个服务器共享同一数据目录时以数据库租约串行执行；审批和取消目前必须回到拥有该运行的连接。PID 被系统复用时采用保守行为，可能需要原连接释放或人工检查，不保证自动解锁。

同一个 Git 项目、相同或祖先/子目录会排队；不同 linked worktree、外部程序及不共享数据目录的插件实例不在锁的保证范围。排队时保存的只读权限不会因后续配置变宽而自动升级，后续收紧立即用于开始执行前的检查。

## 分类与共享

新网关默认 `routerMode=auto`：显式 `topicId` 优先；主模型的高置信 `proposal` 通过可见性、排除、同名和规则强匹配检查后直接采用，否则进入模型路由，失败再退回规则。已有网关保存的 `rules` 不变；`rules` 完全不调用路由模型，`model` 不采用 proposal 快捷路径。

未配置 `THEONE_ROUTER_URL` 时使用已有 Codex 登录。路由与历史整理共用 App Server 客户端实现，复用连接，每次建立独立 ephemeral 只读线程，禁用工具、插件、MCP 和环境，使用结构化输出。单次决定默认超时15秒，环境变量 `THEONE_ROUTER_TIMEOUT_MS` 可调整。`theone_router_models` 列出 `model/list` 提供的选择，`theone_router_configure` 接受 `modelSettings: { model, effort, fast }`，单独保存在 `router-model-settings`，不修改历史整理设置。默认优先 Luna、低思考、标准速度；保存的模型失效会报错并退回规则，不替换成别的模型。

模型路径复用语义校验和复核提示词：CREATE、CLARIFY 或唯一证据冲突会复核；截断目录尚有遗漏候选时最多追加三页复核。可恢复错误每层最多两次；超时和模型设置错误不重试。回执 `receipt` 记录 `source`（explicit / proposal / codex / http / rules / fallback）、总耗时、实际模型和调用明细，失败时同时返回 `routingError`。

dispatch 返回最多80条、12000字符的 `catalog`（id、label、title）及 `catalogVersion`，按当前话题共享范围过滤私密和排除项；版本未变不重复返回目录，可传回已知版本。短名优先存储 label，其次短标题，最后选标题中实际出现的实体或关键词。

显式配置 HTTP 提供方时仍优先使用 HttpRouter：

```text
THEONE_ROUTER_URL=https://your-provider.example/v1/chat/completions
THEONE_ROUTER_MODEL=your-routing-model
THEONE_ROUTER_KEY=your-api-key
```

URL 是完整接口地址；只允许 HTTPS 或本地回环 HTTP，不跟随重定向。HTTP 默认超时8秒，不附加 tools，不复用 Codex 账户令牌。会向该提供方发送限长且基础脱敏的分类上下文，包含过滤后的话题目录和近期消息。生产模型准确率、成本和真实延迟尚未验收。

用户手动运行 `node --experimental-transform-types scripts/measure-router.mjs` 可用真实 Codex 登录测量样例；可附加 `--model <model> --effort low --fast` 显式覆盖选择。脚本消耗模型额度，输出每次决定、耗时及 p50/p90，保存到 `evidence/router-latency.json`。首条包含冷连接开销，后续复用或在断线后重连；百分位包含失败尝试，失败数另列。

private 防止向其他话题共享，excluded 防止进入路由、检索和简报。主入口的显式全库阅读/备份可查看私密内容；它不是多用户访问控制系统。给 worker 检索必须使用 readerTopicId。合并私密源后目标变为私密，撤销合并不自动放宽目标隐私。改变隐私无法删除过去已经分享进原生会话的内容，但后续事实通知会撤销继续使用的资格。

事实的 confirmed 只表示它与插件保存的用户输入字面证据相符，不表示独立证实事实真伪。主模型应原样转交用户输入，不能编造原话。导入消息不参与确认/撤回证据。当前未记录原生工具结果作为可验证 artifact 出处，也未自动抽取每轮事实；由主入口调用记录/撤回工具。

## 历史与持续任务

导入需要 `consent=true`，数据形如：

```json
{"version":1,"source":"my-export","topics":[{"id":"topic-1","title":"示例","private":true,"messages":[{"id":"message-1","role":"user","text":"用户原文"}]}]}
```

source、topic id、message id 决定重复数据，不按标题删除或合并。缺省导入为私密；相同消息 ID 的不同内容报冲突。当前不是 DSH 数据库直读器，也不自动扫描 Codex 历史。导入/合并后的简报携带有限的最近历史，长历史需要显式检索；没有承诺把整个旧会话灌入模型上下文。

持续任务仅对用户指定的公共 GitHub PR 作只读检查，带期限和次数预算，无外部消息发送。失败摘要是规则摘要，尚未做模型分析和自动修复。服务器存活时检查，退出期间不会自动唤醒；重开继续读取已存队列。GitHub 未认证 API 的访问/速率限制会记录为错误并退避。

## 可选 hook

包内 `optional-hooks/hooks.json` 未参与默认发现。若希望启用，可在 root plugin.json 的 `extensions.com.openai` 加 `"hooks":"./optional-hooks/hooks.json"`，重新构建/安装，使用宿主 Review hooks 审阅。不要直接改可信哈希或绕过审阅。

hook 只读取配置，确认 session_id 已启用后返回固定的工具流程提醒；不复制 prompt/历史、不启动 worker。它只在主模型遵循工具流程时形成闭环，不能证明主聊天已被完全接管。worker 继承 `THEONE_WORKER=1`，避免 hook 和 MCP 再次递归派单。hook 与 MCP 必须使用同一个数据目录。
