// Bounded, real Luna comparison using synthetic chats and isolated databases only.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const mode = process.argv[2]
if (!['before','after','cold'].includes(mode)) throw Error('Expected before, after or cold')
const root = resolve('.theone'), dir = await mkdtemp(join(root, 'pipeline-profile-'))
const sourceRoot = resolve(mode === 'before' ? '.theone/history-alpha8-baseline/src' : 'src')
const load = name => import(pathToFileURL(join(sourceRoot, name + '.ts')).href)
const [{ ContextStore }, { RuntimeStore }, { HistoryCatalog }, { CodexCatalogModel }] = await Promise.all([
  load('store'), load('runtime-store'), load('history-catalog'), load('codex-history'),
])
const store = new ContextStore(join(dir, 'topics.db')), runtime = new RuntimeStore(join(dir, 'runtime.db'))
const model = new CodexCatalogModel(), calls = [], selection = { model: 'gpt-6-luna', effort: 'medium', fast: false }
let active = 0, maxInFlight = 0
for (const method of ['classify','reconcile']) if (model[method]) {
  const original = model[method].bind(model)
  model[method] = async (...args) => {
    const started = performance.now(); active++; maxInFlight = Math.max(maxInFlight, active)
    try {
      const result = await original(...args)
      calls.push({ method, ms: Math.round(performance.now() - started), outputBytes: Buffer.byteLength(JSON.stringify(result)),
        compactReplies: result.topics?.filter(t => 'update' in t).length ?? 0 })
      return result
    } finally { active-- }
  }
}
const topicSeeds = [
  { id: '00000000-0000-4000-8000-000000000001', title: '2027年云南旅行', summary: '为2027年云南旅行规划路线、酒店和交通，目前仍在规划阶段。', lastState: '规划中', entities: ['云南','2027年'], keywords: ['旅行','路线','酒店'] },
  { id: '00000000-0000-4000-8000-000000000002', title: '小说星港', summary: '创作小说星港，正在规划章节大纲和人物关系。', lastState: '规划中', entities: ['星港'], keywords: ['小说','章节','人物'] },
]
const turn = (id, text) => ({ id, status: 'completed', items: [{ id: 'u-' + id, type: 'userMessage', content: [{ type: 'text', text }] },
  { id: 'a-' + id, type: 'agentMessage', text: '仍在规划，尚无新的决定或完成项。' }] })
const chats = mode === 'cold' ? [
  { id: 'cold-a', title: '2027年云南旅行和星港小说', updatedAt: 1, cwd: dir, turns: [turn('a1','规划2027年云南旅行路线'),turn('a2','规划小说星港的章节大纲')] },
  { id: 'cold-b', title: '继续2027年云南旅行', updatedAt: 2, cwd: dir, turns: [turn('b1','继续同一次2027年云南旅行的酒店预算')] },
] : Array.from({ length: 4 }, (_, n) => ({ id: 'known-' + n, title: n % 2 ? '小说星港后续' : '2027年云南旅行后续', cwd: dir, updatedAt: n + 1,
  turns: Array.from({ length: 4 }, (_, i) => turn(n + '-' + i, n % 2 ? '继续小说星港的章节和人物规划，暂无新进展。' : '继续同一次2027年云南旅行的路线和酒店规划，暂无新进展。')) }))
if (mode !== 'cold') store.seed(topicSeeds)
const source = { list: async () => chats.map(({ turns, ...s }) => s), read: async id => chats.find(c => c.id === id), close: async () => {} }
const catalog = new HistoryCatalog(store, runtime, { source, model })
try {
  // Avoid scanning user history: source above contains only this fixed synthetic fixture.
  runtime.put('catalog-model-settings', 'main', selection)
  await catalog.consent(true)
  const start = performance.now(); await catalog.refresh(); const totalMs = Math.round(performance.now() - start)
  const state = catalog.status(), topics = store.contexts(), messages = runtime.all('message')
  assert.equal(state.failed, 0, state.error); assert.equal(state.pending, 0)
  assert.equal(topics.length, 2, 'same project should reuse one topic across chats')
  assert.equal(messages.length, chats.reduce((n, c) => n + c.turns.length * 2, 0))
  const report = { at: new Date().toISOString(), mode, syntheticInput: true, selection, chats: chats.length,
    turns: chats.reduce((n,c) => n + c.turns.length, 0), totalMs, maxInFlight, calls, topics: topics.length,
    messages: messages.length, outputBytes: calls.reduce((n,c) => n + c.outputBytes, 0), status: state }
  await writeFile('evidence/history-pipeline-' + mode + '.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  await catalog.close(); store.close(); runtime.close()
  if (!resolve(dir).startsWith(root + sep)) throw Error('Profile cleanup escaped its workspace')
  await rm(dir, { recursive: true, force: true })
}
