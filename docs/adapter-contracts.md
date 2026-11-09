# TheOne 的 Codex 适配层约定

状态：目标设计草案，部分已实现。该边界用于保留 TheOne 的行为，同时隔离不同宿主的会话、模型、历史和权限差异；当前实现与目标的差距见 [实现记录](implementation-status.md)。

## 消息与标识

| 对象 | 必须携带的信息 | 约束 |
| --- | --- | --- |
| 主入口输入 | gatewayId、稳定 messageId、用户原文、附件引用、来源、时间、replyTo（若有） | 原文与路由补充材料分开；不把 hook 的 `session_id` 直接认作 worker 的 threadId |
| 话题 | topicId、标题、摘要、约束、状态、项目引用、共享范围 | 通用实体，不能继承整个 DSH Agent 类型 |
| 宿主会话引用 | backend、hostId、serverId、threadId | 名称和标题不作主键；一个话题有明确的执行会话绑定 |
| 执行引用 | routeId、inputId、threadId、turnId、attemptId | 重试与重新路由区分记录；同一输入只能有一个有效执行归属 |
| 来源引用 | backend、threadId、turnId、itemId、可选内容范围及读取时间 | DSH 的数值 seq 不能直接翻译为 Codex itemId |
| 待答项 | requestId、threadId、turnId、itemId、请求内容、有效期、状态 | 「继续」「同意」须解析到实际待答对象，不能批准最近任意一个请求 |
| 前台注意力 | 最近实际展示的回复、所属话题、暂离前话题 | 后台完成时间较新不能自动替换前台焦点 |

路由模型输出的 topicId、projectId、folder 只作为候选结果。核心需验证它们属于当前允许的集合；模型生成的路径不能自行扩大工作区或权限。

## 六个宿主边界

| 边界 | 负责什么 | 主要输入与输出 |
| --- | --- | --- |
| `RoutingModelPort` | 一次有上限的分类请求、JSON 校验、超时与取消、用量记录 | 路由候选、当前输入、证据 → decision、usage、error；不执行工作工具 |
| `ThreadPort` | 创建/恢复/续接/取消工作、读取执行状态 | 会话引用、用户输入、许可范围 → thread/turn 引用与事件流 |
| `HistoryPort` | 授权范围内的列表、分页、检索、原文读取 | scope、cursor、query → 带出处的片段与下一页游标 |
| `ApprovalPort` | 识别请求来源、展示操作、等待明确答复、提交一次结果 | 待答项 → allow/deny/cancel/expired；不能用路由置信度替代授权 |
| `PresentationPort` | 显示回复、进展、话题目录与待答项，记录展示位置 | 规范事件 → 展示回执；不重新执行工具 |
| `CapabilityPort` | 返回当前 host 的可用接口、版本与实验功能开关 | 宿主握手与探测结果 → capability snapshot；缺失时显式降级 |

以上名称是项目内部建议接口，不是已经存在的 Codex SDK 类或可直接调用的 API。

## 模型调用与上下文

优先验证用户已配置的 Codex 执行方式是否适合路由；第一轮可以从规则路由和显式 MCP 调用入手。若最终需要独立模型 API，单独配置与记账，不读取或复用 DSH 凭证。

`turn/start.outputSchema` 出现在本机普通协议中，可以作为结构化输出的候选路径；这不证明新会话默认没有其他指令、插件或工具。分类器的工具禁用与上下文隔离需要运行时验证。

沿用简报按变化发送的策略，但缓存命中必须同时满足：话题绑定未变、内容未变、引用仍在该会话有效上下文中、压缩后状态可确认。不要只用文本哈希假定资料仍在模型窗口里。

历史正文始终以资料身份传递。hook 输出可能进入高优先级上下文，因此 hook 中只放固定控制说明和可信标识；历史片段经受控工具读取，并明确与当轮用户指令分开。

## 执行与恢复

建议以持久事件和宿主真实状态对齐，至少区分 `received`、`routed`、`queued`、`running`、`waiting_user`、`completed`、`failed`、`interrupted`；展示状态独立记录为 `not_shown` 或 `shown`。

- 发起回合前持久化 message→route→thread 映射。`clientUserMessageId` 的存在不能作为服务端保证恰好执行一次的证据。
- `turn/steer` 失败后先检查实际 turn 状态；不能一边重试 steer 一边另起 turn。
- 断线后先查宿主已保存的 turn/item，已完成结果只补展示；有副作用或状态不明的运行不自动重放。
- 用户要求换话题时，记录纠错并停止旧运行；已发生的文件修改不能用会话回退冒充撤销。
- 同一项目的队列由一个服务持有；多个进程共享数据需要额外租约机制。保留权限收紧的传播，等待队列结束后再次检查。
- 不手工修改 Codex 自己的数据库或 rollout 文件；不伪造已执行工具事件来获得原生卡片效果。

## 数据迁移

新库建议使用 `topics`、`host_threads`、`routes`、`runs`、`deliveries`、`pending_requests`、`source_refs`、`catalog_consent` 等逻辑实体，名称可随实现调整。保存 schemaVersion、导入批次和原始来源。

默认不导入旧 DSH 聊天。用户选择导入时，从副本或明确的导出文件读取，经范围过滤后建立只读历史来源；旧记录先标记为 DSH 历史，不能假装为可继续运行的 Codex 会话。仅有 TheOne 的 contexts.db 不足以搬走 DSH 保存的完整对话。
