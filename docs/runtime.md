# 本地运行与使用

本次说明对应 2026-11-10 工作区源码及客户端适配 0.4.3；尚未生成/安装新发布包。既有 `dist/` 和正在运行的插件不会自动获得这些改动。

## 入口与数据

`node dist/main.js serve` 启动 stdio MCP；`node dist/main.js doctor` 只初始化本机 Codex 并读取一个模型目录条目；`node dist/main.js hook` 从 stdin 读取 hook JSON。

数据目录按 `THEONE_DATA_DIR` → `PLUGIN_DATA/theone` → 用户目录 `.gpt-theone` 选择。分别保存 `topics.db`、`runtime.db`、`tasks.db`，使用 SQLite WAL。Windows 安装器迁移 `gpt-theone@theone-local` 到 `theone@theone-codex` 时，把原数据路径固定为新 MCP 的 `THEONE_DATA_DIR`，保持原位，不因插件改名使用新的空目录。多个候选目录会要求显式指定路径；卸载默认保留数据。安装流程见 [INSTALL.md](../INSTALL.md)。备份应停止服务器后复制全部数据库，或用 SQLite 一致性备份；JSON 导出只覆盖话题/消息，不是执行状态、任务、学习记录和合并日志的完整灾备。工具不会直接修改 Codex 私有数据库。

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
2. `theone_dispatch`：传本轮原文、稳定的 inputId；可指定 topicId。返回 runId 或澄清问题。同一请求重试不更换 ID；新的请求使用新的 ID。`foreground=false` 表示后台输入，不改变主聊天挂载；省略为前台。仅附件输入允许 `text=""`，通过 `attachments` 传原生 image/audio 的 url 或 fileId、localImage/localAudio 的 path，或 `{type:"mention",name,path}` 文件引用；图片可指定 detail，上限 20 个。没有通用二进制上传接口。
3. `theone_wait`：一次最多等待 20 秒。queued/running 不是完成；等待期间继续观察，或按用户要求取消。
4. 等待审批或问题时，把原请求内容交给用户，再用精确 runId/approvalId 回答。支持命令、文件变更、用户问题；不支持的宿主请求返回错误，不会自动授权。
5. 呈现最终结果后 `theone_acknowledge`。默认沿用输入的 foreground，可明确设置 false 标记后台通知；前台确认才更新短接续的回复焦点。结果落盘后可补发，不重做工具动作。

如果同一话题正在本连接持有的原生回合中回答，新的输入通过 `turn/steer` 补入，使用匹配的 expectedTurnId，不另开工作回合。补充输入有自己的幂等 ID，与原回合共享结果、提问/审批和取消；不确定的 steering 失败标记为失败，禁止自动重放。其他连接拥有的工作和尚未拿到 turnId 的工作仍走队列。

模型标记 aside 时建立一次性小话题，保留原话题挂载；回答完成标记 done，实际呈现并确认后气泡收起。裸 `继续` 返回原话题，`为什么` 等短追问仍可接刚呈现的小话题。没有原话题时保持未挂载状态。纠错记录参与后续模型路由；附件只决定归属和转交，不会伪造用户原文。

MCP server 关闭会中断自己拥有的正在执行/排队任务。进程意外死亡的运行会标记 interrupted，保留已收集输出；不自动重试不确定的回合。多个服务器共享同一数据目录时以数据库租约串行执行；审批和取消目前必须回到拥有该运行的连接。PID 被系统复用时采用保守行为，可能需要原连接释放或人工检查，不保证自动解锁。

同一个 Git 项目、相同或祖先/子目录会排队；不同 linked worktree、外部程序及不共享数据目录的插件实例不在锁的保证范围。排队时保存的只读权限不会因后续配置变宽而自动升级，后续收紧立即用于开始执行前的检查。

## 分类与共享

新网关默认 `routerMode=auto`：显式 `topicId` 优先；主模型的高置信 `proposal` 通过可见性、排除、同名和规则强匹配检查后直接采用，否则进入模型路由，失败再退回规则。已有网关保存的 `rules` 不变；`rules` 完全不调用路由模型，`model` 不采用 proposal 快捷路径。

未配置 `THEONE_ROUTER_URL` 时使用已有 Codex 登录。路由与历史整理共用 App Server 客户端实现，复用连接，每次建立独立 ephemeral 只读线程，禁用工具、插件、MCP 和环境，使用结构化输出。单次决定默认超时15秒，环境变量 `THEONE_ROUTER_TIMEOUT_MS` 可调整。`theone_router_models` 列出 `model/list` 提供的选择，`theone_router_configure` 接受 `modelSettings: { model, effort, fast }`，单独保存在 `router-model-settings`，不修改历史整理设置。默认优先 Luna、低思考、标准速度；保存的模型失效会报错并退回规则，不替换成别的模型。

模型路径复用语义校验和复核提示词：CREATE、CLARIFY 或唯一证据冲突会复核；截断目录尚有遗漏候选时最多追加三页复核。可恢复错误每层最多两次；超时和模型设置错误不重试。回执 `receipt` 记录 `source`（explicit / preroute / proposal / codex / http / rules / fallback）、总耗时、实际模型和调用明细，失败时同时返回 `routingError`。设置界面的路由模型与历史整理复用相同组件，选择独立保存。

### 发送时预路由

客户端适配在已绑定的主聊天发送原文时调用 `theone_preroute({gatewayId,inputId?,text})`，既有原生发送不等待 MCP。预路由运行相同的规则和 Codex/HTTP 复核重试路径，不启动 worker、不写正式路由消息。原生发送入口目前不给稳定 turn_id，因此客户端以文本哈希入队；可选 hook 能取得 turn_id 时，同文本队列项会绑定到该 ID，避免双触发重复调用。

