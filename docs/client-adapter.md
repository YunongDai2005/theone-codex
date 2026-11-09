# 本机客户端适配

当前适配 0.4.2 对齐 DSH 0.4.6（远端 main `a943701`）。TheOne 放在 Codex 的「新聊天」下方，卡片下面直接显示细胞团。按钮、细胞物理、悬停名称、详情、所有话题筛选及拖拽手势移用 DSH 原代码；聊天内容保留在 Codex 原有输入框及回复区。

## 使用

桌面快捷方式为 **Codex TheOne**，也可以运行项目根目录的 `启动 TheOne Codex.vbs`。

1. 从「文件」菜单完全退出当前 Codex，包括旧版 TheOne。
2. 双击桌面「Codex TheOne」。
3. 点击「新聊天」下面的 TheOne 卡片，输入任务并发送。首次草稿只附上插件引用，不预填一大段启用话术。

启动器发现原版或旧适配副本仍在运行时，会提示先退出，避免旧窗口接管新启动请求。它不会关闭正在进行的对话。日常启动器不带调试端口，也不更改登录、模型或执行权限。

重复点击返回同一草稿，已输入内容保留。首次发送后监听 Codex 的原生草稿绑定并保存真实聊天 ID，后续恢复固定主聊天。身份按用户、账户和本机宿主隔离；缺失原会话时提示错误，不自动制造另一个入口。选择细胞后在主聊天继续，不替用户发消息。

有话题时，点细胞查看详情，拖到主聊天继续，甩出侧栏先放一边，拖到另一个空闲话题上合并并可撤销。下方的小细胞图标打开所有话题及筛选。更多管理是次级面板。右键主聊天卡片或点击小齿轮打开设置。

## 来源和适配范围

- `client-adapter/dsh-cell.ts`：从本机 DSH `src/client.ts` 直接复制的曲线、细胞、季节图标与动画实现。
- `client-adapter/dsh-button.css`：从同一文件直接复制的卡片、图标和字标样式。
- `client-adapter/brand-source.json`：来源文件的 SHA-256 和复制记录。
- `client-adapter/upstream/client-foam.ts`、`client-locales.ts`：原样复制 DSH 0.4.6 的细胞团与文案；完整哈希见 `foam-source.json`。
- `client-adapter/foam-adapter.mjs`：把真实话题、执行状态、已读状态和用户动作映射到原绘制器。生产包不含演示话题或伪造运行状态。
- `client-adapter/brand.mjs`：将 DSH 的主题标记和文字颜色变量映射到 Codex；保留 DSH 的 64px 高度、12px 圆角、间距和原配色。
- `client-adapter/renderer-patch.mjs`：在 Codex 的两种导航布局中加入按钮，并调用原生的项目感知新聊天入口。插件引用放进可编辑草稿，点击本身不发送模型消息。

未接通的部分包括完整候选路由事件流、排队合并、重复话题建议和 DSH 原生工具卡片镜像。当前忙碌话题不能合并，失败不会播放成功结果；支持空闲话题立即合并和撤销。收到快照时的基本新话题和新任务动画可以显示，但不是 DSH 逐事件完整复刻。

## 构建和验证

仅适配 Windows x64 的 `OpenAI.Codex_26.1103.4239.0`。构建前检查已知渲染资源 SHA-256；未知版本或重复补丁直接拒绝。

```powershell
npm run client:test
npm run client:build
npm run client:verify
npm run client:install
```

构建目标已存在时不会覆盖。每个适配版本使用独立目录；修改后应更新 `ADAPTER_VERSION` 再构建。

构建器从本机原版复制运行时到 `.theone/desktop-client/`，修改副本的渲染资源，重新计算 ASAR 文件与根完整性哈希。没有关闭完整性检查、修改功能开关、覆盖 WindowsApps 原安装或注册新的系统协议。

这是本地修改的客户端副本，其可执行文件已不同于官方签名发行文件。该运行时不属于本项目 MIT 授权的代码，也不作为本项目的分发包；每位使用者需从自己的本机安装生成。DSH 移入的代码保持原 MIT 来源说明。

实机验证启动独立测试配置的副本，检查按钮位置、动画、草稿身份与保留、细胞、详情、筛选、切换和设置，不发送模型消息。为不改动真实话题库，仅在测试窗口内把话题工具连接到独立真实 MCP 服务器；原生导航及输入框不替换。实际安装的原生 MCP 发现与状态读取另由 `verify-installed.mjs` 检查。首次真实发送后的绑定与重启恢复由控制器/服务测试覆盖，本轮未进行真实模型回合验收。用户日常配置下的体验确认仍是独立步骤。记录见：

- [构建记录](../evidence/client-adapter-build.json)
- [实际窗口检查](../evidence/client-adapter-runtime.json)
- [快捷方式安装记录](../evidence/client-adapter-install.json)

## 更新与恢复

alpha.7 / 0.4.2 的“整理历史”面板增加模型选择、思考强度和 ⚡ 快速。首次默认 Luna / 中度 / 标准速度，启动后保存，手动整理可重新选择；不支持快速时禁用闪电按钮。流程验证使用 `THEONE_VERIFY_HISTORY=1 node client-adapter/verify-runtime.mjs`，测试窗口接合成历史源、受控分类结果和真实 MCP 服务；检查默认设置、快速开关、保存后的恢复、跳过、后期开启、会话排除、自动气泡与原生草稿保留。真实模型和原生历史读取结构另见 `evidence/history-real-model.json`，不把 UI 夹具当成用户历史的模型验收。

原版更新后，需要重新核对客户端资源并适配；当前副本不会自动获得原版新版本代码。不要将未知版本强行套用本补丁。

恢复原版时，退出 TheOne 副本并使用原来的 Codex 快捷方式即可。原安装和原快捷方式均保留。TheOne 快捷方式依赖本项目及 `.theone/desktop-client/`，移动或删除项目后需重新安装快捷方式。
