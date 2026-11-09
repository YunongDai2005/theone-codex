import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWithReview } from '../src/routing-flow.ts'
import { RouterFailure, type RoutingRouter } from '../src/llm-router.ts'

const contexts = [{ id: 'a', title: '书稿', summary: '', entities: [], keywords: [], lastState: '' }]
test('CREATE is rechecked and transient failures retry within a finite budget', async () => {
  let calls = 0
  const router: RoutingRouter = { source: 'codex', decide: async (input) => {
    calls++
    if (calls === 1) throw new RouterFailure('ROUTER_INVALID_JSON')
    return { decision: input.recheck ? { action: 'MOUNT', contextId: 'a', reason: 'rechecked' } : { action: 'CREATE', title: '新的', reason: 'quick' }, model: 'fixture', elapsedMs: 1 }
  } }
  const result = await decideWithReview(router, { text: '继续那个', contexts }, new AbortController().signal)
  assert.equal(result.decision.contextId, 'a'); assert.equal(calls, 3)
  assert.equal(result.receipt.calls, 3); assert.equal(result.receipt.trace?.recheck.accepted, true)
  assert.equal(result.receipt.callDetails?.[0].errorCode, 'ROUTER_INVALID_JSON')
})
test('review offers omitted candidates before settling on a new topic', async () => {
  const topics = Array.from({ length: 80 }, (_, i) => ({ ...contexts[0], id: 't' + i, summary: 's'.repeat(600), lastState: 't'.repeat(400) }))
  const router: RoutingRouter = { source: 'http', decide: async input => ({ decision: input.contexts.some(c => c.id === 't79')
    ? { action: 'MOUNT', contextId: 't79', reason: 'found' } : { action: 'CREATE', title: '新事项', reason: 'miss' }, model: 'fixture', elapsedMs: 0 }) }
  const result = await decideWithReview(router, { text: '一个任务', contexts: topics }, new AbortController().signal)
  assert.equal(result.decision.contextId, 't79'); assert.equal(result.receipt.trace?.review.attempted, true)
  assert.equal(result.receipt.source, 'http')
})
test('permanent selection failures are not retried', async () => {
  let calls = 0
  const router: RoutingRouter = { decide: async () => { calls++; throw new RouterFailure('ROUTER_MODEL_UNAVAILABLE') } }
  await assert.rejects(decideWithReview(router, { text: '任务', contexts }, new AbortController().signal), /ROUTER_MODEL_UNAVAILABLE/)
  assert.equal(calls, 1)
})
