# TheOne for Codex

把 DSH TheOne 的「一个入口聊多件事，每件事保有独立上下文」迁入本地 Codex。插件当前是 **0.1.0-alpha.9**，客户端适配为 **0.4.2**。以 DSH **0.4.6 / a943701** 为当前界面基线：在「新聊天」下面保留主聊天卡片，卡片下直接显示话题细胞，使用 Codex 原有输入框与回复区。

已抽取 DSH 的话题、路由、事实、学习记录和持久任务核心，接入真正的 Codex App Server，并提供 Skills + MCP 插件包。没有对原 DSH 源码或聊天数据库做修改。

## 已实现

- 话题创建、目录、重命名、摘要、进度、完成状态、分组、约束、隐私、关联与排除；合并、撤销合并和删除。
- 本地规则路由、指定话题，以及可选 OpenAI 兼容模型路由；候选校验、失败回退、纠错记录与重复输入去重。
- 每个话题独立 Codex 会话，创建、恢复、排队、取消和手动压缩；同项目与重叠目录串行，排队后重新检查权限。
- 命令/文件审批及用户问题转发；请求绑定、过期处理、拒绝与取消，不重放已经执行的工具。
- SQLite 持久化、本地历史搜索、分页阅读、version 1 JSON 导入/导出；来源 ID 去重，导入内容不充当已确认事实。
- 原生历史整理：首次询问、后期手动启动、会话/文件夹排除、LLM 按轮次分类并复用已有话题；每批最多 16 轮、两段聊天并行分类，已有话题只返回归属和变化字段，逐批生成气泡，支持暂停、重启恢复和增量去重。
- 有出处的事实记录、版本、查找和撤回；共享范围过滤，已引用事实变化时附带通知。
- 有期限和次数上限的公共 GitHub PR 只读持续任务，本地通知及暂停、恢复、取消。
- TheOne 全局导航入口、原生会话话题面板、入口技能、43 个 MCP 工具、可选主聊天 hook、独立打包服务器和本地 marketplace。
- 本机客户端适配：固定主聊天、重复点击保留草稿、发送后保存原生会话身份；直接移用 DSH 0.4.6 的细胞绘制、名称悬停、详情和所有话题筛选。
- 细胞操作接入真实话题服务：在主聊天继续、先放一边、空闲话题合并与撤销、停止运行或取消排队；设置支持启用、工作权限和共享范围。

## 本机使用

完全退出当前 Codex（包括旧版 TheOne），然后双击桌面 **Codex TheOne**。按钮位于「新聊天」下面；首次点击在原生输入框中附上 TheOne 插件，直接输入任务即可，之后回到同一个主聊天。话题细胞来自实际话题库，空库不会显示演示细胞。启动器不会关闭当前对话，原版安装和快捷方式保留。

首次点击还会显示“整理以前的聊天”：选择模型、思考强度及参与的会话后开始，或暂时跳过。默认优先 **GPT-6 Luna＋中度思考＋标准速度**，可点亮 **⚡ 快速** 加速并增加消耗。模型及能力来自当前 Codex 的可用目录；没有 Luna 经济选项时要求手动选择，已保存的模型不可用时不会悄悄换模型。设置只用于历史整理，不修改 Codex 全局模型；点击开始后保存，重启仍沿用。

以后右键 TheOne → 设置 → **整理历史**，也可从“管理话题”打开并更换模型；运行中先暂停。整理使用现有 Codex 登录，会消耗模型额度。完成的批次直接形成气泡，原聊天不修改；选择气泡后继续使用原生输入框。整理只在本地插件进程运行时推进，暂停或关闭后已完成批次保留。

alpha.9 会在两批同时提出新话题时，用同一模型做一次简短的归属核对，减少重复气泡；这次调用也计入每轮 64 次请求的限制。仍有可整理积压时约一秒后续跑，空闲或失败后按正常间隔检查。默认仍是 Luna、中度思考、快速关闭；本次提速不靠提高模型档位。

这是针对 Windows 客户端 `26.1103.4239.0` 的本地适配副本，原版升级后需要重新适配。构建、验证、启动和恢复说明见 [客户端适配](docs/client-adapter.md)。

## 构建与运行

需要 Node.js 24+、npm 和已登录的 Codex CLI。本机验收版本为 Node 24.21.0、Codex CLI 0.167.0-alpha.3.2。

```powershell
npm ci --ignore-scripts
npm run check
npm run doctor
```

构建产物是 `release/gpt-theone`，连同依赖打包，不需要在安装副本中再执行 npm install。生成 ZIP：

```powershell
powershell -NoProfile -File scripts/package.ps1
```

从本机目录安装（这两条会修改使用者自己的 Codex 插件配置）：

```powershell
codex plugin marketplace add D:/doc/ChatGPT/gpt-theone/release
codex plugin add gpt-theone@theone-local
```

安装或更新后重启桌面。在当前桌面版本中，TheOne 全局入口先出现在「探索 / 更多」中，固定后进入应用总导航。点击它时，插件请求打开预填启用内容的 **Codex 原生聊天草稿**，补充任务后发送。在原生会话面板中打开「TheOne 话题」可以创建或选择话题，将引用加入原来的输入框。也可在项目聊天中使用 `$theone`。

**仅安装插件与客户端适配的区别：** `global` 入口的固定与排序控制应用总导航；公开扩展协议没有「新聊天」相邻位置的插槽。上面的本机客户端适配单独实现了这个位置，不能只靠安装插件获得。此前的诊断保留在 [桌面入口记录](evidence/desktop-entrypoint-diagnosis.json)。

插件自身的原生草稿桥接通过了模拟宿主浏览器验收。客户端适配的实际窗口检查另见 [client-adapter-runtime.json](evidence/client-adapter-runtime.json)，两者不混作同一种证据。宿主未声明 `openai/message` 时，插件入口明确提示不支持，不替换成独立聊天页面。插件安装检查见 [local-installation-ui.json](evidence/local-installation-ui.json)，验证边界见 [实现记录](docs/implementation-status.md)。接口依据：[Plugin Extensions](https://developers.openai.com/plugins/build/extensions)，打包依据：[插件结构](https://developers.openai.com/plugins/build/plugins) 和 [本地 MCP 配置](https://developers.openai.com/plugins/deploy/desktop-only)。

默认使用本地规则分类及 Codex 已有登录；执行沙箱默认只读。模型分类接口、数据目录、可选 hook 的配置见 [运行说明](docs/runtime.md)。hook 默认未启用；它是指定聊天的提醒入口，宿主仍需要 [审阅并信任 hook](https://learn.chatgpt.com/docs/hooks)。

## 验证范围与后续

自动测试覆盖迁入核心和新适配器；真实验证记录见 [实现与验证记录](docs/implementation-status.md)。

当前输出由主聊天读取 MCP 结果后呈现。细胞侧栏已接入；DSH 原生工具卡片镜像、完整候选路由事件流、排队合并、重复话题建议、前台指代、临时插问返回、消息桥和自动更新仍需迁移。持续任务依赖本地进程存活。当前 alpha 不能按 DSH 全功能等价版发布。

源码基线是 DSH TheOne `0.4.5` 的开发分支快照 `fe436d005be92541ceb82495eacf83d7230c2488`。保留原 MIT 许可和来源说明：[UPSTREAM.md](UPSTREAM.md)。准备阶段的 [源码审阅](docs/source-audit.md)、[移植方案](docs/port-plan.md)、[适配层约定](docs/adapter-contracts.md)、[完整验收清单](docs/acceptance.md) 继续作为后续规格；当前状态以实现记录为准。
