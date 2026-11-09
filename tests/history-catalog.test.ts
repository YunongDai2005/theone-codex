import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'

const turn = (id: string, text: string) => ({ id, status: 'completed', items: [{ id: 'u-' + id, type: 'userMessage', content: [{ type: 'text', text }] }, { id: 'a-' + id, type: 'agentMessage', text: '已记录：' + text }] })
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-catalog-'))
  const chats = [
    { id: 'old-a', title: '混合会话', cwd: dir, updatedAt: 100, turns: [turn('v1', '云南旅行路线'), turn('v2', '小说章节计划')] },
    { id: 'old-b', title: '继续旅行', cwd: dir, updatedAt: 101, turns: [turn('v3', '云南旅行酒店')] },
  ]
  let reads = 0, calls = 0, answer: ((input: any, signal: AbortSignal) => Promise<unknown>) | undefined
  const selections: unknown[] = []
  const source = { list: async () => chats.map(({ turns, ...s }) => s), read: async (id: string) => { reads++; return structuredClone(chats.find(c => c.id === id)) }, close: async () => {} }
  const model = { models: async () => [
    { model: 'gpt-6-astra', displayName: 'Astra', description: '', reasoningEfforts: ['low','medium','high'], defaultEffort: 'medium', fastTier: 'priority' },
    { model: 'gpt-6-luna', displayName: 'Luna', description: '', reasoningEfforts: ['low','medium'], defaultEffort: 'medium', fastTier: 'priority' },
  ], classify: async (input: any, signal: AbortSignal, settings?: unknown) => {
    calls++; selections.push(settings); if (answer) return answer(input, signal)
    const grouped = new Map<string, number[]>()
    for (const p of input.turns) { const title = p.text.includes('小说') ? '小说写作' : '云南旅行'; grouped.set(title, [...grouped.get(title) ?? [], p.seq]) }
    return { topics: [...grouped].map(([title, turns]) => ({ contextId: input.ownedContextId ?? input.contexts.find((c: any) => c.title === title)?.id ?? null,
      title, summary: title + '摘要', lastState: '正在规划', entities: [title], keywords: [title], turns, groupId: null, groupTitle: '个人计划', groupSummary: '旅行与写作' })) }
  }, reconcile: async (input: any) => ({ matches: input.proposals.map((p: any) => ({ proposal: p.proposal,
    contextId: input.contexts.find((c: any) => c.title === p.title)?.id ?? null })) }), close: async () => {} }
  const open = () => new TheOneService({ dataDir: dir, catalog: { source, model, ...options } } as any)
  let service = open()
  return { dir, chats, source, model, selections, get service() { return service }, reads: () => reads, calls: () => calls,
    answer: (fn: typeof answer) => { answer = fn }, restart: async () => { await service.close(); service = open() },
    close: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }) } }
}
function catalog(s: TheOneService): any { assert.ok((s as any).catalog, 'native history catalog must be available'); return (s as any).catalog }

test('first use and skipping list only metadata, never historical content or models', async () => {
  const f = fixture()
  try {
    const c = catalog(f.service)
    assert.equal(c.status().consent, 'ask')
    assert.equal((await c.sessions()).sessions.length, 2)
    await c.refresh(); await c.consent(false); await c.refresh()
    assert.equal(c.status().consent, 'declined'); assert.equal(f.reads(), 0); assert.equal(f.calls(), 0)
    assert.equal(f.service.listTopics().length, 0)
    await f.restart(); assert.equal(catalog(f.service).status().consent, 'declined')
  } finally { await f.close() }
})

test('manual consent splits mixed conversations, reuses topics across chats and publishes searchable bubbles', async () => {
  const f = fixture()
  try {
    const original = JSON.stringify(f.chats), c = catalog(f.service)
    await c.consent(true); await c.refresh()
    const topics = f.service.desktopSnapshot('profile').topics
    assert.deepEqual(topics.map(t => t.title).sort(), ['云南旅行', '小说写作'])
    const travel = topics.find(t => t.title === '云南旅行')!
    assert.equal(f.service.readTopic(travel.id).messages.length, 4)
    assert.equal(f.service.search('云南旅行酒店').length, 2)
    assert.ok((travel as any).sourceThreadIds.includes('old-b'))
    assert.equal(JSON.stringify(f.chats), original, 'source conversations are read only')
    assert.equal(c.status().indexed, 2); assert.equal(c.status().running, false)
  } finally { await f.close() }
})

