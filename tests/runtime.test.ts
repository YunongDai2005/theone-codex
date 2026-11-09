import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TheOneService, type Run } from '../src/service.ts'
import { CodexBackend } from '../src/codex-backend.ts'
import { RuntimeStore } from '../src/runtime-store.ts'

test('execution leases block both identical and overlapping workspace roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-lock-'))
  const a = new RuntimeStore(join(dir, 'runtime.db')), b = new RuntimeStore(join(dir, 'runtime.db'))
  try {
    assert.equal(a.lock([`workspace:${dir}`, 'topic:a'], 'run-a'), true)
    assert.equal(b.lock([`workspace:${join(dir, 'child')}`, 'topic:b'], 'run-b'), false)
    assert.equal(b.lock([`workspace:${dir}`, 'topic:b'], 'run-b'), false)
    a.unlock('run-a'); assert.equal(b.lock([`workspace:${join(dir, 'child')}`, 'topic:b'], 'run-b'), true)
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('queued work rechecks permissions and child-folder work does not bypass project queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-queue-')), child = join(dir, 'child'); mkdirSync(child)
  const s = new TheOneService({ dataDir: dir, backend: new CodexBackend({ command: process.execPath, args: [resolve('tests/fixtures/app-server.mjs')] }) })
  try {
    s.configure('main', { workspace: dir, sandbox: 'workspace-write' })
    const a = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：hang' }) as Run
    const b = await s.dispatch({ gatewayId: 'main', inputId: 'b', text: '新话题：child work', cwd: child }) as Run
    assert.equal(b.status, 'queued')
    s.configure('main', { sandbox: 'read-only' })
    await s.cancel(a.id)
    const result = await s.wait(b.id, 3000)
    assert.equal(result.status, 'completed')
    assert.equal(JSON.parse(result.output[0].text).sandbox.type, 'readOnly')
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('dead-owner recovery preserves outputs and never restarts an uncertain turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-recover-'))
  const a = new TheOneService({ dataDir: dir })
  a.configure('main', { workspace: dir })
  const routed = await a.route({ gatewayId: 'main', inputId: 'a', text: '新话题：恢复' })
  const run: Run = { id: 'dead-run', gatewayId: 'main', inputId: 'a', topicId: routed.topicId!, cwd: dir, text: '恢复', status: 'running', at: 0, updatedAt: 0, pid: 2147483647, owner: 'dead', approvals: [], output: [{ id: 'a', text: 'already produced' }], delivered: false }
  a.runtime.put('run', run.id, run); a.runtime.lock([`workspace:${dir}`], run.id)
  // This instance did not own the seeded dead worker, so closing it does not alter that run.
  await a.close()
  const b = new TheOneService({ dataDir: dir })
  try {
    assert.equal(b.run(run.id).status, 'interrupted')
    assert.equal(b.run(run.id).output[0].text, 'already produced')
    assert.equal(b.runtime.lock([`workspace:${dir}`], 'next-run'), true)
  } finally { await b.close(); rmSync(dir, { recursive: true, force: true }) }
})
