import { DesktopController } from './desktop-controller.mjs'
import { createNativeHost } from './native-host.mjs'
import { createFoam, foamCss } from './upstream/client-foam.ts'
import { zh, en } from './upstream/client-locales.ts'
import { foamModel, foamChanges, foamActions } from './foam-adapter.mjs'

const statusText = { queued: '排队中', starting: '正在开始', running: '进行中', waiting_approval: '等待确认', completed: '已完成', failed: '未完成', interrupted: '已中断', cancelled: '已取消' }
const effortText = { none: '不思考', minimal: '最低', low: '轻度', medium: '中度', high: '深度', xhigh: '更深', max: '最高', ultra: '超高' }

export function useDesktop({ React, scope, modules, preview, startDraft, css }) {
  const h = React.createElement
  const candidate = createNativeHost({ scope, modules, preview, startDraft })
  const host = React.useMemo(() => candidate, [scope, candidate.profileId])
  host.preview = preview
  const controller = React.useMemo(() => new DesktopController(host), [host])
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [panel, setPanel] = React.useState(null), [query, setQuery] = React.useState(''), [name, setName] = React.useState('')
  const [editing, setEditing] = React.useState(null), [pending, setPending] = React.useState(false)
  const [historyQuery, setHistoryQuery] = React.useState('')
  const dialog = React.useRef(null), openPanel = value => { setPanel(value); void controller.action(() => controller.refresh()) }
  const foamElement = React.useRef(null), openManager = React.useRef(null)
  openManager.current = () => openPanel('topics')
  React.useEffect(() => {
    const element = foamElement.current, button = element.previousElementSibling
    const locale = document.documentElement.lang.startsWith('en') ? en : zh
    const text = (key, vars = {}) => {
      let value = locale['foam.' + key] ?? key
      for (const [name, replacement] of Object.entries(vars)) value = value.replaceAll('{' + name + '}', String(replacement))
      return key === 'menuWorkspace' ? '管理话题' : value
    }
    const style = document.createElement('style')
    style.textContent = foamCss.replaceAll('[data-ds-dark-theme]', ':is(.dark,[data-theme="dark"],[data-color-scheme="dark"])')
      + '.theone-foam.theone-codex-foam{position:relative;left:auto;top:auto;width:100%;flex:none;z-index:20;--dsw-specific-sidebar-fill:var(--color-background-primary,#1f1f22);--dsw-alias-label-primary:var(--color-text-primary,CanvasText);--dsw-alias-label-secondary:var(--color-text-secondary,GrayText)}'
      + '.theone-foam-pop,.theone-foam-menu,.theone-foam-tip,.theone-foam-undo{color-scheme:light;--dsw-alias-label-primary:var(--color-text-primary,CanvasText);--dsw-alias-label-secondary:var(--color-text-secondary,GrayText);--dsw-specific-menu:#fff;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-interactive-bg-hover:#8882}'
      + ':is(.dark,[data-theme="dark"],[data-color-scheme="dark"]) :is(.theone-foam-pop,.theone-foam-menu,.theone-foam-tip,.theone-foam-undo){color-scheme:dark;--dsw-specific-menu:#242528;--dsw-alias-bg-base:#242528;--dsw-alias-bg-layer-2:#242528}'
    document.head.append(style)
    const foam = createFoam({ host: element,
      mark: () => button?.querySelector('.theone-symbol'),
      side: () => button?.parentElement ?? null,
      actions: foamActions(controller, host, () => openManager.current(), text), onHeight: () => {},
      onPulse: amount => { const mark = button?.querySelector('.theone-symbol'); if (mark) mark.style.transform = amount > .002 ? `scale(${1 + .12 * amount})` : '' },
    })
    let previous
    const update = () => {
      const next = controller.getSnapshot()
      if (previous && previous.topics === next.topics && previous.activity === next.activity && previous.gateway === next.gateway && previous.pendingTopicId === next.pendingTopicId) return
      foam.update(foamModel(next))
      for (const change of foamChanges(previous, next)) foam.event(change)
      previous = next
    }
    update(); const unsubscribe = controller.subscribe(update)
    const resize = new ResizeObserver(() => foam.setRail(element.clientWidth < 100)); resize.observe(element)
    return () => { unsubscribe(); resize.disconnect(); foam.destroy(); style.remove() }
  }, [controller, host])
  React.useEffect(() => {
    const style = document.createElement('style'); style.textContent = css; style.dataset.theoneControls = 'true'; document.head.append(style)
    let lastLocation = host.current().locationKey
    const stop = host.watch(value => {
      if (controller.opening && !host.openingNative && lastLocation !== value.locationKey) controller.cancelNavigation()
      lastLocation = value.locationKey
      void controller.sync()
    }, () => controller.record?.clientThreadId)
    // Resolve a persisted main once. Subsequent polling is scoped to the active main or its controls.
    void controller.action(() => controller.refresh())
    return () => { controller.cancelNavigation(); stop(); style.remove() }
  }, [controller, host])
  React.useEffect(() => {
    if (!state.active && !panel && !state.topics.length && !state.catalog?.running) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void controller.action(() => controller.refresh()) }, 5000)
    return () => clearInterval(timer)
  }, [controller, state.active, panel, !!state.topics.length, state.catalog?.running])
  React.useEffect(() => {
    if (state.historyPrompt) { setPanel('history'); controller.emit({ historyPrompt: false }) }
  }, [controller, state.historyPrompt])
  React.useEffect(() => { if (panel === 'history') { void controller.historySessions(); void controller.historyModels() } }, [controller, panel])
  React.useEffect(() => {
    if (panel && !dialog.current.open) dialog.current.showModal()
    else if (!panel && dialog.current.open) dialog.current.close()
  }, [panel])
  const currentTopicId = state.gateway?.currentTopicId ?? state.pendingTopicId
  const currentTopic = state.topics.find(topic => topic.id === currentTopicId)
  const runFor = id => state.activity.find(run => run.topicId === id)
  const waiting = state.activity.filter(run => run.status === 'waiting_approval').length
  const working = state.activity.filter(run => ['queued', 'starting', 'running'].includes(run.status)).length
  const perform = async operation => { if (pending) return; setPending(true); try { await operation() } finally { setPending(false) } }
  const choose = topicId => perform(async () => { await controller.selectTopic(topicId); if (!controller.getSnapshot().error) setPanel(null) })
  const entry = (text, onClick, props = {}) => h('button', { type: 'button', onClick, disabled: pending, ...props }, text)
  const topics = state.topics.filter(topic => `${topic.title} ${topic.summary ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const history = state.catalog, historyChoices = state.historyChoices
  const modelOptions = state.historyModelOptions, modelSelection = state.historyModelSelection
  const selectedModel = modelOptions?.models.find(m => m.model === modelSelection?.model)
  const modelValid = !!selectedModel && selectedModel.reasoningEfforts.includes(modelSelection.effort) && (!modelSelection.fast || !!selectedModel.fastTier)
  const modelDisabled = pending || history?.running
  const included = historyChoices?.sessions.filter(s => !s.excluded).length ?? 0
  const historyTitle = history?.consent === 'granted' ? '整理历史' : '整理以前的聊天'
  const title = panel === 'history' ? historyTitle : panel === 'settings' ? 'TheOne 设置' : '管理话题'
  const historyAction = async () => perform(async () => {
    if (history?.consent === 'granted') await controller.historyRefresh()
    else await controller.historyConsent(true)
    if (!controller.getSnapshot().error) setPanel(null)
  })
  const historyPanel = h('div', { className: 'theone-history', 'data-theone-history': true },
    h('p', null, '把以前聊过的事情整理成话题气泡，从这里接着聊。'),
    h('p', { className: 'theone-muted' }, '先选整理模型和思考强度。会消耗当前 Codex 账户的模型额度，原聊天保留原样。'),
    h('div', { className: 'theone-history-models' },
      modelOptions ? h(React.Fragment, null,
        h('label', { className: 'theone-history-model-label' }, '整理模型', h('select', { 'aria-label': '整理模型', value: modelSelection?.model ?? '', disabled: modelDisabled,
          onChange: e => controller.historySelectModel({ model: e.target.value }) },
          !selectedModel && h('option', { value: modelSelection?.model ?? '', disabled: true }, modelSelection?.model ? `${modelSelection.model}（当前不可用）` : '请选择模型'),
          ...modelOptions.models.map(m => h('option', { key: m.model, value: m.model }, m.displayName + (m.model === modelOptions.recommendedModel ? ' · 经济推荐' : ''))))),
        h('div', { className: 'theone-history-model-detail' },
          h('label', null, '思考强度', h('select', { 'aria-label': '思考强度', value: modelSelection?.effort ?? '', disabled: modelDisabled || !selectedModel,
            onChange: e => controller.historySelectModel({ effort: e.target.value }) },
            selectedModel && !selectedModel.reasoningEfforts.includes(modelSelection?.effort) && h('option', { value: modelSelection?.effort ?? '', disabled: true }, '请选择思考强度'),
            ...(selectedModel?.reasoningEfforts ?? []).map(e => h('option', { key: e, value: e }, effortText[e] ?? e)))),
          entry('⚡ 快速', () => controller.historySelectModel({ fast: !modelSelection?.fast }), { className: 'theone-history-fast', 'aria-label': '快速模式', 'aria-pressed': !!modelSelection?.fast,
            disabled: modelDisabled || !selectedModel?.fastTier, title: selectedModel?.fastTier ? '更快返回，消耗更多额度' : '此模型不支持快速模式' })),
        h('p', { className: 'theone-muted' }, history?.running ? '如需更换模型或速度，请先暂停整理。'
          : !selectedModel ? '请选择一个当前可用的模型。' : !selectedModel.fastTier ? '当前模型不支持快速模式。'
          : modelSelection.fast ? '⚡ 已开启快速：更快返回，会增加额度消耗。' : '标准速度 · 更省额度；可点亮闪电开启快速。'),
        h('p', { className: 'theone-muted' }, '点击开始后保存选择，后续整理沿用。只影响历史整理。'))
        : state.historyModelsError ? h('div', { role: 'alert', className: 'theone-native-error' }, '读取模型失败：', state.historyModelsError, entry('重新读取模型', () => controller.historyModels()))
        : h('p', { role: 'status' }, '正在读取可用模型…')),
    state.error && h('p', { role: 'alert', className: 'theone-native-error' }, state.error),
    history?.running ? h('p', { role: 'status', className: 'theone-history-progress' }, `正在整理 · 已完成 ${history.indexed} 个会话`, history.currentTitle ? ` · ${history.currentTitle}` : '')
      : history?.paused ? h('p', { role: 'status' }, '已暂停，整理好的话题已保留。')
      : history?.lastCompletedAt && history?.consent === 'granted' ? h('p', { role: 'status' }, `已整理 ${history.indexed} 个会话`) : null,
    !!history?.failed && h('p', { role: 'alert', className: 'theone-native-error' }, `${history.failed} 个会话暂未整理完成，稍后可以重试。`, h('details', null, h('summary', null, '查看原因'), history.error)),
    historyChoices ? h(React.Fragment, null,
      h('div', { className: 'theone-history-selection' }, h('strong', null, `选择会话 · ${included} / ${historyChoices.sessions.length}`),
        h('input', { type: 'search', placeholder: '搜索会话或文件夹', 'aria-label': '搜索历史会话', value: historyQuery, onChange: e => setHistoryQuery(e.target.value) })),
      h('p', { className: 'theone-muted' }, '取消勾选的会话不会被读取，之后也可以调整。'),
      h('div', { className: 'theone-history-choices' },
        ...[...new Set(historyChoices.sessions.map(s => s.cwd ?? ''))].map(folder => {
          const sessions = historyChoices.sessions.filter(s => (s.cwd ?? '') === folder && `${s.title} ${folder}`.toLowerCase().includes(historyQuery.toLowerCase()))
          if (!sessions.length) return null
          const folderExcluded = historyChoices.folders.find(f => f.path === folder)?.excluded
          return h('fieldset', { key: folder }, h('legend', null, folder ? h('label', null,
            h('input', { type: 'checkbox', checked: !folderExcluded, disabled: pending, 'aria-label': `整个文件夹 ${folder}`, onChange: e => perform(() => controller.historyExclude('folder', folder, !e.target.checked)) }), h('span', { title: folder }, folder)) : '未分组'),
            sessions.map(s => h('label', { key: s.id, className: 'theone-history-choice' },
              h('input', { type: 'checkbox', checked: !s.excluded, disabled: pending || folderExcluded, 'aria-label': s.title, onChange: e => perform(() => controller.historyExclude('session', s.id, !e.target.checked)) }),
              h('span', null, s.title))))
        }), !historyChoices.sessions.length && h('p', null, '还没有可以整理的旧聊天。')))
      : h('p', { role: 'status' }, '正在读取会话目录…'),
    h('footer', { className: 'theone-history-actions' },
      history?.running ? entry('暂停整理', () => perform(() => controller.historyPause()))
        : entry(history?.consent === 'granted' ? history.paused ? '继续整理' : '再次整理' : `整理 ${included} 个会话`, historyAction, { className: 'theone-history-primary', disabled: pending || !historyChoices || !included || !modelValid }),
      history?.consent !== 'granted' ? entry('暂时跳过', () => perform(async () => { await controller.historyConsent(false); if (!controller.getSnapshot().error) setPanel(null) }))
        : entry('关闭自动整理', () => perform(() => controller.historyConsent(false)))))
  const controls = h(React.Fragment, null,
    h('div', { ref: foamElement, className: 'theone-codex-foam', 'data-theone-cells': true }),
    h('div', { className: 'theone-native-tools', 'data-theone-controls': true, 'data-empty': !state.topics.length },
      !state.topics.length && entry('管理话题', () => openPanel('topics'), { 'aria-label': 'TheOne 管理话题', className: 'theone-space-entry' }),
      entry('⚙', () => openPanel('settings'), { 'aria-label': 'TheOne 设置', title: 'TheOne 设置', className: 'theone-settings-entry' })),
    (history?.running || history?.paused || history?.failed > 0) && h('button', { type: 'button', className: 'theone-history-status', onClick: () => openPanel('history') },
      history.running ? `整理历史中 · ${history.indexed} 个完成` : history.paused ? '历史整理已暂停' : '历史整理需要重试'),
    state.error && h('div', { className: 'theone-native-error', role: 'status' }, 'TheOne：', state.error, entry('重试', () => controller.action(() => controller.refresh()))),
    h('dialog', { ref: dialog, className: 'theone-native-dialog', 'aria-label': title, onCancel: () => setPanel(null), onClose: () => setPanel(null), onClick: event => { if (event.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setPanel(null) } } },
      h('header', null, h('h2', null, title), entry('×', () => setPanel(null), { 'aria-label': '关闭' })),
      panel === 'history' ? historyPanel : panel === 'settings' ? h('div', { className: 'theone-native-settings' },
        history?.available && h('div', { className: 'theone-history-settings' }, entry('整理历史', () => openPanel('history')), h('span', { className: 'theone-muted' }, '把旧聊天整理成话题气泡')),
        h('p', { className: 'theone-muted' }, state.gateway?.workspace ?? '发送第一条消息后，主聊天会自动保存在当前项目中。'),
        h('label', null, '启用 TheOne', h('input', { type: 'checkbox', disabled: !state.gateway || pending, checked: state.gateway?.enabled ?? true, onChange: event => perform(() => controller.settings({ enabled: event.target.checked })) })),
        h('label', null, '工作权限', h('select', { disabled: !state.gateway || pending, value: state.gateway?.sandbox ?? 'read-only', onChange: event => perform(() => controller.settings({ sandbox: event.target.value })) }, h('option', { value: 'read-only' }, '只读'), h('option', { value: 'workspace-write' }, '允许修改当前项目'))),
        h('label', null, '话题间共享', h('select', { disabled: !state.gateway || pending, value: state.gateway?.linkScope ?? 'auto', onChange: event => perform(() => controller.settings({ linkScope: event.target.value })) }, h('option', { value: 'auto' }, '自动关联'), h('option', { value: 'workspace' }, '同一项目'), h('option', { value: 'off' }, '关闭'))),
        h('p', { className: 'theone-muted' }, '私密话题不会向其他话题分享内容。')) : h(React.Fragment, null,
        h('div', { className: 'theone-native-toolbar' }, h('input', { type: 'search', placeholder: '搜索话题', 'aria-label': '搜索话题', value: query, onChange: event => setQuery(event.target.value) }), entry('自动分话题', () => choose(null)), history?.available && entry('整理历史', () => openPanel('history')), entry('刷新', () => controller.action(() => controller.refresh()))),
        h('form', { className: 'theone-native-new', onSubmit: event => { event.preventDefault(); if (!name.trim()) return; void perform(async () => { if (editing) await controller.manageTopic(editing, { title: name.trim() }); else await controller.createTopic(name.trim()); if (!controller.getSnapshot().error) { setName(''); setEditing(null); if (!editing) setPanel(null) } }) } },
          h('input', { 'aria-label': editing ? '话题新名称' : '新话题名称', placeholder: editing ? '修改话题名称' : '开始一件新事情…', value: name, maxLength: 80, onChange: event => setName(event.target.value) }),
          h('button', { type: 'submit', disabled: pending || !name.trim() }, editing ? '保存名称' : '新话题'), editing && entry('取消', () => { setEditing(null); setName('') })),
        h('div', { className: 'theone-native-topics' }, topics.length ? topics.map(topic => {
          const run = runFor(topic.id)
          return h('article', { key: topic.id, className: 'theone-native-topic', 'data-active': topic.id === currentTopicId },
            entry(h(React.Fragment, null, h('strong', null, topic.title), h('small', null, topic.private ? '私密' : topic.done ? '已完成' : topic.id === currentTopicId ? '正在聊' : '')), () => choose(topic.id), { className: 'theone-topic-heading' }),
            topic.summary && h('p', null, topic.summary),
            run && h('div', { className: 'theone-run-state', 'data-status': run.status }, statusText[run.status] ?? run.status, run.status === 'completed' && !run.delivered ? ' · 有新结果' : ''),
            h('footer', null, entry('继续聊', () => choose(topic.id)), (topic.threadId || topic.sourceThreadIds?.length) && entry('查看原始对话', () => controller.action(async () => { const id = topic.sourceThreadIds?.[0] ?? topic.threadId; await host.readThread(id); await host.openThread(id); setPanel(null) })),
              h('details', null, h('summary', { 'aria-label': `${topic.title}的操作` }, '…'), h('div', { className: 'theone-topic-menu' },
                entry('重命名', () => { setEditing(topic.id); setName(topic.title) }),
                entry(topic.done ? '恢复进行中' : '标为完成', () => perform(() => controller.manageTopic(topic.id, { done: !topic.done }))),
                entry(topic.private ? '取消私密' : '设为私密', () => perform(() => controller.manageTopic(topic.id, { private: !topic.private })))))))
        }) : h('p', { className: 'theone-native-empty' }, query ? '没有匹配的话题' : '把不同的事情交给 TheOne，它们会出现在这里。'))),
      state.error && h('p', { role: 'alert', className: 'theone-native-error' }, state.error)))
  return { active: state.active, open: () => controller.open(), contextMenu: event => { event.preventDefault(); openPanel('settings') },
    subtitle: state.loading ? '正在打开…' : state.gateway?.enabled === false ? '已停用 · 右键设置' : currentTopic && state.active ? currentTopic.title : '从这里继续聊', controls }
}
