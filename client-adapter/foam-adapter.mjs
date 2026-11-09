// The renderer and gestures are the unchanged DSH 0.4.6 implementation. Only
// its host model and actions are translated into the local Codex plugin API.
export function foamModel(state, now = Date.now()) {
  const latest = new Map()
  for (const run of state.activity) if (!latest.has(run.topicId)) latest.set(run.topicId, run)
  const current = state.gateway?.currentTopicId ?? state.pendingTopicId
  return { topics: state.topics.map(topic => {
    const run = latest.get(topic.id), status = run?.status
    const phase = status === 'queued' ? 'queued' : ['starting', 'running'].includes(status) ? 'running'
      : status === 'waiting_approval' ? 'waiting' : ['failed', 'interrupted'].includes(status) ? 'failed'
      : status === 'completed' && !run.delivered ? 'answered' : 'idle'
    return { id: topic.id, title: topic.title, label: topic.label, current: current === topic.id,
      aside: topic.done, phase, status: status === 'starting' ? 'starting' : status === 'waiting_approval' ? 'approval' : phase,
      weight: run ? Math.max(.15, 1 - (now - run.updatedAt) / 604800000) : .4,
      lastActive: run?.updatedAt, startedAt: run?.startedAt, group: topic.groupId }
  }), merges: state.merges ?? [], links: state.links ?? [] }
}

export function foamChanges(before, after) {
  if (!before) return []
  const topics = new Set(before.topics.map(t => t.id)), runs = new Set(before.activity.map(r => r.id))
  const changes = after.topics.filter(t => !topics.has(t.id)).map(t => ({ kind: 'create', to: t.id }))
  for (const run of after.activity) if (!runs.has(run.id) && topics.has(run.topicId)) changes.push({ kind: 'route', to: run.topicId })
  return changes
}

export function foamActions(controller, host, openManager, text) {
  const invoke = (tool, args) => controller.action(async () => { await host.call(tool, args); await controller.refresh(); return true })
  const stop = async (id, queued) => {
    const run = controller.state.activity.find(r => r.topicId === id && (queued ? r.status === 'queued' : ['starting','running','waiting_approval'].includes(r.status)))
    if (run) await invoke('theone_cancel', { runId: run.id })
  }
  return {
    text, mount: id => { void controller.selectTopic(id) },
    merge: async (sourceId, targetId) => await invoke('theone_merge_topics', { sourceId, targetId }) ? 'merged' : 'failed',
    unmerge: sourceId => invoke('theone_unmerge_topic', { sourceId }),
    putAside: topicId => invoke('theone_manage_topic', { topicId, done: true }),
    stop: id => { void stop(id, false) }, cancelQueued: id => { void stop(id, true) },
    open: id => { void controller.action(async () => {
      const topic = controller.state.topics.find(t => t.id === id)
      const threadId = topic?.sourceThreadIds?.[0] ?? topic?.threadId
      if (!threadId) throw Error('这个话题还没有开始对话，可以在主聊天接着聊。')
      await host.readThread(threadId); await host.openThread(threadId)
    }) },
    showAnswer: () => { void controller.open() }, answer: () => { void controller.open() },
    openWorkspace: openManager, remove: openManager,
    // No suggestions or queued merges are advertised until their server protocol
    // is ported. Session drops cannot match the DSH selector in this native host.
    cancelMerge: async () => false, answerSuggestion: async () => 'failed', attach: async () => false, reroute: async () => 409,
  }
}
