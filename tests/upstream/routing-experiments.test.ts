import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routingPayload, routingPrompt, validateRoutingDecision } from '../../src/llm-router.ts'
import * as exp from '../../src/routing-experiments.ts'
const topic = (id: string, summary = 'original') => ({ id, title: id, summary, entities: [], keywords: [], lastState: '' })
const a = 'long-topic-identifier-alpha', b = 'long-topic-identifier-bravo'
const input = { text: '继续上次那个计划', contexts: [topic(a), topic(b)], currentId: a,
  facts: [{ id: 'fact1', topic: 'Alpha', label: 'Budget', kind: 'fact' as const, value: '100' }], projects: [{ id: 'project1', name: 'Project' }] }

test('snapshot restores exact effective state after add, update, delete, merge, correction and recent sliding', () => {
  assert.equal(typeof exp.SnapshotCache, 'function')
  const cache = new exp.SnapshotCache({ minOverlayTokens: 100000, maxChars: 100000 })
  const base = routingPayload({ ...input, recent: [{ role: 'user', text: 'first' }] })
  const first = cache.prepare(base, 'session')
  const states = [
    { ...base, contexts: [...base.contexts, topic('new')] },
    { ...base, contexts: [topic(a, 'rewritten card'), topic(b)] },
    { ...base, contexts: [topic(a)] },
    { ...base, contexts: [topic(b, 'merged alpha and bravo')], currentId: b },
    { ...base, corrections: [{ text: 'move this', wrongId: a, rightId: b }], attention: { background: [{ topicId: b, messageId: 'reply' }] },
      recent: [{ role: 'assistant' as const, text: 'second' }] },
    base,
  ]
  let previous = first
  for (const state of states) {
    const wire = cache.prepare(state, 'session')
    assert.deepEqual(exp.materializeSnapshot(wire), state)
    assert.deepEqual(wire.snapshot, first.snapshot)
    assert.deepEqual(wire.overlay.slice(0, previous.overlay.length), previous.overlay)
    assert.ok(JSON.stringify(wire).startsWith(JSON.stringify(previous).slice(0, -2)))
    previous = wire
  }
  assert.deepEqual(exp.materializeSnapshot(first), base, 'in-flight requests remain immutable')
})

test('snapshot rebuilds on its overlay budget and isolates sessions and anonymous requests', () => {
  assert.equal(typeof exp.SnapshotCache, 'function')
  const cache = new exp.SnapshotCache({ minOverlayTokens: 0, overlayRatio: 0.1 })
  const base = routingPayload(input), first = cache.prepare(base, 'one')
  const updated = { ...base, text: 'changed '.repeat(250) }, next = cache.prepare(updated, 'one')
  assert.ok(next.epoch > first.epoch)
  assert.equal(next.overlay.length, 0)
  assert.deepEqual(exp.materializeSnapshot(next), updated)
  assert.deepEqual(cache.prepare(base, 'two').snapshot, base)
  assert.deepEqual(cache.prepare(base).snapshot, base)
  assert.deepEqual(cache.prepare(updated).snapshot, updated)
})

test('quick, recheck and changed review candidates share a trunk without leaking candidates', () => {
  assert.equal(typeof exp.SnapshotCache, 'function')
  const cache = new exp.SnapshotCache({ minOverlayTokens: 100000 })
  const first = cache.prepare(routingPayload(input), 'one')
  for (const next of [routingPayload({ ...input, recheck: { previous: 'CREATE', contextId: b, terms: ['plan'] } }),
    routingPayload({ ...input, contexts: [topic(b)] })]) {
    const wire = cache.prepare(next, 'one')
    assert.equal(wire.epoch, first.epoch)
    assert.deepEqual(exp.materializeSnapshot(wire), next)
  }
})

