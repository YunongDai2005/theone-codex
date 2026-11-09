import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../src/runtime-store.ts'
import { MergeVetter, parseMergeVerdicts } from '../src/merge-vetting.ts'
import { TheOneService } from '../src/service.ts'
import { HttpRouter } from '../src/http-router.ts'

test('idle merge vetting persists decisions, deduplicates, and only suggests high-confidence same matters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-vet-')), db = new RuntimeStore(join(dir, 'runtime.db'))
  let idle = false, calls = 0
  const suggestions: any[] = []
  const vet = new MergeVetter(db, { idle: () => idle, fingerprint: () => 'v1',
    topics: pair => pair.map(id => ({ id, title: id, summary: 'sk-abcdefghijklmnopqrst hidden', entities: [] })),
    infer: async pairs => { calls++; assert.ok(!JSON.stringify(pairs).includes('sk-abcdefghijklmnopqrst')); return { decisions: pairs.map((p, i) => ({ pairId: p.pairId, sameMatter: i === 0, confidence: .95, keepId: p.topics[0].id, reason: 'same matter' })) } },
    suggest: (row, verdict) => { suggestions.push({ row, verdict }) } })
  try {
    vet.enqueue('main', ['a','b'], { sharedNames: 1, titleSimilarity: .4 }); vet.enqueue('main', ['a','b'], { sharedNames: 1, titleSimilarity: .4 })
    vet.enqueue('main', ['c','d'], { sharedNames: 1, titleSimilarity: .4 })
    await vet.tick(); assert.equal(calls, 0)
    idle = true; await vet.tick(); assert.equal(calls, 1); assert.equal(suggestions.length, 1)
    vet.enqueue('main', ['a','b'], { sharedNames: 1, titleSimilarity: .4 }); await vet.tick(); assert.equal(calls, 1)
    assert.equal(db.all<any>('merge-vet').every(r => r.state === 'decided'), true)
    assert.equal(parseMergeVerdicts({ decisions: [{ pairId: 'x', sameMatter: true, confidence: .8, keepId: 'a', reason: 'maybe' }] }, [{ pairId: 'x', topics: [{ id: 'a' }, { id: 'b' }] }] as any)[0].confidence, .8)
    assert.throws(() => parseMergeVerdicts({ decisions: [{ pairId: 'x', sameMatter: true, confidence: 1, keepId: 'invented', reason: 'bad' }] }, [{ pairId: 'x', topics: [{ id: 'a' }, { id: 'b' }] }] as any), /MERGE_VET_INVALID_OUTPUT/)
  } finally { await vet.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('service candidates wait for semantic vetting, preserve keep direction, and never auto-merge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-vet-integration-'))
  let calls = 0
  const service = new TheOneService({ dataDir: dir, router: {
    decide: async () => { throw Error('routing not expected') },
    vetMerges: async pairs => { calls++; return { decisions: pairs.map(p => ({ pairId: p.pairId, sameMatter: true, confidence: .95, keepId: p.topics[1].id, reason: 'same trip' })) } },
  } })
  try {
    service.desktopBind('p', 'main', dir)
    service.createTopic('日本旅行计划'); service.createTopic('日本旅行行程')
    service.detectSuggestions('main'); assert.equal(service.desktopSnapshot('p').suggestions.length, 0); assert.equal(calls, 0)
    await service.vetSuggestions()
    const row = service.desktopSnapshot('p').suggestions[0]
    assert.ok(row); assert.equal(row.directions[0].targetId, row.pair[1]); assert.equal(service.store.merges().length, 0)
    service.detectSuggestions('main'); await service.vetSuggestions(); assert.equal(calls, 1)
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('HTTP merge vetting uses the configured provider with bounded JSON and no tool requests', async () => {
  const requests: any[] = [], router = new HttpRouter({ endpoint: 'https://example.com/chat', model: 'test' }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"decisions":[]}' } }] }))
  })
  assert.deepEqual(await router.vetMerges([], new AbortController().signal), { decisions: [] })
  assert.equal(requests[0].tools, undefined); assert.equal(requests[0].model, 'test')
  assert.match(requests[0].messages[0].content, /合并把关器/)
})

test('an edit or input interruption fences late vetting, and failures back off without surfacing suggestions', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-vet-fence-')), db = new RuntimeStore(join(dir, 'runtime.db'))
  let version = 'one', release!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve }), shown: any[] = []
  const vet = new MergeVetter(db, { idle: () => true, fingerprint: () => version,
    topics: pair => pair.map(id => ({ id, title: id, summary: '', entities: [] })),
    infer: async pairs => { calls++; if (calls > 1) throw Error('offline'); await gate; return { decisions: pairs.map(p => ({ pairId: p.pairId, sameMatter: true, confidence: 1, keepId: 'a', reason: 'yes' })) } },
    suggest: row => { shown.push(row) } })
  try {
    vet.enqueue('main', ['a','b'], { sharedNames: 1, titleSimilarity: .4 }); const pending = vet.tick()
    version = 'two'; vet.interrupt(); release(); await pending; assert.equal(shown.length, 0)
    vet.enqueue('main', ['a','b'], { sharedNames: 1, titleSimilarity: .4 }); await vet.tick(); await vet.tick()
    assert.equal(calls, 2); assert.equal(db.all<any>('merge-vet')[0].failures, 1)
    const now = Date.now(), clock = t.mock.method(Date, 'now', () => now + 100000)
    try { await vet.tick(); assert.equal(calls, 3) } finally { clock.mock.restore() }
  } finally { release(); await vet.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