test('restarting and repeated manual organization do not repeat model calls or lose the next new turn', async () => {
  const f = fixture()
  try {
    await catalog(f.service).consent(true); await catalog(f.service).refresh()
    const calls = f.calls(), reads = f.reads()
    await f.restart(); await catalog(f.service).refresh()
    assert.equal(f.calls(), calls); assert.equal(f.reads(), reads)
    f.chats[1].turns.push(turn('v4', '云南旅行机票')); f.chats[1].updatedAt++
    await catalog(f.service).refresh()
    assert.equal(f.calls(), calls + 1); assert.equal(f.service.listTopics().length, 2)
    assert.equal(f.service.search('云南旅行机票').length, 2)
  } finally { await f.close() }
})

test('session and folder exclusions prevent reads and hide imported content from routing/search', async () => {
  const f = fixture()
  try {
    const c = catalog(f.service)
    await c.exclude('session', 'old-a', true); await c.consent(true); await c.refresh()
    assert.equal(f.reads(), 1); assert.equal(f.service.listTopics().length, 1)
    await c.exclude('folder', f.dir, true); await c.refresh()
    assert.equal(f.reads(), 1); assert.equal(f.service.listTopics().length, 0); assert.equal(f.service.search('酒店').length, 0)
    await c.exclude('folder', f.dir, false); await c.refresh()
    assert.equal(f.service.listTopics().length, 1)
  } finally { await f.close() }
})

test('revoking consent during model work prevents late classification from being imported', async () => {
  const f = fixture()
  let begun!: () => void
  const started = new Promise<void>(r => { begun = r })
  f.answer(async (_input, signal) => { begun(); await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true })); return { topics: [] } })
  try {
    const c = catalog(f.service); await c.consent(true); const running = c.refresh(); await started
    await c.consent(false); await running
    assert.equal(f.service.listTopics().length, 0); assert.equal(c.status().consent, 'declined')
  } finally { await f.close() }
})

test('invalid LLM assignments fail visibly, can be retried, and never create phantom topics', async () => {
  const f = fixture()
  f.answer(async () => ({ topics: [{ contextId: 'invented', turns: [999] }] }))
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(f.service.listTopics().length, 0); assert.ok(c.status().failed > 0)
    f.answer(undefined); await c.refresh()
    assert.equal(f.service.listTopics().length, 2); assert.equal(c.status().failed, 0)
  } finally { await f.close() }
})

test('two MCP connections share one catalog job and deletion is not undone by another scan', async () => {
  const f = fixture(), second = new TheOneService({ dataDir: f.dir, catalog: { source: f.source, model: f.model } } as any)
  try {
    await catalog(f.service).consent(true)
    await Promise.all([catalog(f.service).refresh(), catalog(second).refresh()])
    assert.equal(f.calls(), 2); assert.equal(f.service.listTopics().length, 2)
    const writing = f.service.listTopics().find(t => t.title === '小说写作')!
    f.service.deleteTopic(writing.id); f.chats[0].updatedAt++
    await catalog(f.service).refresh()
    assert.equal(f.service.listTopics().length, 1)
  } finally { await second.close(); await f.close() }
})

test('completed batches remain usable when a later batch fails, then resume without duplicate topics', async () => {
  const f = fixture()
  f.chats.splice(1); f.chats[0].turns = Array.from({ length: 17 }, (_, i) => turn('large-' + i, '云南旅行第' + i + '天'))
  let fail = true
  f.answer(async input => {
    if (fail && input.turns.length === 1) throw Error('temporary-model-failure')
    return { topics: [{ contextId: input.contexts[0]?.id ?? null, title: '云南旅行', summary: '路线', lastState: '规划中', entities: [], keywords: [],
      turns: input.turns.map((p: any) => p.seq), groupId: null, groupTitle: '旅行', groupSummary: '' }] }
  })
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(f.service.search('第0天').length, 2)
    assert.equal(f.service.search('第16天').length, 0)
    fail = false; await c.refresh()
    assert.equal(f.calls(), 3); assert.equal(f.service.listTopics().length, 1); assert.equal(f.service.search('第16天').length, 2)
  } finally { await f.close() }
})

