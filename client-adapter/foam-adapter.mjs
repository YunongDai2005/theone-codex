// The renderer and gestures are the unchanged DSH 0.4.6 implementation. Only
// its host model and actions are translated into the local Codex plugin API.
export function foamModel(state, now = Date.now()) {
  const byTopic = new Map()
  for (const run of state.activity) byTopic.set(run.topicId, [...byTopic.get(run.topicId) ?? [], run])
  const current = state.gateway?.currentTopicId ?? state.pendingTopicId
  const live = new Set(['routing','starting','running','recovering'])
  return { topics: state.topics.map(topic => {
    const runs = byTopic.get(topic.id) ?? [], run = runs[0]
    const waiting = runs.find(r => r.status === 'waiting_approval'), working = runs.find(r => live.has(r.status)), queued = runs.find(r => r.status === 'queued')
    const phase = waiting ? 'waiting' : working ? 'running' : runs.some(r => r.status === 'completed' && !r.delivered) ? 'answered'
      : queued ? 'queued' : ['failed','interrupted'].includes(run?.status) ? 'failed' : 'idle'
    const status = waiting ? waiting.waitingKind ?? 'approval' : working?.status ?? phase
    return { id: topic.id, title: topic.title, label: topic.label, current: current === topic.id,
      asking: !!waiting || !!state.clarification?.candidateIds.includes(topic.id), oneOff: !!topic.oneOff,
      aside: !!topic.done && phase === 'idle' && current !== topic.id, phase, status, queueReason: queued?.queueReason,
      weight: run ? Math.max(.15, 1 - (now - run.updatedAt) / 604800000) : .4,
      lastActive: run?.updatedAt, startedAt: run?.startedAt, group: topic.groupId }
  }), merges: state.merges ?? [], links: state.links ?? [],
    pendingMerges: (state.pendingMerges ?? []).map(op => ({ id: op.sourceId, into: op.targetId, operationId: op.operationId, state: op.state })),
    suggestions: (state.suggestions ?? []).filter(s => s.state === 'pending' && s.expiresAt > now && s.pair.every(id => state.topics.some(t => t.id === id)) &&
      !(state.pendingMerges ?? []).some(op => s.pair.includes(op.sourceId) || s.pair.includes(op.targetId)))
      .map(s => ({ id: s.suggestionId, a: s.pair[0], b: s.pair[1], directions: s.directions })) }
}

export function foamChanges(before, after) {
  if (!before || after.reset) return []
  return foamEventsFrom((after.events ?? []).filter(e => e.seq > (before.cursor?.seq ?? 0)), after)
}

// Ported from DSH a943701 client-foam-host: history is played against its final
// snapshot; terminal merge observations never regress on delayed/replayed reads.
export function foamEventsFrom(events, snapshot) {
  const items = new Map((snapshot.workItems ?? snapshot.activity ?? []).map(item => [item.id, item])), out = []
  for (const event of events) {
    if (event.type === 'route.assigned') {
      if (event.created) out.push({ kind: 'create', to: event.contextId })
      else if (event.source === 'steering' || items.get(event.workItemId)?.source === 'steering') out.push({ kind: 'supplement', to: event.contextId })
      else out.push({ kind: 'route', to: event.contextId, alternates: event.alternateIds, messageId: event.messageIds[0] })
    } else if (event.type === 'route.blocked' && event.candidateIds.length > 1) out.push({ kind: 'clarify', candidates: event.candidateIds })
    else if (event.type === 'route.resolved') out.push({ kind: 'resolve', to: event.contextId })
    else if (event.type === 'route.moved') out.push({ kind: 'correct', from: event.fromId, to: event.toId, messageId: event.messageId })
    else if (event.type === 'topic.merged') out.push({ kind: 'merged', id: event.sourceId, into: event.targetId })
    else if (event.type === 'topic.unmerged') out.push({ kind: 'unmerged', id: event.sourceId, into: event.targetId })
  }
  return settleFoamEvents(out, snapshot)
}
export function settleFoamEvents(events, snapshot) {
  const present = new Set(snapshot.topics.map(topic => topic.id)), last = new Map()
  events.forEach((event, i) => { if (event.kind === 'merged' || event.kind === 'unmerged') last.set(event.id, i) })
  return events.filter((event, i) => event.kind === 'merged' ? last.get(event.id) === i && !present.has(event.id)
    : event.kind === 'unmerged' ? last.get(event.id) === i && present.has(event.id) : true)
}
const TERMINAL = new Set(['succeeded','cancelled','expired','failed'])
export function mergeOutcomes(seen, merges) {
  const out = []
  for (const merge of merges) {
    const was = seen.get(merge.operationId)
    if (was && TERMINAL.has(was)) continue
    seen.set(merge.operationId, merge.state)
    if (was !== 'queued' && was !== 'executing') continue
    if (merge.state === 'succeeded') out.push({ kind: 'merged', id: merge.sourceId, into: merge.targetId, undo: true })
    else if (TERMINAL.has(merge.state)) out.push({ kind: 'mergeEnded', id: merge.sourceId, into: merge.targetId, failed: merge.state !== 'cancelled', ...merge.error ? { error: merge.error } : {} })
  }
  return out
}

export function foamActions(controller, host, openManager, text) {
  const invoke = (tool, args) => controller.action(async () => { await host.call(tool, args); await controller.refresh(); return true })
  const result = (tool, args) => controller.action(async () => { const value = await host.call(tool, args); await controller.refresh(); return value })
  const stop = async (id, queued) => {
    const run = controller.state.activity.find(r => r.topicId === id && (queued ? r.status === 'queued' : ['starting','running','waiting_approval'].includes(r.status)))
    if (run) await invoke('theone_cancel', { runId: run.id })
  }
  return {
    text, mount: id => { void controller.selectTopic(id) },
    merge: async (sourceId, targetId) => {
      const op = await result('theone_merge_topics', { sourceId, targetId, whenIdle: true, requestId: crypto.randomUUID() })
      return op?.state === 'succeeded' ? 'merged' : ['queued','executing'].includes(op?.state) ? 'queued' : 'failed'
    },
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
    cancelMerge: async operationId => (await result('theone_cancel_merge', { operationId }))?.state === 'cancelled',
    answerSuggestion: async (suggestionId, response, direction) => (await result('theone_answer_suggestion', { suggestionId, response, ...(direction ? { direction } : {}) }))?.outcome ?? 'failed',
    attach: async () => false,
    reroute: async (inputId, topicId) => {
      try { await host.call('theone_correct_route', { gatewayId: controller.state.gateway?.gatewayId, inputId, topicId }); await controller.refresh(); return 200 }
      catch (error) { return error.statusCode ?? (/TOPIC_BUSY|CANCEL_RUN_BEFORE_CORRECTION/.test(error.message) ? 409 : 400) }
    },
  }
}
