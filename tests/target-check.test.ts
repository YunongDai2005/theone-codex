import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TheOneService, type Run } from '../src/service.ts'
import { CodexBackend } from '../src/codex-backend.ts'
import type { Decision } from '../src/types.ts'
import { targetQuestion } from '../src/target-check.ts'

async function fixture(fn: (s: TheOneService, a: string, b: string, dir: string) => Promise<void>, uncertain: 'alternates' | 'low' | 'clarify' | false = false) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-target-'))
  let decision: Decision
  const backend = new CodexBackend({ command: process.execPath, args: [resolve('tests/fixtures/app-server.mjs')], requestTimeoutMs: 2000 })
  const s = new TheOneService({ dataDir: dir, backend, router: { decide: async () => ({ decision, model: 'fixture', elapsedMs: 1 }) } })
  try {
    const a = s.createTopic('当前项目'), b = s.createTopic('另一个项目')
    decision = { action: 'MOUNT', contextId: a, reason: 'fixture', ...(uncertain === 'alternates' ? { alternateIds: [b] } : uncertain === 'low' ? { needsTargetConfirmation: true } : {}) }
    if (uncertain === 'clarify') decision = { action: 'CLARIFY', reason: 'uncertain', question: 'Which project?' }
    s.configure('main', { workspace: dir, sandbox: 'workspace-write', routerMode: 'model' })
    await fn(s, a, b, dir)
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
}
const request = (details: object = {}) => 'target-check:' + JSON.stringify(details)

test('confident in-project work adds no target question to the native approval', () => fixture(async (s,a) => {
  const r = await s.dispatch({ gatewayId: 'main', inputId: 'm', text: request({ expectedSandbox: 'workspaceWrite' }), topicId: a }) as Run
  const waiting = await s.wait(r.id, 1000)
  assert.equal(waiting.approvals[0].method, 'item/commandExecution/requestApproval')
  assert.equal(waiting.approvals[0].details.targetConfirmation, undefined)
  await s.respond(r.id, waiting.approvals[0].id, { decision: 'accept' })
  assert.equal((await s.wait(r.id, 1000)).status, 'completed')
}))

test('an unclear route settled into a new topic retains low confidence at the mutation gate', () => fixture(async s => {
  const r = await s.dispatch({ gatewayId: 'main', inputId: 'm', text: request({ expectedSandbox: 'readOnly' }) }) as Run
  const waiting = await s.wait(r.id, 1000)
  assert.equal(s.recentRoutes('main').routes[0].receipt?.confidence, 'low')
  assert.equal(waiting.approvals[0].details.targetConfirmation, true)
}, 'clarify'))

for (const uncertainty of ['alternates','low'] as const) test(`${uncertainty} waits before mutation and remembers one target answer while preserving sandbox approval`, () => fixture(async s => {
  const r = await s.dispatch({ gatewayId: 'main', inputId: 'm', text: request({ twice: true, expectedSandbox: 'readOnly' }) }) as Run
  let waiting = await s.wait(r.id, 1000)
  assert.equal(s.recentRoutes('main').routes[0].receipt?.errorCode, undefined)
  if (uncertainty === 'alternates') assert.match(JSON.stringify(waiting.approvals[0].details), /另一个项目/)
  assert.equal(waiting.status, 'waiting_approval'); assert.equal(waiting.waitingKind, 'question')
  assert.equal(waiting.approvals[0].details.targetConfirmation, true)
  assert.equal(waiting.output.length, 0, 'the pending mutation has not completed')
  await assert.rejects(s.respond(r.id, waiting.approvals[0].id, { answers: { wrong: { answers: ['继续'] } } }), /ANSWER|INVALID/)
  await s.respond(r.id, waiting.approvals[0].id, { answers: { target: { answers: ['继续'] } } })
  waiting = await s.wait(r.id, 1000)
  assert.equal(waiting.approvals[0].method, 'item/commandExecution/requestApproval')
  assert.equal(waiting.targetConfirmation, 'confirmed')
  await s.respond(r.id, waiting.approvals[0].id, { decision: 'accept' })
  waiting = await s.wait(r.id, 1000)
  assert.equal(waiting.approvals[0].method, 'item/commandExecution/requestApproval', 'the second command does not ask again')
  await s.respond(r.id, waiting.approvals[0].id, { decision: 'accept' })
  assert.equal((await s.wait(r.id, 1000)).status, 'completed')
}, uncertainty))

for (const file of [false,true]) test(`out-of-project ${file ? 'file' : 'command'} asks using actual item paths before granting permission`, () => fixture(async (s,a) => {
  const r = await s.dispatch({ gatewayId: 'main', inputId: 'm', topicId: a, text: request({ outside: tmpdir(), file }) }) as Run
  const waiting = await s.wait(r.id, 1000)
  assert.equal(waiting.approvals[0].details.targetConfirmation, true)
  assert.match(String((waiting.approvals[0].details.questions as any[])[0].question), /工作目录/)
  await s.respond(r.id, waiting.approvals[0].id, { answers: { target: { answers: ['停止'] } } })
  const done = await s.wait(r.id, 1000)
  assert.equal(done.targetConfirmation, 'declined')
  assert.equal(done.output[0].text, 'declined')
}))

test('cancelling a pending target question clears it and never authorizes a request', () => fixture(async s => {
  const r = await s.dispatch({ gatewayId: 'main', inputId: 'm', text: request() }) as Run
  const waiting = await s.wait(r.id, 1000)
  assert.equal(waiting.approvals[0].details.targetConfirmation, true)
  assert.equal((await s.cancel(r.id)).status, 'cancelled')
  await assert.rejects(s.respond(r.id, waiting.approvals[0].id, { answers: { target: { answers: ['继续'] } } }), /APPROVAL/)
}, 'alternates'))

test('a later message queues instead of inheriting a previous message target confirmation through steering', () => fixture(async (s,a) => {
  const first = await s.dispatch({ gatewayId: 'main', inputId: 'first', text: request({ hold: true }) }) as Run
  let waiting = await s.wait(first.id, 1000)
  await s.respond(first.id, waiting.approvals[0].id, { answers: { target: { answers: ['继续'] } } })
  waiting = await s.wait(first.id, 1000)
  await s.respond(first.id, waiting.approvals[0].id, { decision: 'accept' })
  const second = await s.dispatch({ gatewayId: 'main', inputId: 'second', topicId: a, text: '下一件事' }) as Run
  assert.equal(second.status, 'queued'); assert.equal(second.steeringOf, undefined)
  await s.cancel(first.id)
  assert.equal((await s.wait(second.id, 1000)).status, 'completed')
}, 'alternates'))

test('target boundaries include sibling names and rename destinations, but allow a new file inside the workspace', () => fixture(async (_s,_a,_b,dir) => {
  const check = { title: '当前项目', uncertain: false, alternateTitles: [] }
  assert.equal(targetQuestion(check, dir, { path: './new/sub/file.txt' }), undefined)
  assert.ok(targetQuestion(check, dir, { path: dir + '-other/file.txt' }))
  assert.ok(targetQuestion(check, dir, { changes: [{ path: 'old.txt', kind: { move_path: '../other.txt' } }] }))
  assert.ok(targetQuestion(check, dir, { cwd: dir, additionalPermissions: { fileSystem: { write: [tmpdir()] } } }))
  assert.ok(targetQuestion(check, dir, { cwd: dir, additionalPermissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: tmpdir() } }] } } }))
}))