test('TheOne-owned topic history still updates before historical consent and inside excluded folders', async () => {
  const f = fixture()
  try {
    const topicId = f.service.createTopic('已有旅行'), c = catalog(f.service)
    f.chats[0].turns = [turn('owned', '云南旅行进展')]
    f.service.runtime.put('binding', topicId, { topicId, threadId: 'old-a', cwd: f.dir })
    await c.exclude('folder', f.dir, true); await c.refresh()
    assert.equal(c.status().consent, 'ask'); assert.equal(f.reads(), 1)
    assert.equal(f.service.listTopics().length, 1); assert.equal(f.service.search('旅行进展').length, 2)
  } finally { await f.close() }
})

test('pause survives restarting, and resuming completes pending work', async () => {
  const f = fixture()
  try {
    const c = catalog(f.service); await c.consent(true); c.pause(); await c.refresh()
    assert.equal(c.status().paused, true); assert.equal(f.reads(), 0)
    await f.restart(); await catalog(f.service).refresh(); assert.equal(f.reads(), 0)
    catalog(f.service).resume(); await catalog(f.service).refresh()
    assert.equal(f.service.listTopics().length, 2); assert.equal(catalog(f.service).status().paused, false)
  } finally { await f.close() }
})

test('permission to import a JSON file never authorizes scanning all native chats, including upgrade migration', async () => {
  const f = fixture()
  try {
    f.service.importHistory({ version: 1, topics: [] }, true)
    await f.restart(); const c = catalog(f.service); await c.refresh()
    assert.equal(c.status().consent, 'ask'); assert.equal(f.reads(), 0); assert.equal(f.calls(), 0)
  } finally { await f.close() }
})

test('a scan respects its batch budget and later scans complete the remaining turns', async () => {
  const f = fixture()
  await f.service.close()
  const service = new TheOneService({ dataDir: f.dir, catalog: { source: f.source, model: f.model, batchBudget: 1 } } as any)
  try {
    const c = catalog(service); await c.consent(true); await c.refresh()
    assert.equal(f.calls(), 1); assert.equal(c.status().pending, 1)
    await c.refresh(); assert.equal(f.calls(), 2); assert.equal(c.status().pending, 0)
    assert.equal(service.listTopics().length, 2)
  } finally { await service.close(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('removed or archived native sources leave the bubble list and restore without reclassification', async () => {
  const f = fixture()
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    const calls = f.calls(), saved = [...f.chats]
    f.chats.splice(0); await c.refresh()
    assert.equal(f.service.listTopics().length, 0); assert.equal(f.service.search('云南').length, 0)
    f.chats.push(...saved); await c.refresh()
    assert.equal(f.service.listTopics().length, 2); assert.equal(f.calls(), calls)
  } finally { await f.close() }
})

test('choosing history models consumes no inference and the selected model, effort and Fast survive restart', async () => {
  const f = fixture(), settings = { model: 'gpt-6-astra', effort: 'high', fast: true }
  try {
    const c = catalog(f.service)
    assert.equal(typeof c.models, 'function', 'history setup must offer model choices')
    assert.deepEqual((await c.models()).selection, { model: 'gpt-6-luna', effort: 'medium', fast: false })
    await c.configureModel(settings)
    assert.equal(c.status().consent, 'ask'); assert.equal(f.calls(), 0); assert.equal(f.reads(), 0)
    await f.restart()
    assert.deepEqual((await catalog(f.service).models()).selection, settings)
    await catalog(f.service).consent(true); await catalog(f.service).refresh()
    assert.deepEqual(f.selections, [settings, settings])
    const calls = f.calls()
    await catalog(f.service).configureModel({ model: 'gpt-6-luna', effort: 'medium', fast: false })
    await catalog(f.service).refresh(); assert.equal(f.calls(), calls, 'model changes must not reclassify unchanged history')
    f.chats[0].turns.push(turn('new-selected', '旅行进展')); f.chats[0].updatedAt++
    await catalog(f.service).refresh()
    assert.deepEqual(f.selections.at(-1), { model: 'gpt-6-luna', effort: 'medium', fast: false })
  } finally { await f.close() }
})

test('invalid model settings do not overwrite the saved choice or grant history consent', async () => {
  const f = fixture(), settings = { model: 'gpt-6-luna', effort: 'medium', fast: false }
  try {
    const c = catalog(f.service)
    assert.equal(typeof c.configureModel, 'function')
    await c.configureModel(settings)
    await assert.rejects(c.configureModel({ model: 'missing', effort: 'medium', fast: true }), /模型/)
    assert.deepEqual(c.status().modelSettings, settings)
    assert.equal(c.status().consent, 'ask'); assert.equal(f.calls(), 0)
  } finally { await f.close() }
})

test('twenty short historical turns are organized in two requests with every message retained', async () => {
  const f = fixture()
  f.chats.splice(1); f.chats[0].turns = Array.from({ length: 20 }, (_, i) => turn('short-' + i, '云南旅行计划第' + i + '项'))
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(f.calls(), 2, 'short turns should share larger batches instead of paying for a third request')
    assert.equal(f.service.readTopic(f.service.listTopics()[0].id).messages.length, 40)
    assert.equal(c.status().failed, 0)
  } finally { await f.close() }
})

test('larger batches keep historical text within 9600 characters without losing long turns', async () => {
  const f = fixture(), sizes: number[] = []
  f.chats.splice(1); f.chats[0].turns = Array.from({ length: 20 }, (_, i) => turn('long-' + i, '云南旅行计划'.repeat(120)))
  f.answer(async input => {
    sizes.push(input.turns.reduce((sum: number, p: any) => sum + p.text.length, 0))
    return { topics: [{ contextId: input.contexts[0]?.id ?? null, title: '云南旅行', summary: '路线', lastState: '规划中', entities: [], keywords: [],
      turns: input.turns.map((p: any) => p.seq), groupId: null, groupTitle: '旅行', groupSummary: '' }] }
  })
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(f.calls(), 2)
    assert.ok(sizes.every(size => size <= 9600), JSON.stringify(sizes))
    assert.equal(f.service.readTopic(f.service.listTopics()[0].id).messages.length, 40)
  } finally { await f.close() }
})

test('one larger batch can retain sixteen unrelated topics instead of forcing them into eight', async () => {
  const f = fixture()
  f.chats.splice(1); f.chats[0].turns = Array.from({ length: 16 }, (_, i) => turn('independent-' + i, '独立事项 ' + i))
  f.answer(async input => ({ topics: input.turns.map((p: any) => ({ contextId: null, title: '事项 ' + p.seq, summary: '独立事项', lastState: '待处理', entities: [], keywords: [],
    turns: [p.seq], groupId: null, groupTitle: '计划', groupSummary: '' })) }))
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(f.calls(), 1); assert.equal(c.status().failed, 0)
    assert.equal(f.service.listTopics().length, 16)
    assert.ok(f.service.listTopics().every(t => f.service.readTopic(t.id).messages.length === 2))
  } finally { await f.close() }
})