test('compact round trips every action and optional field through the existing semantic validator', () => {
  assert.equal(typeof exp.compactPayload, 'function')
  const { aliases } = exp.compactPayload(routingPayload(input))
  const decisions = [
    { action: 'EXISTING', contextId: a, reason: 'match' },
    { action: 'EXISTING', contextId: b, reason: '关联', relatedIds: [a], imports: ['fact1'] },
    ...[true, false, undefined].map(historyIndependent => ({ action: 'CREATE', title: 'New work', reason: 'new',
      ...(historyIndependent === undefined ? {} : { historyIndependent }), relatedIds: [b], imports: ['fact1'], projectId: 'project1' })),
    ...[true, false].map(aside => ({ action: 'CREATE', title: 'Conversion', reason: 'one off', aside })),
    { action: 'CLARIFY', question: 'Which plan?', reason: 'ambiguous', candidateIds: [a, b] },
  ]
  for (const row of decisions) {
    const compact = exp.compressDecision(row, aliases), expanded = exp.expandDecision(compact, aliases)
    assert.deepEqual(validateRoutingDecision(expanded, input), validateRoutingDecision(row, input))
    assert.deepEqual(exp.compressDecision(expanded, aliases), compact)
  }
  assert.deepEqual(Object.keys(exp.compressDecision(decisions[0], aliases)), ['action', 'contextId'])
  for (const currentId of [undefined, a, b]) {
    assert.deepEqual(validateRoutingDecision(exp.expandDecision(exp.compressDecision(decisions[0], aliases), aliases), { ...input, currentId }),
      validateRoutingDecision(decisions[0], { ...input, currentId }))
  }
})

test('compact ids stay stable across order/epochs and stale or unoffered ids fail closed', () => {
  assert.equal(typeof exp.compactPayload, 'function')
  const first = exp.compactPayload(routingPayload(input))
  const next = exp.compactPayload(routingPayload({ ...input, contexts: [topic(b)] }))
  const code = exp.compressDecision({ action: 'EXISTING', contextId: a, reason: 'match' }, first.aliases)
  assert.ok(typeof code.contextId === 'string')
  assert.ok(code.contextId.length < a.length)
  assert.throws(() => exp.expandDecision(code, next.aliases), /ROUTER_COMPACT_ID_INVALID/)
  assert.throws(() => exp.expandDecision({ action: 'CLARIFY', candidateIds: ['stale'] }, next.aliases), /ROUTER_COMPACT_ID_INVALID/)
  assert.throws(() => exp.expandDecision({ action: 'EXISTING', contextId: next.payload.contexts[0].routeId, relatedIds: ['stale'] }, next.aliases), /ROUTER_COMPACT_ID_INVALID/)
  assert.equal(first.payload.contexts[1].routeId, next.payload.contexts[0].routeId)
  assert.deepEqual(exp.expandDecision({ action: 'EXISTING', contextId: first.payload.contexts[0].routeId }, first.aliases),
    { action: 'EXISTING', contextId: a, reason: 'match' })
  assert.deepEqual(exp.expandDecision({ action: 'KEEP', contextId: a }, first.aliases), { action: 'KEEP', contextId: a, reason: 'match' },
    'an offered full id, as given in currentId, is accepted')
  assert.throws(() => exp.expandDecision({ action: 'KEEP', contextId: a }, next.aliases), /ROUTER_COMPACT_ID_INVALID/)
})

test('disabled experiments preserve request bytes and snapshot fixes optional attention template churn', () => {
  assert.equal(typeof exp.RoutingExperiments, 'function')
  const builder = new exp.RoutingExperiments(), payload = routingPayload(input)
  for (const variant of [undefined, 'none'] as const) {
    const request = builder.prepare(payload, variant, 'one')
    assert.equal(request.system, routingPrompt(payload))
    assert.equal(request.user, JSON.stringify(payload))
  }
  const first = builder.prepare(payload, 'snapshot', 'one')
  const next = builder.prepare({ ...payload, attention: { background: [] } }, 'snapshot', 'one')
  assert.equal(first.system, next.system)
  assert.deepEqual(exp.materializeSnapshot(JSON.parse(next.user)), { ...payload, attention: { background: [] } })
  assert.throws(() => builder.prepare(payload, 'typo' as never, 'one'), /routing variant/)
})