缓存保存在 runtime.db，key 为 gatewayId+inputId，或 gatewayId+NFKC/空白规范化文本的 SHA-256。TTL 3 分钟、最多 200 条；相同 key 不重复推理，inputId 换原文报冲突；匿名项只被一个 dispatch inputId 消费。活动项占满时拒绝新的预路由请求，发送继续正常运行。多个服务连接使用数据库事务领取任务，死亡进程的未完成预路由可被重新领取。

dispatch 的显式 topicId 丢弃预路由；已完成缓存直接使用；缓存进行中且有经过校验的 high proposal 时立即采用 proposal，晚到结果写入最多 200 条的 `preroute-shadow` 一致性记录。无可用 proposal 时只等待原预路由，整体截止时间从它启动时算起（30 秒封顶，各模型调用仍遵守原超时），不再另开一次调用；失败回退规则。缓存过期或不存在时走原流程。落盘前重新检查启用、可见性和隐私。

`receipt.waitMs` 是 dispatch 等待预路由的实际毫秒数，完成缓存为 0；`elapsedMs` 是本次 dispatch 路由阶段的时间，`callDetails` 保留预路由发生的调用记录，不能误读为 dispatch 新增调用。proposal 不增加路由调用，但已经启动的预路由仍可能消耗额度。

手动测量（**会消耗额度，本次未运行**）：

```powershell
node --experimental-transform-types scripts/measure-preroute.mjs
# 可选：--delays 3,5 --rounds 2 --model <模型 ID> --effort low --fast --output <结果路径>
```

脚本用合成样本、独立临时数据库和真实路由连接模拟发送→等待→dispatch；worker 为本地完成桩，不执行用户任务或调用工作模型。默认输出 `evidence/preroute-latency.json`，按延迟档位给出全部样本和成功模型样本的 waitMs p50/p90，并列出规则、缓存、失败数量。不能用失败回退的零等待证明模型提速。

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

hook 确认 session_id 已启用且不是 worker 后，返回固定的工具流程提醒；有 turn_id 和 prompt 时，以最多 25 ms 数据库锁等待写入预路由队列。它会短期保存本轮 prompt，不复制历史、不等待模型、不启动 worker；失败静默，服务每 500 ms 领取队列。提醒里只有身份/流程，没有嵌入 prompt。dispatch 必须使用同一个 turn_id。

hook 只在主模型遵循工具流程时形成闭环，不能证明主聊天已被完全接管。worker 继承 `THEONE_WORKER=1`，避免递归派单。hook 与 MCP 必须使用同一个数据目录；服务未运行时队列不会执行，并在 TTL 后失效。

## 气泡事件、合并与更新

`theone_desktop_state({profileId,cursor?})` 返回紧凑快照、按序事件、cursor、eventFloor 和 reset。游标含 epoch、全局 seq、gatewayId；只返回本主聊天及全局管理事件。最多保留 2048 条事件，首次读取、游标超界、换网关或换数据库时重置为当前快照，不补播过时动画。客户端拒绝更旧的同 epoch 快照，合并终态也不会被旧 queued 回执覆盖。

`theone_merge_topics({sourceId,targetId,whenIdle:true,requestId})` 返回持久操作，忙时排队，空闲执行，5 分钟未执行即过期。相同 requestId 的同方向请求复用操作，不同方向报冲突。`theone_cancel_merge({operationId})` 取消尚未开始的合并。完成支持原有 unmerge；失败/取消/过期通过 mergeEnded 告知。`theone_correct_route` 的源或目标忙时返回带 `statusCode:409` 的 MCP 错误，气泡显示原有对应提示。

重复建议使用 DSH 相似度，同项目才成为候选。有路由模型时先保存候选，服务完全空闲后每批最多复核 4 对，每个话题最多选 3 个候选、待处理队列最多 128 对。仅 sameMatter 且 confidence≥0.85 才展示建议，默认方向遵循 keepId；模型判断不作为用户接受记录，不执行合并。复核使用同一 Codex/HTTP 提供方和路由设置，禁用执行工具；用户新输入中断复核，编辑/隐藏/私密/关闭网关后的旧结果作废，失败按 30/60/120 秒退避、最多 3 次。无模型/rules 模式使用严格规则建议。规则建议有效期 5 分钟，模型复核建议 30 分钟。

`theone_answer_suggestion({suggestionId,response,direction?})` 的 response 为 accept/decline/later；accept 进入同一排队合并流程，重复接受沿用已选方向，decline 持久抑制，later 保留待定。接受后编辑任一话题会使排队请求失效。模型内部理由不进入气泡/用户选择记录。

启动服务和打开设置时检查固定公开 GitHub API `YunongDai2005/theone-codex/releases/latest`，不带 token、不读取账户凭据、不跟随重定向，5 秒超时，缓存 6 小时。`theone_check_updates({force:true})` 可手动刷新。只有较新且有效的 release 显示版本、官方 release 链接和手动更新说明；网络/限流/解析失败静默。公开版基准为 `0.1.0`，更新提示为下载新 Windows 包并重新运行安装程序，macOS/Linux 按 INSTALL.md 重新构建安装；没有自动执行、下载或安装。

原生会话拖入暂不支持：当前侧栏没有上游手势要求的 session 行身份，宿主桥无法可靠定位被拖入的 threadId。微信/Telegram/iMessage 桥及 DSH 工具卡片镜像不在本次实现范围。
