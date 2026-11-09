# 发送预路由与 DSH 行为补齐汇报

日期：2026-11-10。仓库：`D:\doc\ChatGPT\gpt-theone`；分支：`codex-login-router`。对照 DSH 的固定提交 `a943701`（0.4.6），不以该仓库当前工作区推断版本行为。

## 交付状态

任务所列代码、测试、测量脚本和能力文档已落到工作区。服务端/上游 **214/214**、客户端 **38/38** 测试通过；类型检查与隔离编译通过，无跳过测试。代码尚未安装、发布或经过本版真实模型/桌面视觉验收。

任务说明明确要求“**不要尝试 git add 或 commit，改动留在工作区**”，因此未暂存、提交或推送；`dist/`、`release/`、`.theone/`、`node_modules/` 和安装客户端保持不动。没有改 `client-adapter/upstream/`、气泡绘制和样式。工作期间出现的 README.md、README.en.md、docs/images/ 和其他 router-latency 结果属于外部并行改动，已原样保留，不计入本次交付。

## 实现与文件

| 范围 | 文件 | 做法 |
| --- | --- | --- |
| 预路由队列 | `src/preroute.ts`、`src/service.ts`、`src/hook.ts`、`src/llm-router.ts` | 持久去重、文本规范化、跨连接领取、3 分钟 TTL、200 条上限、原截止时间、显式丢弃/完成复用/进行中 proposal 与影子/等待回退；消费前后检查配置与可见性；hook 只入队 |
| 原生发送触发 | `client-adapter/send-patch.mjs`、`native-host.mjs`、`desktop-controller.mjs`、`desktop-ui.mjs`、`build.mjs`、`renderer-patch.mjs` | 在实际安装包的 turn-start 入口发本地事件，经现有 MCP 传输预路由；只处理已绑定主聊天；发送不 await；失败隔离；发送与导航文件分别哈希校验；适配版本升至 0.4.3，避免覆盖既有副本 |
| 气泡事件 | `src/desktop-events.ts`、`src/runtime-store.ts`、`src/service.ts`、`client-adapter/foam-adapter.mjs` | 顺序日志与 epoch/seq/网关游标、2048 条保留、重置协议；移用 DSH 三个事件处理函数；终态不回退；asking/oneOff/queueReason/细分状态 |
| 建议与排队合并 | `src/topic-merges.ts`、`src/merge-vetting.ts`、`src/routing-policy.ts`、`src/codex-router.ts`、`src/http-router.ts` | 严格规则候选和空闲模型复核；批量 4 对/候选 3 对/队列 128；0.85 置信度；指纹/代次/领取租约；用户输入打断；保存接受/拒绝；忙时预约、取消、过期、失效、撤销与跨库提交恢复 |
| 路由行为与 worker | `src/service.ts`、`src/backend.ts`、`src/codex-backend.ts` | aside 临时返回/收起；短接续；实际 foreground；纠正记录；turn/steer 幂等及结果/追问共享；权限收紧后排队，防止把只读新输入补进仍可写的旧回合；原生图片/音频/文件引用转交 |
| 设置与更新 | `client-adapter/model-picker.mjs`、`desktop-controller.mjs`、`desktop-ui.mjs`、`src/update-check.ts`、`src/main.ts` | 路由和历史共用同一控件，独立保存；费用说明；启动/设置公开 GitHub 检查、缓存/静默失败、版本和手动命令，不下载、不执行 |
| MCP 接口 | `src/mcp-server.ts` | 新增 preroute/check_updates/cancel_merge/answer_suggestion；desktop_state 游标；merge_topics 排队；dispatch 附件/foreground；纠正忙碌错误携带 409 |
| 测量 | `scripts/measure-preroute.mjs` | 独立临时库与合成样本，默认 3/5 秒等待后调用真正的 dispatch 逻辑；仅路由用真实模型，worker 用本地完成桩；输出逐条 waitMs、分档 p50/p90、来源与失败数量；**只做语法检查，未运行** |
| 文档 | `docs/implementation-status.md`、`docs/runtime.md`、本文件 | 更新实际能力、接口/队列/费用语义、使用命令、已验与未验边界 |

