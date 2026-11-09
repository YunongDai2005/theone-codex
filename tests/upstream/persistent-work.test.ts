import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PersistentWork, type WorkHost } from '../../src/persistent-work.ts'
const origin = { key: 'request-1', gatewayId: 'main', sessionId: 'topic', contextId: 'one' }
const input = { objective: 'Watch this PR; investigate failures before changing anything', url: 'https://github.com/example/project/pull/1', intervalMinutes: 5, maxChecks: 3 }
const sha = 'a'.repeat(40)

test('PR monitoring survives unchanged checks without repeated analysis or notifications, and ends on closure', async () => {
  let now = 1000, closed = false, analysis = 0
  const notices: string[] = []
  const host: WorkHost = { async analyze() { analysis++; return { summary: 'Tests failed', nextStep: 'Inspect assertion output' } },
    async memory() { return {} }, async notify(notice) { notices.push(notice.id); return true } }
  const work = new PersistentWork(':memory:', host, async url => {
    if (String(url).endsWith('/pulls/1')) return Response.json({ title: 'PR', state: closed ? 'closed' : 'open', merged: closed, head: { sha } })
    if (String(url).includes('check-runs')) return Response.json({ total_count: 1, check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure' }] })
    return Response.json({ total_count: 0, statuses: [] })
  }, () => now)
  try {
    const job = work.create(input, origin)
    assert.ok(job)
    await work.tick()
    assert.equal(analysis, 1)
    assert.equal(notices.length, 1)
    now += 300000; await work.tick()
    assert.equal(analysis, 1)
    assert.equal(notices.length, 1)
    closed = true; now += 300000; await work.tick()
    assert.equal(work.store.get(job.id)?.state, 'completed')
    assert.equal(notices.length, 2)
  } finally { await work.close() }
})

test('limits stop future polling and malformed or unbounded schedules are refused', async () => {
  let now = 1000, requests = 0
  const work = new PersistentWork(':memory:', { async analyze() { return {} }, async memory() { return {} }, async notify() { return true } }, async () => { requests++; throw new Error('offline') }, () => now)
  try {
    for (const override of [{ intervalMinutes: 0 }, { maxChecks: 0 }, { maxChecks: 1e20 }, { deadline: 999 }, { url: 'https://localhost/private' }])
      assert.throws(() => work.create({ ...input, ...override }, origin))
    const job = work.create({ ...input, maxChecks: 1 }, origin)
    assert.ok(job)
    await work.tick(); now += 600000; await work.tick()
    assert.equal(work.store.get(job.id)?.state, 'waiting')
    assert.equal(requests, 1)
  } finally { await work.close() }
})
