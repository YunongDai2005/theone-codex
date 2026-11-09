export class DesktopController {
  listeners = new Set()
  state = { gateway: null, topics: [], activity: [], loading: false, error: null, active: false, pendingTopicId: null, historyPrompt: false, historyChoices: null,
    historyModelOptions: null, historyModelSelection: null, historyModelsError: null }
  epoch = 0
  constructor(host) { this.host = host; this.record = host.load(); this.state = { ...this.state, pendingTopicId: this.record?.pendingTopicId ?? null }; this.updateActive() }
  getSnapshot = () => this.state
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(change) { this.state = { ...this.state, ...change }; for (const listener of this.listeners) listener() }
  save(record) { this.record = record; this.host.save(record) }
  updateActive() {
    const current = this.host.current(), record = this.record
    const active = !!record && (record.threadId && record.threadId === current.threadId || record.clientThreadId && record.clientThreadId === current.clientThreadId)
    if (this.state.active !== !!active) this.emit({ active: !!active })
  }
  cancelNavigation() { this.epoch++ }
  async refresh() {
    const snapshot = await this.host.call('theone_desktop_state', { profileId: this.host.profileId })
    if (snapshot.gateway) this.save({ ...(this.record?.threadId && this.record.threadId !== snapshot.gateway.gatewayId ? {} : this.record), threadId: snapshot.gateway.gatewayId, workspace: snapshot.gateway.workspace })
    this.emit({ ...snapshot, error: null }); this.updateActive()
    return snapshot
  }
  async sync() {
    this.updateActive()
    if (this.binding) return this.binding
    if (!this.record?.clientThreadId || this.record.threadId) return
    const threadId = this.host.resolveThread(this.record.clientThreadId)
    if (!threadId) return
    this.binding = (async () => {
      const snapshot = await this.host.call('theone_desktop_bind', { profileId: this.host.profileId, gatewayId: threadId, workspace: this.record.workspace,
        ...(this.state.pendingTopicId ? { topicId: this.state.pendingTopicId } : {}) })
      this.save({ ...this.record, threadId, pendingTopicId: null }); this.emit({ ...snapshot, error: null })
      this.emit({ pendingTopicId: null })
      this.updateActive()
    })().catch(error => this.emit({ error: error.message })).finally(() => { this.binding = null })
    return this.binding
  }
  open() {
    if (this.opening) return this.opening
    const epoch = ++this.epoch
    this.emit({ loading: true, error: null })
    this.opening = (async () => {
      await this.refresh(); await this.sync()
      if (epoch !== this.epoch) return
      if (this.record?.threadId) {
        await this.host.readThread(this.record.threadId)
        if (epoch !== this.epoch) return
        await this.host.openThread(this.record.threadId)
      } else if (this.record?.clientThreadId) {
        const current = this.host.current()
        if (current.clientThreadId !== this.record.clientThreadId) await this.host.openThread(this.record.clientThreadId)
      } else {
        const record = await this.host.newDraft()
        this.save({ ...record, pendingTopicId: this.state.pendingTopicId })
      }
      this.updateActive()
      if (this.state.catalog?.available && this.state.catalog.consent === 'ask') this.emit({ historyPrompt: true })
    })().catch(error => this.emit({ error: error.message })).finally(() => { this.opening = null; this.emit({ loading: false }) })
    return this.opening
  }
  async action(operation) {
    this.emit({ error: null })
    try { return await operation() } catch (error) { this.emit({ error: error.message }); return null }
  }
  async selectTopic(topicId) {
    return this.action(async () => {
      await this.refresh()
      if (topicId !== null && !this.state.topics.some(topic => topic.id === topicId)) throw Error('这个话题已不可用，请刷新目录。')
      if (this.state.gateway) {
        await this.host.call('theone_select_topic', { gatewayId: this.state.gateway.gatewayId, topicId })
        await this.refresh()
      } else {
        this.emit({ pendingTopicId: topicId })
        if (this.record) this.save({ ...this.record, pendingTopicId: topicId })
      }
      await this.open()
    })
  }
  async createTopic(title) {
    return this.action(async () => {
      const topic = await this.host.call('theone_create_topic', { title })
      await this.selectTopic(topic.topicId)
      return topic
    })
  }
  async manageTopic(topicId, change) {
    return this.action(async () => { await this.host.call('theone_manage_topic', { topicId, ...change }); await this.refresh() })
  }
  async settings(change) {
    return this.action(async () => {
      if (!this.state.gateway) throw Error('发送第一条消息后即可设置这个主聊天。')
      await this.host.call('theone_configure', { gatewayId: this.state.gateway.gatewayId, ...change }); await this.refresh()
    })
  }
  async historySessions() {
    return this.action(async () => { const choices = await this.host.call('theone_history_sessions', {}); this.emit({ historyChoices: choices }); return choices })
  }
  async historyModels() {
    this.emit({ historyModelOptions: null, historyModelSelection: null, historyModelsError: null })
    try {
      const options = await this.host.call('theone_history_models', {})
      this.emit({ historyModelOptions: options, historyModelSelection: options.selection })
      return options
    } catch (error) { this.emit({ historyModelsError: error.message }); return null }
  }
  historySelectModel(change) {
    const selection = { ...this.state.historyModelSelection, ...change }
    const model = this.state.historyModelOptions?.models.find(m => m.model === selection.model)
    if (change.model && model) {
      if (!model.reasoningEfforts.includes(selection.effort)) selection.effort = model.reasoningEfforts.includes('medium') ? 'medium' : model.defaultEffort
      if (!model.fastTier) selection.fast = false
    }
    this.emit({ historyModelSelection: { model: selection.model, effort: selection.effort, fast: selection.fast ?? false } })
  }
  async historyConsent(consent) {
    return this.action(async () => { await this.host.call('theone_history_consent', { consent,
      ...(consent && this.state.historyModelSelection ? { modelSettings: this.state.historyModelSelection } : {}) }); this.emit({ historyPrompt: false }); await this.refresh() })
  }
  async historyExclude(kind, value, excluded) {
    const before = this.state.historyChoices
    if (kind === 'session' && before) this.emit({ historyChoices: { ...before, sessions: before.sessions.map(s => s.id === value ? { ...s, excluded } : s) } })
    return this.action(async () => {
      try { const choices = await this.host.call('theone_history_exclude', { kind, value, excluded }); this.emit({ historyChoices: choices }); await this.refresh() }
      catch (error) { this.emit({ historyChoices: before }); throw error }
    })
  }
  async historyRefresh() { return this.action(async () => { await this.host.call('theone_history_refresh', this.state.historyModelSelection ? { modelSettings: this.state.historyModelSelection } : {}); await this.refresh() }) }
  async historyPause() { return this.action(async () => { await this.host.call('theone_history_pause', {}); await this.refresh() }) }
}