test('compact reuse replies update only changed metadata and keep the existing title, summary and group', async () => {
  const f = fixture()
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    const original = f.service.store.contexts().find(t => t.title === '云南旅行')!, group = f.service.store.groups().find(g => g.contextIds.includes(original.id))!
    f.chats[1].turns.push(turn('progress', '酒店已预订')); f.chats[1].updatedAt++
    f.answer(async input => ({ topics: [{ contextId: original.id, turns: input.turns.map((p: any) => p.seq), update: { summary: null, lastState: '酒店已预订', entities: null, keywords: null } }] }))
    await c.refresh()
    assert.equal(c.status().failed, 0)
    const updated = f.service.store.contexts().find(t => t.id === original.id)!
    assert.equal(updated.lastState, '酒店已预订'); assert.equal(updated.title, original.title)
    assert.equal(updated.summary, original.summary); assert.deepEqual(updated.entities, original.entities)
    assert.equal(f.service.store.groups().find(g => g.contextIds.includes(original.id))!.id, group.id)
    assert.equal(f.service.search('酒店已预订').length, 2)
    f.chats[1].turns.push(turn('no-change', '继续上次安排')); f.chats[1].updatedAt++
    f.answer(async input => ({ topics: [{ contextId: original.id, turns: input.turns.map((p: any) => p.seq), update: null }] }))
    await c.refresh(); assert.equal(c.status().failed, 0)
    assert.deepEqual(f.service.store.contexts().find(t => t.id === original.id), updated)
  } finally { await f.close() }
})