测试文件新增 `tests/preroute.test.ts`、`bubble-parity.test.ts`、`routing-parity.test.ts`、`merge-vetting.test.ts`、`update-check.test.ts`，以及客户端的 `send-patch.test.mjs`、`model-picker.test.mjs`；扩充 `tests/mcp.test.ts`、`codex-router.test.ts`、`worker.test.ts` 和客户端 controller/host/foam 的既有测试。

进程内测试入口为 `tests/setup-in-process.mjs`；受限客户端测试入口为 `tests/setup-client-prebuilt.mjs` 与 `tests/fixtures/prebuilt-esbuild.mjs`。更新 `tests/fixtures/app-server.mjs`、`router-app-server.mjs`、`in-process-router.mjs`，在保留生产 JSON-RPC 编解码、存储和服务逻辑的情况下模拟 App Server 进程。任何不属于测试夹具的 spawn 请求直接失败，防止误调用真实模型。

## DSH 对照清单

| 任务项 | 核对及结果 |
| --- | --- |
| route/create/supplement/clarify/resolve/correct | 服务端产生持久事件；route 含 alternates 与原 inputId；客户端按游标消费，补充映射 supplement；不再从快照差异猜测 |
| merged/unmerged/mergeEnded | 移用 `foamEventsFrom`、`settleFoamEvents`、`mergeOutcomes`；队列成功给 undo:true，取消/失败/过期给终态；旧事件不能复活已撤销合并或冲掉新终态 |
| FoamTopic 状态 | asking 来自候选点名/待答；oneOff 来自临时话题；queueReason 来自实际项目/话题锁；question/approval 和实际细分状态直传 |
| 重复建议 | 核对 `routing-policy`、`merge-vetting` 与 index/store 的建议生命周期；复核结果与用户选择分离，keepId 决定默认方向，接受后进入同一合并队列，拒绝持久抑制 |
| 排队合并 | 忙时排队、幂等预约、取消、5 分钟过期、无效目标失败；跨两个数据库中断后修复合并映射再写完成回执 |
| 改派 | 调用真实 correct_route；源/目标忙时结构化 409，由上游原有提示处理；不自动撤销实际副作用 |
| aside | 无论有无当前话题都创建 temporary；有原话题时不改挂载；完成并确认呈现后折叠；裸继续返回，解释性短追问仍找刚显示的临时答复 |
| steering | 已复制可实现部分：本连接当前 native turn 以 expectedTurnId 补入；重复输入不重复 steer；失败不重放；共享后续追问/审批/结果与取消。另一个 MCP 连接拥有的 turn 或无 turnId 时走原队列，保留所有权边界 |
| 短接续 | 前台回复、待答对象、临时返回参与快捷判断；冲突不强行套用快捷路径，保留模型判定 |
| 仅附件 | 已从本机 CLI 只读生成的 TurnStartParams schema 核对 image/localImage/audio/localAudio/mention；空 text 直接转交原生格式，不伪造原文。通用二进制上传没有 DSH file block 等价接口 |
| foreground/纠正记录 | 后台完成不抢主挂载与回复焦点；acknowledge 默认沿用来源；纠正记录送入后续路由。完整反事实学习撤回与已执行副作用回滚仍不由当前主聊天接口保证 |
| attach | 按任务允许保留不可用：上游手势寻找 `data-row-key="session:<id>"`，实际 Codex 侧栏未暴露该行身份，当前 bridge 无可靠拖放目标 threadId。当前会话 ID 或任意 DOM 文本不能代替被拖入会话的身份 |
| 设置 | 模型、思考档位、⚡ 快速共用 ModelPicker 与既有样式；路由/历史保存互不覆盖；提示 proposal、发送预路由与空闲复核的费用边界 |
| 更新 | 固定公开 GitHub API、不传 token、不重定向、5 秒超时、6 小时缓存、失败静默；仅显示版本与手动命令 |
| 不适用 | 微信/Telegram/iMessage 桥依赖 DSH 服务端；工具卡片镜像依赖 DSH 宿主渲染。两项按任务明确不做；自动下载/安装更新也未实现 |

## 验证结果与复现

