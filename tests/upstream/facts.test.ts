import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextStore } from '../../src/store.ts'
import { accepts, factKey, rankCandidates, states, verify, type EvidenceEvent, type FactEvidence } from '../../src/facts.ts'

const topic = (id: string) => ({ id, title: id, summary: `${id} 摘要`, entities: [], keywords: [], lastState: '待续' })
const store = () => {
  const s = new ContextStore(':memory:')
  s.seed([topic('club'), topic('jobs'), topic('trip')])
  return s
}
const said = (sessionId: string, seq: number, quote: string, speaker: FactEvidence['speaker'] = 'user'): FactEvidence => ({ sessionId, seq, speaker, quote })
const set = (s: ContextStore, contextId: string, value: string, evidence: FactEvidence, extra: object = {}) =>
  s.recordFact(contextId, { label: '预算', kind: 'fact', value, status: 'confirmed', evidence, origin: 'worker', ...extra })

test('names fold case, width and spacing but keep C++, C# and .NET apart', () => {
  assert.equal(factKey('  Budget  Total '), 'budget total')
  assert.equal(factKey('「预算」'), '预算')
  assert.equal(factKey('ＢＵＤＧＥＴ'), 'budget')
  assert.deepEqual(new Set(['C++', 'C#', '.NET', 'C'].map(factKey)).size, 4)
  assert.equal(factKey('.NET'), '.net')
})

test('only the user’s own words, or an explicit acceptance of a proposal, confirm a value', () => {
  const events: EvidenceEvent[] = [
    { seq: 3, speaker: 'user', text: '我们办个读书会，大概三十人' },
    { seq: 4, speaker: 'assistant', text: '建议预算 800 元，茶点 260' },
    { seq: 5, speaker: 'user', text: '这个预算可以吗？' },
    { seq: 7, speaker: 'user', text: '好，就按你说的来' },
    { seq: 8, speaker: 'tool', text: 'created plan/budget.md', toolResult: true, isError: false },
  ]
  // The assistant's suggestion alone is a proposal.
  const proposal = verify({ sessionId: 's', events, kind: 'fact', value: '800', quote: '建议预算 800 元' })
  assert.equal(proposal.status, 'proposed')
  assert.equal(proposal.evidence.speaker, 'assistant')
  // A question is not an acceptance.
  assert.equal(verify({ sessionId: 's', events, kind: 'fact', value: '800', quote: '这个预算可以吗', acceptsQuote: '建议预算 800 元' }).status, 'proposed')
  // The user's acceptance of that proposal confirms it, and both quotes are kept.
  const accepted = verify({ sessionId: 's', events, kind: 'fact', value: '800', quote: '好，就按你说的来', acceptsQuote: '建议预算 800 元' })
  // Accepting needs a proposal that states the value, made before the acceptance.
  assert.equal(verify({ sessionId: 's', events, kind: 'fact', value: '900', quote: '好，就按你说的来', acceptsQuote: '建议预算 800 元' }).status, 'proposed')
  assert.equal(accepted.status, 'confirmed')
  assert.deepEqual([accepted.evidence.seq, accepted.evidence.accepts?.seq], [7, 4])
  // Words that are not in the session prove nothing.
  const invented = verify({ sessionId: 's', events, kind: 'fact', value: '900', quote: '预算 900 定了' })
  assert.deepEqual([invented.status, invented.evidence.speaker, invented.evidence.seq], ['proposed', 'unverified', null])
  // A user message that does not state the value does not confirm it.
  assert.equal(verify({ sessionId: 's', events, kind: 'fact', value: '1000', quote: '大概三十人' }).reason, 'value-not-in-quote')
  // An artifact a tool produced is confirmed by the tool event.
  assert.equal(verify({ sessionId: 's', events, kind: 'artifact', value: 'plan/budget.md', quote: 'plan/budget.md' }).status, 'confirmed')
  assert.ok(states('总预算 3,000 元', '3000') && states('Budget is $1,200 now', '1200') && !states('预算 800', '700'))
  assert.ok(accepts('ok, go with that') && accepts('行') && !accepts('不行') && !accepts('ok?'))
})

