import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { CodexBackend } from '../src/codex-backend.ts'
import { TheOneService, type Run } from '../src/service.ts'

async function fixture(fn: (service: TheOneService, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-worker-'))
  const backend = new CodexBackend({ command: process.execPath, args: [resolve('tests/fixtures/app-server.mjs')], requestTimeoutMs: 3000 })
  const service = new TheOneService({ dataDir: dir, backend })
  try { service.configure('main', { workspace: dir }); await fn(service, dir) }
  finally { await service.close(); rmSync(dir, { recursive: true, force: true }) }
}
test('A/B keep separate threads, duplicate delivery executes once, returning A resumes its history', async () => fixture(async s => {
  const a = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：论文' }) as Run
  const b = await s.dispatch({ gatewayId: 'main', inputId: 'b', text: '新话题：露营' }) as Run
  assert.equal(b.status, 'queued')
  const aa = await s.wait(a.id, 3000), bb = await s.wait(b.id, 3000)
  assert.equal(aa.status, 'completed'); assert.equal(bb.status, 'completed'); assert.notEqual(aa.threadId, bb.threadId)
  const duplicate = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：论文' }) as Run
  assert.equal(duplicate.id, a.id); assert.equal(duplicate.output.length, 1)
  const again = await s.dispatch({ gatewayId: 'main', inputId: 'c', text: '继续论文' }) as Run
  const done = await s.wait(again.id, 3000)
  assert.equal(done.threadId, aa.threadId)
  assert.deepEqual(JSON.parse(done.output[0].text).history, ['新话题：论文', '继续论文'])
  assert.equal(JSON.parse(done.output[0].text).sandbox.type, 'readOnly')
}))
test('approval is bound to one request and cannot be replayed', async () => fixture(async s => {
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：approve' }) as Run
  const waiting = await s.wait(run.id, 3000)
  assert.equal(waiting.status, 'waiting_approval')
  await assert.rejects(s.respond(run.id, 'wrong', { decision: 'accept' }), /APPROVAL/)
  await s.respond(run.id, waiting.approvals[0].id, { decision: 'decline' })
  const done = await s.wait(run.id, 3000)
  assert.equal(done.output[0].text, 'declined')
  await assert.rejects(s.respond(run.id, waiting.approvals[0].id, { decision: 'accept' }), /APPROVAL/)
}))
test('cancellation stops the actual turn and lets queued work continue', async () => fixture(async s => {
  const a = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：hang' }) as Run
  const b = await s.dispatch({ gatewayId: 'main', inputId: 'b', text: '新话题：露营' }) as Run
  for (let i = 0; i < 50 && !s.run(a.id).turnId; i++) await new Promise(r => setTimeout(r, 20))
  const stopped = await s.cancel(a.id)
  assert.equal(stopped.status, 'cancelled')
  assert.equal((await s.wait(b.id, 3000)).status, 'completed')
}))
test('disconnection is reported, never automatically replays a possibly executed turn', async () => fixture(async s => {
  const r = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：crash' }) as Run
  const done = await s.wait(r.id, 3000)
  assert.equal(done.status, 'interrupted')
  assert.match(done.error!, /DISCONNECTED/)
  const repeated = await s.dispatch({ gatewayId: 'main', inputId: 'a', text: '新话题：crash' }) as Run
  assert.equal(repeated.status, 'interrupted')
}))

test('worker questions require the matching answer keys and unsupported global requests fail closed', async () => fixture(async s => {
  const question = await s.dispatch({ gatewayId: 'main', inputId: 'q', text: '新话题：question-request' }) as Run
  const waiting = await s.wait(question.id, 3000)
  assert.equal(waiting.status, 'waiting_approval')
  await assert.rejects(s.respond(question.id, waiting.approvals[0].id, { answers: { wrong: { answers: ['blue'] } } }), /ANSWER/)
  await s.respond(question.id, waiting.approvals[0].id, { answers: { color: { answers: ['blue'] } } })
  assert.match((await s.wait(question.id, 3000)).output[0].text, /blue/)
  const unknown = await s.dispatch({ gatewayId: 'main', inputId: 'u', text: '新话题：unknown-request' }) as Run
  assert.equal((await s.wait(unknown.id, 3000)).status, 'completed')
}))
