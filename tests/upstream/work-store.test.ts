import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkStore } from '../../src/work-store.ts'

test('queued work survives reopening and a duplicate request creates no second task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'theone-work-'))
  let store = new WorkStore(join(root, 'work.db'))
  try {
    const input = { key: 'message-1', kind: 'research', resource: 'repo:owner/project', payload: { objective: 'Watch CI' } }
    const first = store.enqueue(input, 100)
    assert.ok(first, 'enqueue must persist a task')
    store.close()
    store = new WorkStore(join(root, 'work.db'))
    assert.deepEqual(store.enqueue(input, 200), first)
    assert.equal(store.list().length, 1)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('claims exclude a concurrent owner and expired leases fence off stale results', () => {
  const store = new WorkStore(':memory:')
  try {
    const input = { key: 'one', kind: 'research', resource: 'project', payload: {} }
    store.enqueue(input, 100)
    store.enqueue({ ...input, key: 'two' }, 100)
    const first = store.claim(100, 1000)
    assert.ok(first)
    assert.equal(store.claim(101, 1000), undefined, 'the same resource must not run twice')
    const recovered = store.claim(1101, 1000)
    assert.ok(recovered)
    assert.notEqual(first.token, recovered.token)
    assert.equal(store.finish(first, { stale: true }, undefined, undefined, 1102), false)
    assert.equal(store.finish(recovered, { ok: true }, undefined, undefined, 1102), true)
    assert.ok(store.claim(1103, 1000))
  } finally { store.close() }
})

test('pause and cancel reject late results and event delivery never resurrects a stopped task', () => {
  const store = new WorkStore(':memory:')
  try {
    const job = store.enqueue({ key: 'one', kind: 'research', resource: 'project', payload: {} }, 100)
    const running = store.claim(100)!
    assert.equal(store.control(job.id, 'pause', 101), true)
    assert.equal(store.finish(running, {}, undefined, { fingerprint: 'late', text: 'wrong' }, 102), false)
    assert.equal(store.wake(job.id, 'event-1', 103), false)
    assert.equal(store.claim(104), undefined)
    assert.equal(store.pendingNotices().length, 0)
    store.control(job.id, 'resume', 105)
    assert.ok(store.claim(105))
    store.control(job.id, 'cancel', 106)
    assert.equal(store.control(job.id, 'resume', 107), false)
    assert.equal(store.claim(108), undefined)
  } finally { store.close() }
})

test('a saved extraction survives retry and unchanged findings produce only one notice', () => {
  const store = new WorkStore(':memory:')
  try {
    const task = store.enqueue({ key: 'one', kind: 'research', resource: 'project', payload: {} }, 100)
    const first = store.claim(100, 1000)!
    assert.equal(store.checkpoint(first, { evidence: 'original' }, 101), true)
    const retry = store.claim(1101, 1000)!
    assert.deepEqual(retry.candidate, { evidence: 'original' })
    assert.equal(store.finish(retry, { finding: 'failed' }, 2000, { fingerprint: 'sha:failed', text: 'CI failed' }, 1102), true)
    assert.equal(store.wake(task.id, 'event-1', 1103), true)
    const next = store.claim(1103)!
    assert.equal(next.candidate, undefined)
    assert.equal(store.wake(task.id, 'event-1', 1104), false)
    store.finish(next, { finding: 'failed' }, 3000, { fingerprint: 'sha:failed', text: 'duplicate' }, 1105)
    assert.equal(store.pendingNotices().length, 1)
    assert.equal(store.get(task.id)?.state, 'queued')
    assert.equal(store.claim(1106), undefined)
  } finally { store.close() }
})
