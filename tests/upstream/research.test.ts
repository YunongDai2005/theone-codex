import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pullSource, readPullRequest } from '../../src/research.ts'
const url = 'https://github.com/example/project/pull/12'
const sha = 'a'.repeat(40)

test('PR research reads only fixed GitHub API paths and reports evidence of failed CI', async () => {
  const seen: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input); seen.push(path)
    assert.equal(init?.method, 'GET')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.body, undefined)
    if (path.endsWith('/pulls/12')) return Response.json({ title: 'Change', state: 'open', merged: false, head: { sha } })
    if (path.includes('check-runs')) return Response.json({ total_count: 1, check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', output: { summary: 'Assertion failed' } }] })
    if (path.endsWith('/status')) return Response.json({ total_count: 0, statuses: [] })
    throw new Error('unexpected source')
  }
  const snapshot = await readPullRequest(url, new AbortController().signal, fetcher)
  assert.ok(snapshot)
  assert.equal(snapshot.status, 'failed')
  assert.equal(snapshot.checks[0].summary, 'Assertion failed')
  assert.equal(seen.length, 3)
  assert.ok(seen.every(path => path.startsWith('https://api.github.com/repos/example/project/')))
})

test('unsupported URLs are refused before any network access', async () => {
  let calls = 0
  for (const unsafe of ['http://github.com/a/b/pull/1', 'https://github.com.evil.test/a/b/pull/1', 'https://user:pass@github.com/a/b/pull/1', 'https://127.0.0.1/pull/1', 'https://github.com/a/b/pull/1?token=secret']) {
    await assert.rejects(readPullRequest(unsafe, new AbortController().signal, async () => { calls++; return Response.json({}) }))
  }
  assert.equal(calls, 0)
  assert.equal(pullSource(url).number, '12')
})

test('missing or truncated checks are never reported as successful', async () => {
  for (const truncated of [false, true]) {
    const snapshot = await readPullRequest(url, new AbortController().signal, async input => {
      if (String(input).endsWith('/pulls/12')) return Response.json({ title: 'Change', state: 'open', merged: false, head: { sha } })
      if (String(input).includes('check-runs')) return Response.json({ total_count: truncated ? 101 : 0, check_runs: truncated ? [{ name: 'test', status: 'completed', conclusion: 'success', output: null }] : [] })
      return Response.json({ total_count: 0, statuses: [] })
    })
    assert.equal(snapshot?.status, 'pending')
  }
})

test('a closed PR finishes even if the old head commit no longer has accessible checks', async () => {
  let calls = 0
  const snapshot = await readPullRequest(url, new AbortController().signal, async () => {
    if (++calls > 1) throw new Error('head repository was deleted')
    return Response.json({ title: 'Merged', state: 'closed', merged: true, head: { sha } })
  })
  assert.equal(snapshot.merged, true)
  assert.equal(calls, 1)
})