test('a newer value supersedes the old one; one current version per fact; proposals never replace confirmed values', () => {
  const s = store()
  const first = set(s, 'club', '800', said('w1', 10, '预算 800'))
  assert.equal(first.outcome, 'created')
  const second = set(s, 'club', '700', said('w1', 20, '预算改成 700'), { expectedVersion: 1 })
  assert.deepEqual([second.outcome, second.fact?.version, second.fact?.value, second.previous?.value], ['updated', 2, '700', '800'])
  // Replaying the same evidence is idempotent; a later reaffirmation advances the version.
  assert.equal(set(s, 'club', '700', said('w1', 20, '预算改成 700')).outcome, 'unchanged')
  const proposal = s.recordFact('club', { label: '预算', kind: 'fact', value: '900', status: 'proposed', evidence: said('w1', 30, '建议 900', 'assistant'), origin: 'worker' })
  assert.deepEqual([proposal.outcome, proposal.reason], ['rejected', 'keeps-confirmed'])
  assert.equal(s.facts('club').length, 1)
  assert.equal(s.fact(first.fact!.id)?.value, '700')
  assert.equal(s.factVersion(first.fact!.id, 1)?.value, '800')
  // The same name in another topic is another fact.
  assert.equal(set(s, 'jobs', '5000', said('w2', 3, '预算 5000')).outcome, 'created')
  assert.equal(s.sharedFacts('club').length, 1)
})

test('a slow write from an earlier turn cannot overwrite a newer value', () => {
  const s = store()
  const v1 = set(s, 'club', '800', said('w1', 10, '预算 800')).fact!
  // Turn 2 records 700 while turn 1's extraction (based on version 1, evidence at seq 10) is still running.
  set(s, 'club', '700', said('w1', 20, '改成 700'), { expectedVersion: 1 })
  const late = set(s, 'club', '800', said('w1', 10, '预算 800'), { expectedVersion: 1, origin: 'extractor' })
  assert.deepEqual([late.outcome, late.reason, late.fact?.value], ['rejected', 'stale', '700'])
  // Without an expected version, evidence still has to move forward within the session.
  const older = set(s, 'club', '800', said('w1', 12, '预算 800'))
  assert.deepEqual([older.outcome, older.reason], ['rejected', 'older-evidence'])
  assert.equal(s.fact(v1.id)?.value, '700')
})

test('retracting leaves no value; the fact is out of the shared pool and can be set again later', () => {
  const s = store()
  const fact = set(s, 'club', '800', said('w1', 10, '预算 800')).fact!
  const gone = s.retractFact('club', fact.id, said('w1', 15, '预算还没定'), 'worker', 1)
  assert.deepEqual([gone.outcome, gone.fact?.status, gone.fact?.value], ['retracted', 'retracted', null])
  assert.equal(s.sharedFacts().length, 0)
  assert.equal(s.facts('club').length, 0)
  assert.equal(s.retractFact('club', fact.id, said('w1', 15, '预算还没定'), 'worker').outcome, 'unchanged')
  assert.equal(s.retractFact('jobs', fact.id, said('w1', 16, '没定'), 'worker').reason, 'unknown-fact')
  const again = set(s, 'club', '650', said('w1', 30, '预算定 650'))
  assert.deepEqual([again.outcome, again.fact?.id, again.fact?.version], ['updated', fact.id, 3])
})

test('deliveries are logged every time; the dependency keeps the latest version seen', () => {
  const s = store()
  const fact = set(s, 'club', '800', said('w1', 10, '预算 800')).fact!
  s.recordDelivery('jobs', fact, 'route', 'in-1')
  s.recordDelivery('jobs', fact, 'route', 'in-2')
  s.recordDelivery('jobs', fact, 'lookup')
  assert.equal(s.deliveries('jobs').length, 3)
  assert.deepEqual(s.dependencies('jobs'), [{ factId: fact.id, versionSeen: 1 }])
  const newer = set(s, 'club', '700', said('w1', 20, '改成 700')).fact!
  s.recordDelivery('jobs', newer, 'notice')
  assert.deepEqual(s.dependencies('jobs'), [{ factId: fact.id, versionSeen: 2 }])
})

