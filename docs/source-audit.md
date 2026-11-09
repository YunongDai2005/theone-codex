# DSH TheOne 源码审阅

这是准备阶段的固定快照。移植后的当前行为与证据见 [实现记录](implementation-status.md)，下文「本次」指最初的源码审阅。

审阅日期：2026-11-09。源码目录为 `D:\doc\GitHub\dsh-theone`；准备材料放在 `D:\doc\ChatGPT\gpt-theone`。

## 固定基线

| 项目 | 本次读到的状态 |
| --- | --- |
| 包名与包内版本 | `dsh-theone` / `0.4.5` |
| 当前分支 | `routing-depth` |
| 当前提交 | `fe436d005be92541ceb82495eacf83d7230c2488` |
| 提交时间 | 2026-11-04 21:43:12，UTC+8 |
| 本地 main | `c2692be832b8a6955d4aad95eed2748892aa454a` |
| 本地 origin/main 缓存 | `10f196d70d69dd5e44ffe8bbdac64bc70b57f0c7`，本次未 fetch |
| 工作区 | 已跟踪文件无差异；存在本地未跟踪目录，未纳入移植材料 |
| 源码清单 | `src` 下 50 个 TypeScript 模块，已记录文件哈希和静态 import/export 依赖 |
| 运行要求 | 包声明 Node.js >=24，DSH 0.2 系列；不能直接作为 Codex 插件加载 |

完整记录见 [baseline.json](../evidence/baseline.json) 和 [source-inventory.json](../evidence/source-inventory.json)。未启动 DSH、未读取聊天数据库、未运行原项目测试；这里的结论来自当前源码与声明，不是生产运行验证。

## 实际工作链

1. `index.ts` 作为 Cordis Service 注入 DSH 的 agents、llm、sessions、sessionQuery、tools 等服务，注册 `theone` 模型适配器。
2. 主入口的 `agent/request` 和 `agent/pre-step` 拦截决定哪些消息进入路由。输入处理中还区分回复中的追问、另一件事、goal 后续回合和已在后台开始的工作。
3. 规则与模型路由结合候选话题、前台焦点、待答问题、历史证据选择话题；由 store 记录分配与状态。
4. `worker()` 为话题创建或恢复 DSH Agent，设置工作目录、模型、工具与审批/提问转发。
5. 开始执行前同步权限与计划模式；相关项目通过 `ProjectQueue` 排队。简报按内容、压缩位置与实际保留情况决定是否重发。
6. `WorkerRun` 把后台流和工具结果展示到主聊天，工具真实执行一次；恢复逻辑再从会话记录核对完成状态与副作用。

关键代码入口：

| 位置 | 作用 |
| --- | --- |
| [index.ts:324](D:/doc/GitHub/dsh-theone/src/index.ts:324) | Service 与依赖注入 |
| [index.ts:501](D:/doc/GitHub/dsh-theone/src/index.ts:501) | 注册 TheOne 模型适配器 |
| [index.ts:784](D:/doc/GitHub/dsh-theone/src/index.ts:784) | 主入口接管与回合前路由 |
| [index.ts:1926](D:/doc/GitHub/dsh-theone/src/index.ts:1926) | 话题会话、工作目录及 Agent 创建/恢复 |
| [index.ts:1984](D:/doc/GitHub/dsh-theone/src/index.ts:1984) | 权限同步 |
| [index.ts:2221](D:/doc/GitHub/dsh-theone/src/index.ts:2221) | 审批转发 |
| [index.ts:3155](D:/doc/GitHub/dsh-theone/src/index.ts:3155) | 项目队列与执行入口 |
| [index.ts:3180](D:/doc/GitHub/dsh-theone/src/index.ts:3180) | 简报去重、压缩后恢复 |
| [run.ts:14](D:/doc/GitHub/dsh-theone/src/run.ts:14) | 后台输出与工具结果镜像 |

近期提交包括重复标题归并、一次性插问的复核调整、Worker 简报按变化发送。移植应以固定提交为基线，不能只读旧版 README 后重写一个简化路由器。

## 复用边界

| 模块 | 处理建议 | 必须检查的差异 |
| --- | --- | --- |
| `types.ts`、`router.ts`、`routing-policy.ts`、`routing-evidence.ts` | 优先抽取领域逻辑 | 将 DSH 会话标识、项目含义从通用话题类型分离 |
| `routing-bindings.ts`、`routing-shadow.ts`、`learning-journal.ts` | 保留绑定、焦点与来源语义 | Codex 的 thread/turn/item 标识不能冒充 DSH 的 seq/messageId |
| `topic-memory.ts`、`linkage.ts` | 保留话题状态、简报算法 | 替换依赖类型；验证数据来源、共享范围与压缩后的有效性 |
| `store.ts`、`sqlite.ts` | 可复用存储思路及多数 SQL | `ModelSelection` 类型、会话引用、历史来源区间需要迁移；单独建立 Codex 数据库 |
| `facts.ts`、`fact-flow.ts` | 保留事实版本和出处规则 | DSH `SessionEvent` 到 Codex item/turn 的证据适配需重写 |
| `llm-router.ts`、`model-json.ts` | 拆出提示词、解析和决策校验 | `DshRouter` 的 `prepareCall`、模型选择、流结束语义与 token 统计需要替换 |
| `project-queue.ts` | 可作为单进程队列起点 | 不是跨进程锁；当前仓库根目录规则不证明 linked worktree 或外部进程写入隔离 |
| `lifecycle.ts`、`gateway-compaction.ts` | 保留恢复和摘要策略 | 事件结构、工具名、完成判定、压缩宿主接口需要替换 |
| `history-catalog.ts` | 复用归档整理的流程与 consent 语义 | DSH 会话搜索/事件分页完全换为宿主适配器 |
| `index.ts`、`run.ts` | 按职责重构为 Codex 适配层 | 深度依赖 DSH 的生命周期、Agent、工具链和模型输出镜像 |
| `client.ts` 及 UI 辅助模块 | 复用文案与产品流程，重做宿主连接 | DSH 侧栏、布局、模型选择、设置页注入不能原样搬运 |
| 更新、公告、反馈、微信、Telegram、iMessage、持续任务 | 排到核心闭环之后 | 各自涉及宿主生命周期、通信或分发；首版无需全部迁移 |

这些是基于源码的拆分判断，不是可复用代码比例测算。静态依赖清单只列直接 import/export；没有直接 DSH import 的模块，也可能通过其他文件间接依赖它。特别是 UI 文件大量使用 `import type`，类型被擦除并不代表宿主运行时耦合消失。

## 测试资产

保留原项目行为场景作为规格。优先重用路由、绑定、插问、纠错、简报、存储与项目队列相关用例的输入和预期。`tests/harness.ts` 实际装配 DSH 的 AgentLoop、SessionStore、Tools 与投影系统，其测试通过不代表 Codex 接入通过，需要新的宿主集成夹具。

迁入源码时保留原 MIT License 及版权说明；本次只生成审阅材料，没有复制整套源码或建立对 DSH 工作目录的运行时依赖。
