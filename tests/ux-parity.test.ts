import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TheOneService, type Run, type Message } from '../src/service.ts'
import { CodexBackend } from '../src/codex-backend.ts'
import { RouterFailure } from '../src/llm-router.ts'

async function fixture(fn: (s: TheOneService, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-ux-'))
  const s = new TheOneService({ dataDir: dir, backend: new CodexBackend({ command: process.execPath, args: [resolve('tests/fixtures/app-server.mjs')] }) })
  try { s.configure('main', { workspace: dir, routerMode: 'rules' }); await fn(s, dir) }
  finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('recent routes stay scoped to their gateway and corrections undo both history and selection', () => fixture(async (s, dir) => {
  const a = s.createTopic('甲'), b = s.createTopic('乙')
  await s.route({ gatewayId: 'main', inputId: 'original', text: '要改的消息', topicId: a })
  s.configure('other', { workspace: dir }); await s.route({ gatewayId: 'other', inputId: 'hidden', text: '另一个主聊天', topicId: b })
  assert.equal(s.recentRoutes('main').routes.length, 1)
  assert.equal(s.recentRoutes('main').routes[0].inputId, 'original')
  s.correct('main', 'original', b)
  assert.equal(s.recentRoutes('main').routes[0].correctedTo, b)
  assert.equal(s.store.current('main'), b)
  assert.equal(s.search('要改的消息')[0].topicId, b)
  s.correct('main', 'original', undefined, true)
  assert.equal(s.recentRoutes('main').routes[0].correctedTo, undefined)
  assert.equal(s.search('要改的消息')[0].topicId, a)
  assert.equal(s.store.current('main'), a)
  assert.equal((await s.route({ gatewayId: 'main', inputId: 'original', text: '要改的消息', topicId: a })).topicId, a)
  assert.throws(() => s.correct('main', 'original', undefined, true), { message: 'NOT_MOVED', statusCode: 409 })
}))

test('undo rejects a busy destination and leaves the correction intact', () => fixture(async s => {
  const a = s.createTopic('甲'), b = s.createTopic('乙')
  await s.route({ gatewayId: 'main', inputId: 'm', text: 'test', topicId: a }); s.correct('main', 'm', b)
  await s.dispatch({ gatewayId: 'main', inputId: 'busy', text: 'hang', topicId: a })
  assert.throws(() => s.correct('main', 'm', undefined, true), { message: 'TOPIC_BUSY', statusCode: 409 })
  assert.equal(s.recentRoutes('main').routes.find(r => r.inputId === 'm')!.correctedTo, b)
}))

test('worker briefing treats a return after three days as historical even after the new message is recorded', () => fixture(async s => {
  const topicId = s.createTopic('预算', '预算 2000 元，进度 50%，交付日期 2026-10-01')
  s.runtime.put('message', 'old', { id: 'old', topicId, role: 'user', text: '预算 2000 元', source: 'gateway', at: Date.now() - 4 * 86400000 } satisfies Message)
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'return', topicId, text: '接着做' }) as Run
  const done = await s.wait(run.id, 1000), wire = JSON.parse(done.output[0].text)
  assert.match(wire.input[0].text, /上次记录是/)
  assert.match(wire.input[0].text, /日期、金额、进度/)
  const recent = await s.dispatch({ gatewayId: 'main', inputId: 'again', topicId, text: '接着说' }) as Run
  const reference = JSON.parse((await s.wait(recent.id, 1000)).output[0].text).input[0].text.split('\n').slice(1).join('\n')
  assert.equal(JSON.parse(reference).returnNote, undefined)
}))

test('only three independent projects start across connections; a released slot drains queued work', () => fixture(async (s, dir) => {
  const other = new TheOneService({ dataDir: dir, backend: new CodexBackend({ command: process.execPath, args: [resolve('tests/fixtures/app-server.mjs')] }) })
  try {
    const runs: Run[] = []
    for (let i = 0; i < 4; i++) {
      const cwd = join(dir, `project-${i}`); mkdirSync(cwd)
      runs.push(await (i === 3 ? other : s).dispatch({ gatewayId: 'main', inputId: `run-${i}`, topicId: s.createTopic(`话题${i}`), text: i < 3 ? 'hang' : 'finish', cwd }) as Run)
    }
    assert.equal(other.run(runs[3].id).status, 'queued')
    assert.equal(other.run(runs[3].id).queueReason, 'capacity')
    await s.cancel(runs[0].id)
    assert.equal((await other.wait(runs[3].id, 2000)).status, 'completed')
    assert.equal(s.run(runs[1].id).status, 'running')
  } finally { await other.close() }
}))

test('feedback diagnostics project only versions, receipt sources, codes and timings', () => fixture(async (s, dir) => {
  const topicId = s.createTopic('SECRET_TITLE')
  await s.route({ gatewayId: 'main', inputId: 'SECRET_ID', text: 'SECRET_BODY ' + dir, topicId })
  const diagnostics = await s.feedbackDiagnostics('main', 'SECRET_ID')
  assert.equal(diagnostics.version, '0.1.0-alpha.9')
  assert.equal(diagnostics.routes[0].source, 'explicit')
  assert.ok('codexVersion' in diagnostics)
  assert.equal(diagnostics.codexVersion, '1.2.3')
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|theone-ux-|thread|topicId|messageId|excerpt/)
}))

test('feedback excludes free-form router errors and backend version paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-private-diagnostics-'))
  const s = new TheOneService({ dataDir: dir, router: { decide: async () => { throw new RouterFailure('SECRET_ERROR ' + dir) } },
    backend: { execute: async () => ({ status: 'completed' }), respond: async () => {}, close: async () => {}, version: async () => dir } })
  try {
    s.configure('main', { workspace: dir, routerMode: 'model' })
    await s.route({ gatewayId: 'main', inputId: 'SECRET_ID', text: 'SECRET_BODY', proposal: undefined })
    const report = await s.feedbackDiagnostics('main')
    assert.equal(report.codexVersion, 'unknown'); assert.equal(report.routes[0].errorCode, 'OTHER')
    assert.doesNotMatch(JSON.stringify(report), /SECRET|theone-private-diagnostics|[A-Z]:\\/)
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
})