- [服务端及上游完整日志](../evidence/parity-tests.log)：**214/214**，0 失败、0 跳过。覆盖预路由各分支/去重/超时/容量/hook/跨连接/配置失效、游标、排队合并/建议、MCP 409、aside/foreground/steering/附件、模型复核、mock fetch 更新检查和全部既有回归。
- [客户端完整日志](../evidence/parity-client-tests.log)：**38/38**，0 失败、0 跳过。包含实际安装包导航与发送代码的补丁测试、原发送返回值和异常隔离、主聊天限定、游标乱序、终态保护、手势、共用设置组件。
- [类型检查](../evidence/parity-typecheck.log)：`npm.cmd run typecheck` 退出 0。生产 TypeScript 通过 `tsc -p tsconfig.build.json --outDir <TEMP>/theone-parity-20261110/service` 编译，退出 0。
- desktop-ui 与原 dsh-cell 由现有 esbuild.exe 直接编译至 TEMP；使用真实编译结果执行全部客户端测试。`node --check scripts/measure-preroute.mjs` 退出 0；未执行测量脚本。
- `git diff --check` 通过；受保护的 upstream/气泡样式与绘制目录没有本次差异。没有运行会写 `.theone/`、dist 或 release 的 npm build/client:build。

受限环境不能从 Node spawn 子进程，因此服务测试仅替换 App Server 的进程边界；esbuild 的 Node 启动也遭遇 EPERM，改由直接 shell 编译。没有用“跳过测试”代替成功。PowerShell 重定向日志中会把 Node 的 ExperimentalWarning 标为 NativeCommandError，最终按 Node 的真实 `$LASTEXITCODE` 与测试统计判断结果。

服务测试与语法检查：

```powershell
npm.cmd run typecheck
node --experimental-transform-types --import ./tests/setup-in-process.mjs --test --test-isolation=none tests/*.test.ts tests/upstream/*.test.ts
node --check scripts/measure-preroute.mjs
```

受限环境的客户端验证（在仓库根目录直接运行；只写 TEMP）：

```powershell
$taskTemp = Join-Path $env:TEMP 'theone-parity-20261110'
New-Item -ItemType Directory -Path $taskTemp -Force | Out-Null
$env:THEONE_TEST_DESKTOP_BUNDLE = Join-Path $taskTemp 'desktop.js'
$env:THEONE_TEST_CELL_BUNDLE = Join-Path $taskTemp 'cell.js'
& ./node_modules/@esbuild/win32-x64/esbuild.exe client-adapter/desktop-ui.mjs --bundle --platform=browser --format=iife --global-name=TheOneDesktop --target=es2022 --legal-comments=none --log-level=error "--outfile=$env:THEONE_TEST_DESKTOP_BUNDLE"
if ($LASTEXITCODE -ne 0) { throw 'Desktop compilation failed' }
& ./node_modules/@esbuild/win32-x64/esbuild.exe client-adapter/dsh-cell.ts --target=es2022 --log-level=error "--outfile=$env:THEONE_TEST_CELL_BUNDLE"
if ($LASTEXITCODE -ne 0) { throw 'Cell compilation failed' }
node --import ./tests/setup-client-prebuilt.mjs --test --test-isolation=none client-adapter/*.test.mjs
```

## 风险与未做的验收

1. 本轮没有真实模型调用、实际预路由 p50/p90 或真实桌面发送→主模型→dispatch 整链测量；不能宣称已经降低用户实测延迟。原生发送测试执行的是实际安装包代码加受控桥接，不能代替窗口交互验收。
2. 本版适配限定 `26.1103.4239.0` 的两个文件哈希。客户端升级后会拒绝打补丁，需要重新核对入口；没有改安装客户端，也没有自动启用可选 hook。
3. 无原生 turn_id 时依赖短期规范化文本哈希，重复同文只供一个 inputId 消费；之后同文请求正常重新路由。hook 的 turn_id 对应更可靠，但需要宿主支持并启用。
4. 发送即开始的预路由可能产生此前 proposal 快捷路径没有的模型成本；影子结果不会撤销已经发生的计费。空闲语义合并复核也使用模型，已在设置/运行文档写明。
5. 合并建议的真实准确率、大目录负载、音频/图片的真实模型理解能力、原生审批点击和本版气泡视觉尚未验收。API/schema 与模拟协议通过不代表这些用户体验已经验收。
6. 任务写法与本机 CLI 小差异已自行处理：本机插件更新命令使用 `marketplace upgrade` 与 `plugin add`（由本机 help 核对），不是不存在的 `plugin update`。显示命令没有被执行。

按任务边界，后续由用户运行测量、构建/安装验收及 git 提交。本汇报没有把这些未执行动作算作完成。