test('budget-exhausted work continues promptly but a completed catalog returns to idle polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ batchBudget: 1 })
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(f.calls(), 1); assert.equal(c.status().pending, 1)
    t.mock.timers.tick(1000); await new Promise(setImmediate)
    assert.equal(f.calls(), 2, 'eligible backlog must not wait sixty seconds')
    assert.equal(c.status().pending, 0)
    const old = c.status().lastCompletedAt
    t.mock.timers.tick(58000); await new Promise(setImmediate)
    assert.equal(c.status().lastCompletedAt, old, 'idle catalogs must not spin')
  } finally { await f.close(); t.mock.timers.reset() }
})

test('catalog import does not repeatedly decode all topics or load unrelated message bodies', async () => {
  const f = fixture()
  for (let i = 0; i < 200; i++) f.service.createTopic('无关主题 ' + i)
  f.service.runtime.put('message', 'unrelated', { nativeHistory: true, hostThreadId: 'outside', text: 'keep this message' })
  const contexts = f.service.store.contexts.bind(f.service.store), all = f.service.runtime.all.bind(f.service.runtime)
  let fullTopics = 0, fullMessages = 0
  f.service.store.contexts = () => { fullTopics++; return contexts() }
  f.service.runtime.all = <T>(kind: string): T[] => { if (kind === 'message') fullMessages++; return all(kind) as T[] }
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(c.status().failed, 0)
    assert.ok(fullTopics <= 1, `decoded the whole topic table ${fullTopics} times`)
    assert.equal(fullMessages, 0)
    assert.equal(f.service.runtime.get<any>('message', 'unrelated').text, 'keep this message')
    assert.equal(contexts().filter(t => ['云南旅行','小说写作'].includes(t.title)).length, 2)
  } finally { await f.close() }
})

test('two chats classify concurrently, publish serially and never exceed two in flight', async () => {
  const f = fixture(), releases: (() => void)[] = [], original = f.model.classify
  f.chats.push({ ...f.chats[1], id: 'old-c', turns: [turn('third', '云南旅行行李')] })
  let active = 0, max = 0
  f.model.classify = async (...args) => {
    active++; max = Math.max(max, active)
    const result = await original(...args)
    if (releases.length < 2) await new Promise<void>(resolve => { releases.push(resolve); args[1].addEventListener('abort', () => resolve(), { once: true }) })
    active--; return result
  }
  try {
    const c = catalog(f.service); await c.consent(true); const work = c.refresh(); await new Promise(setImmediate)
    assert.equal(f.calls(), 2, 'both classifiers should start before either returns')
    releases[0](); await new Promise(setImmediate)
    assert.equal(f.service.listTopics().length, 2, 'finished first batch should already be usable')
    releases[1](); await work
    assert.equal(max, 2); assert.equal(c.status().indexed, 3); assert.equal(c.status().failed, 0)
    assert.equal(f.service.listTopics().length, 2, 'concurrent new-topic proposals must be reconciled')
  } finally { await f.close() }
})

test('pause aborts both concurrent classifiers and discards late results', async () => {
  const f = fixture(), signals: AbortSignal[] = [], original = f.model.classify
  f.model.classify = async (...args) => {
    const result = await original(...args); signals.push(args[1])
    await new Promise<void>(resolve => args[1].addEventListener('abort', () => resolve(), { once: true })); return result
  }
  try {
    const c = catalog(f.service); await c.consent(true); const work = c.refresh(); await new Promise(setImmediate)
    assert.equal(signals.length, 2); c.pause(); await work
    assert.ok(signals.every(s => s.aborted)); assert.equal(f.service.listTopics().length, 0)
    f.model.classify = original; c.resume(); await c.refresh()
    assert.equal(f.service.listTopics().length, 2)
  } finally { await f.close() }
})

