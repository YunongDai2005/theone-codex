import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'
import { TaskManager } from '../src/tasks.ts'

test('task pause aborts an active check, and a completed PR stores a local notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-tasks-')), s = new TheOneService({ dataDir: dir })
  let aborted = false, hanging = true, started!: () => void
  const startedPromise = new Promise<void>(r => started = r)
  const tasks = new TaskManager(s, dir, async (_url, init) => {
    if (!hanging) return Response.json({ state: 'closed', merged: true, title: 'fixture', head: { sha: 'a'.repeat(40) } })
    started()
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason) }, { once: true }))
  })
  try {
    s.configure('main', { workspace: dir })
    const job = tasks.create({ gatewayId: 'main', key: '1', url: 'https://github.com/example/repo/pull/1', objective: '跟踪测试 PR' })
    const running = tasks.work.tick()
    await startedPromise
    tasks.control(job.id, 'pause')
    assert.equal(aborted, true)
    await running
    hanging = false; tasks.control(job.id, 'resume'); await tasks.work.tick()
    assert.equal(tasks.list().tasks[0].state, 'completed')
    assert.equal(tasks.list().notices.length, 1)
    tasks.acknowledge(tasks.list().notices[0].id)
    assert.equal(tasks.list().notices.length, 0)
  } finally { await tasks.close(); await s.close(); rmSync(dir, { recursive: true, force: true }) }
})