test('merging keeps same-named facts apart and dependencies intact; deleting leaves a tombstone', () => {
  const s = store()
  const clubBudget = set(s, 'club', '800', said('w1', 10, '预算 800')).fact!
  const tripBudget = set(s, 'trip', '3000', said('w3', 5, '预算 3000')).fact!
  s.recordDelivery('jobs', tripBudget, 'route', 'in-1')
  s.recordDelivery('trip', clubBudget, 'route', 'in-2')
  s.mergeTopics('trip', 'club')
  const merged = s.facts('club')
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map(fact => fact.value).sort(), ['3000', '800'])
  assert.match(s.fact(tripBudget.id)!.label, /预算（来自 trip）/)
  assert.equal(s.fact(tripBudget.id)!.mergedFrom, 'trip')
  // jobs still depends on the moved fact; club no longer "depends" on its own fact.
  assert.deepEqual(s.dependencies('jobs'), [{ factId: tripBudget.id, versionSeen: 1 }])
  assert.deepEqual(s.dependencies('club'), [])
  s.deleteTopic('club')
  const tomb = s.fact(clubBudget.id)!
  assert.ok(tomb.deletedAt !== undefined)
  assert.equal(tomb.value, null)
  assert.equal(tomb.label, '预算')
  assert.equal(s.sharedFacts().length, 0)
  assert.deepEqual(s.dependencies('jobs'), [{ factId: tripBudget.id, versionSeen: 1 }])
})

test('the schema itself refuses a second identity per name and a duplicate version', () => {
  const s = store()
  set(s, 'club', '800', said('w1', 10, '预算 800'))
  // Reach the raw database the way a buggy future code path would.
  const db = (s as unknown as { db: import('node:sqlite').DatabaseSync }).db
  assert.throws(() => db.prepare("INSERT INTO facts (id, context_id, key, label, kind, current_version) VALUES ('x', 'club', '预算', '预算', 'fact', 1)").run(), /UNIQUE/)
  const id = s.facts('club')[0].id
  assert.throws(() => db.prepare("INSERT INTO fact_versions VALUES (?, 1, 'confirmed', '1', '{}', 'worker', 0)").run(id), /UNIQUE/)
})

test('candidates rank by wording and named topic, and stop at the size budget', () => {
  const now = Date.now()
  const fact = (id: string, label: string, value: string, topicTitle: string) => ({ id, contextId: topicTitle, key: label, label, aliases: [], kind: 'fact' as const,
    version: 1, status: 'confirmed' as const, value, evidence: said('w', 1, value), origin: 'worker' as const, createdAt: now, topicTitle, related: 0 })
  const ranked = rankCandidates([fact('a', '车预算', '16500', '买车'), fact('b', '读书会预算', '800', '读书会'), fact('c', '截止日期', '3 月 20 日', '找工作')], '读书会的预算还剩多少')
  assert.equal(ranked[0].id, 'b')
  assert.ok(!ranked.some(item => item.id === 'c'))
  const many = Array.from({ length: 40 }, (_, n) => fact(`f${n}`, `预算项目${n}`, 'x'.repeat(200), '读书会'))
  const capped = rankCandidates(many, '读书会预算')
  assert.ok(capped.length <= 12)
  assert.ok(JSON.stringify(capped).length <= 1200 + 2 * capped.length)
})

test('an extraction request carries the proposal being accepted and stays within budget', async () => {
  const { extractionPayload } = await import('../../src/fact-flow.ts')
  const events: EvidenceEvent[] = [
    { seq: 1, speaker: 'user', text: '预算怎么定' },
    { seq: 2, speaker: 'assistant', text: '建议预算 800 元' },
    { seq: 3, speaker: 'user', text: '好，就按你说的来' },
    { seq: 4, speaker: 'assistant', text: '好的，已按 800 安排' },
  ]
  const payload = extractionPayload(events, [])!
  assert.equal(payload.user, '好，就按你说的来')
  assert.match(payload.assistant, /建议预算 800 元/)
  const long = extractionPayload([{ seq: 1, speaker: 'user', text: 'x'.repeat(20000) }, { seq: 2, speaker: 'assistant', text: 'y'.repeat(20000) }], [])!
  assert.ok(JSON.stringify(long).length <= 6000 + 100)
  assert.equal(extractionPayload([{ seq: 1, speaker: 'assistant', text: 'hi' }], []), undefined)
})