test('semantic reconciliation can reuse differently named topics and preserves distinct trips', async () => {
  const f = fixture(), original = f.model.classify, settings = { model: 'gpt-6-luna', effort: 'medium', fast: false }
  const reconciliations: any[] = []
  f.model.classify = async (...args) => {
    const result: any = await original(...args)
    if (args[0].title === '继续旅行') result.topics[0].title = '云南酒店安排'
    return result
  }
  f.model.reconcile = async (input, _signal?: any, selection?: any) => {
    reconciliations.push({ input, selection })
    return { matches: input.proposals.map((p: any) => ({ proposal: p.proposal, contextId: input.contexts.find((c: any) => c.title === '云南旅行')!.id })) }
  }
  try {
    const c = catalog(f.service); await c.configureModel(settings); await c.consent(true); await c.refresh()
    assert.equal(reconciliations.length, 1); assert.deepEqual(reconciliations[0].selection, settings)
    assert.equal(c.status().batches, 3); assert.equal(f.service.listTopics().length, 2)
    assert.equal(f.service.readTopic(f.service.listTopics().find(t => t.title === '云南旅行')!.id).messages.length, 4)
  } finally { await f.close() }

  const distinct = fixture()
  distinct.chats[0].turns = [turn('year1', '2026年云南旅行')]; distinct.chats[1].turns = [turn('year2', '2027年云南旅行')]
  distinct.model.reconcile = async input => ({ matches: input.proposals.map((p: any) => ({ proposal: p.proposal, contextId: null })) })
  try {
    const c = catalog(distinct.service); await c.consent(true); await c.refresh()
    assert.equal(distinct.service.listTopics().length, 2, 'identical generated titles must not force independent trips together')
  } finally { await distinct.close() }
})

test('invalid reconciliation cannot create phantom topics and successful concurrent work survives retry', async () => {
  const f = fixture(), original = f.model.reconcile
  f.model.reconcile = async input => ({ matches: input.proposals.map((p: any) => ({ proposal: p.proposal, contextId: 'fabricated' })) })
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(c.status().failed, 1); assert.equal(f.service.search('酒店').length, 0)
    assert.equal(f.service.search('小说章节').length, 2)
    f.model.reconcile = original; await c.refresh()
    assert.equal(c.status().failed, 0); assert.equal(f.calls(), 3); assert.equal(f.service.listTopics().length, 2)
  } finally { await f.close() }
})

test('small budgets reserve reconciliation and never exceed the request limit', async () => {
  for (const budget of [1,2,3]) {
    const f = fixture({ batchBudget: budget }), original = f.model.reconcile
    let reconciles = 0
    f.model.reconcile = async input => { reconciles++; return original(input) }
    try {
      const c = catalog(f.service); await c.consent(true); await c.refresh()
      assert.ok(f.calls() + reconciles <= budget)
      assert.equal(c.status().batches, f.calls() + reconciles)
      if (budget === 3) assert.equal(reconciles, 1, 'budget should include concurrent proposal validation')
    } finally { await f.close() }
  }
})

test('projection recovery repairs an interrupted commit without reclassifying or rewriting older messages', async () => {
  const f = fixture(); f.chats.splice(1)
  const put = f.service.runtime.put.bind(f.service.runtime)
  let inject = true, writes = 0
  f.service.runtime.put = (kind, id, body) => {
    if (kind === 'message') { if (inject) { inject = false; throw Error('interrupted projection') }; writes++ }
    put(kind, id, body)
  }
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    assert.equal(c.status().failed, 1); assert.equal(f.calls(), 1)
    await c.refresh()
    assert.equal(c.status().failed, 0); assert.equal(f.calls(), 1); assert.equal(writes, 4)
    assert.equal(f.service.search('旅行路线').length, 2)
    writes = 0; f.chats[0].updatedAt++; f.chats[0].turns.push(turn('appended', '云南旅行行李'))
    await c.refresh()
    assert.equal(writes, 2, 'a new turn should not rewrite all old projected messages')
    assert.equal(f.service.search('旅行行李').length, 2)
  } finally { await f.close() }
})

test('deleting an existing topic during classification cannot resurrect it', async () => {
  const f = fixture(), original = f.model.classify
  let release!: () => void
  try {
    const c = catalog(f.service); await c.consent(true); await c.refresh()
    const topic = f.service.listTopics().find(t => t.title === '云南旅行')!
    f.chats[1].updatedAt++; f.chats[1].turns.push(turn('late', '云南旅行新的安排'))
    f.model.classify = async (...args) => {
      const result = await original(...args)
      await new Promise<void>(resolve => { release = resolve; args[1].addEventListener('abort', () => resolve(), { once: true }) })
      return result
    }
    const work = c.refresh(); await new Promise(setImmediate)
    f.service.deleteTopic(topic.id); release(); await work
    assert.ok(!f.service.store.lookupContext(topic.id)); assert.equal(f.service.listTopics().length, 1)
    assert.equal(f.service.search('新的安排').length, 0)
  } finally { await f.close() }
})
