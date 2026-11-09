import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectQueue } from '../../src/project-queue.ts'

test('same-project turns wait, other projects proceed, cancelled waiters never acquire', async () => {
  const queue = new ProjectQueue()
  const first = await queue.acquire('a')
  let secondStarted = false
  const cancelled = new AbortController()
  const second = queue.acquire('a', cancelled.signal).then(() => { secondStarted = true }, () => {})
  const third = queue.acquire('a')
  const other = await queue.acquire('b')
  await Promise.resolve()
  assert.equal(secondStarted, false)
  cancelled.abort()
  await second
  first(); first()
  const release = await third
  release(); other()
  const again = await queue.acquire('a')
  again()
  queue.close()
  await assert.rejects(queue.acquire('a'))
})
