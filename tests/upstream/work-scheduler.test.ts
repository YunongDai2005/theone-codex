import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkStore } from '../../src/work-store.ts'
import { WorkScheduler } from '../../src/work-scheduler.ts'
import type { WorkScope } from '../../src/work-scheduler.ts'
const input = { key: 'one', kind: 'research', resource: 'repo', payload: {} }

test('due tasks execute once, retain their result, and defer the next check', async () => {
  const store = new WorkStore(':memory:')
  let now = 100, calls = 0
  const scheduler = new WorkScheduler(store, async () => { calls++; return { result: 'observed', nextAt: 200 } }, () => now)
  try {
    const job = store.enqueue(input, now)
    await scheduler.tick()
    assert.equal(store.get(job.id)?.result, 'observed')
    await scheduler.tick()
    assert.equal(calls, 1)
    now = 200
    await scheduler.tick()
    assert.equal(calls, 2)
  } finally { await scheduler.stop(); store.close() }
})

test('cancelling active work aborts its source request and prevents late findings', async () => {
  const store = new WorkStore(':memory:')
  let signal: AbortSignal | undefined
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const scheduler = new WorkScheduler(store, async (_job, scope) => {
    signal = scope.signal; started.resolve(); await finish.promise
    return { result: 'late', notice: { fingerprint: 'late', text: 'late' } }
  })
  try {
    const job = store.enqueue(input)
    const running = scheduler.tick()
    // Do not hang indefinitely when a scheduler never dispatches.
    await Promise.race([started.promise, running])
    assert.ok(signal)
    scheduler.control(job.id, 'cancel')
    assert.equal(signal.aborted, true)
    finish.resolve(); await running
    assert.equal(store.get(job.id)?.state, 'cancelled')
    assert.equal(store.pendingNotices().length, 0)
  } finally { finish.resolve(); await scheduler.stop(); store.close() }
})

test('errors back off and stop after repeated failures without exposing raw errors', async () => {
  const store = new WorkStore(':memory:')
  let now = 100
  const scheduler = new WorkScheduler(store, async () => { throw new Error('secret credentials') }, () => now)
  try {
    const job = store.enqueue(input, now)
    await scheduler.tick()
    assert.equal(store.get(job.id)?.failures, 1)
    assert.equal(store.get(job.id)?.error, 'WORK_FAILED')
    for (let i = 0; i < 2; i++) { now = store.get(job.id)!.due; await scheduler.tick() }
    assert.equal(store.get(job.id)?.state, 'failed')
  } finally { await scheduler.stop(); store.close() }
})
test('shutdown releases a lease even when an adapter ignores cancellation, and fences its late checkpoint', async () => {
  const store = new WorkStore(':memory:')
  const done = Promise.withResolvers<{}>(), entered = Promise.withResolvers<void>()
  let scope!: WorkScope
  const scheduler = new WorkScheduler(store, async (_job, current) => { scope = current; entered.resolve(); return done.promise })
  const job = store.enqueue({ key: 'stuck', kind: 'memory', resource: 'topic', payload: {} })
  try {
    const tick = scheduler.tick()
    await entered.promise
    await Promise.race([scheduler.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown stuck')), 200))])
    assert.equal(store.get(job.id)?.state, 'queued')
    assert.equal(scope.checkpoint({ late: true }), false)
    done.resolve({}); await tick
  } finally { done.resolve({}); await scheduler.stop(); store.close() }
})
