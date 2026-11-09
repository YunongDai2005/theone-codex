import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService, type Run } from '../src/service.ts'
import type { WorkerBackend, WorkerRequest } from '../src/backend.ts'
import type { RoutingInput, RoutingRouter } from '../src/llm-router.ts'

async function fixture(fn: (s: TheOneService, state: { calls: RoutingInput[]; executions: WorkerRequest[]; steered: any[]; release: () => void }) => Promise<void>, held = false) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-routing-parity-'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const state = { calls: [] as RoutingInput[], executions: [] as WorkerRequest[], steered: [] as any[], release }
  const router: RoutingRouter = { decide: async input => {
    state.calls.push(input)
    return { decision: input.text.includes('插问') ? { action: 'CREATE', title: '临时问题', aside: true, reason: 'aside' }
      : { action: 'KEEP', contextId: input.currentId ?? input.contexts[0]?.id, reason: 'fixture' }, model: 'fixture', elapsedMs: 1 }
  } }
  const backend: WorkerBackend = { execute: async (request, emit) => {
    state.executions.push(request); emit({ type: 'started', threadId: 'native-' + request.runId, turnId: 'turn-' + request.runId })
    if (held) await gate
    emit({ type: 'message', id: request.runId + '-answer', text: 'answer' }); return { status: 'completed' }
  }, steer: async request => { state.steered.push(request) }, respond: async () => {}, close: async () => {} }
  const s = new TheOneService({ dataDir: dir, router, backend })
  try { s.desktopBind('p', 'main', dir); await fn(s, state) }
  finally { release(); await s.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('model aside keeps the original mount, folds after answering, and bare continuation returns without inference', () => fixture(async (s, state) => {
  const main = s.createTopic('写作'); s.selectTopic('main', main)
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'aside', text: '插问一个小问题' }) as Run
  assert.notEqual(run.topicId, main)
  assert.equal(s.store.current('main'), main)
  await s.wait(run.id, 1000)
  assert.equal(s.desktopSnapshot('p').topics.find(t => t.id === run.topicId)?.oneOff, true)
  assert.equal(s.desktopSnapshot('p').topics.find(t => t.id === run.topicId)?.done, true)
  s.acknowledge(run.id)
  const count = state.calls.length
  const next = await s.route({ gatewayId: 'main', inputId: 'next', text: '继续' })
  assert.equal(next.topicId, main); assert.equal(state.calls.length, count)
  assert.equal(next.decision.reason, 'continuation-temporary-return')
}))

test('a follow-up about the aside goes to its foreground topic instead of the return topic', () => fixture(async (s, state) => {
  const main = s.createTopic('写作'); s.selectTopic('main', main)
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'aside', text: '插问一个小问题' }) as Run
  await s.wait(run.id, 1000); s.acknowledge(run.id)
  const count = state.calls.length, next = await s.route({ gatewayId: 'main', inputId: 'why', text: '为什么' })
  assert.equal(next.topicId, run.topicId); assert.equal(state.calls.length, count)
}))

test('an aside without a mounted topic is still temporary and does not become the default mount', () => fixture(async s => {
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'standalone-aside', text: '插问一个小问题' }) as Run
  await s.wait(run.id, 1000); s.acknowledge(run.id)
  assert.equal(s.store.current('main'), undefined)
  const topic = s.desktopSnapshot('p').topics.find(t => t.id === run.topicId)
  assert.equal(topic?.oneOff, true); assert.equal(topic?.done, true)
}))

test('running input steers the live native turn once and shares its eventual outcome', () => fixture(async (s, state) => {
  const topic = s.createTopic('写作')
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'first', text: '写一篇文章', topicId: topic }) as Run
  const cursor = s.desktopSnapshot('p').cursor
  const input = { gatewayId: 'main', inputId: 'more', text: '加一个简短结论', topicId: topic }
  const supplement = await s.dispatch(input) as Run
  assert.equal(supplement.steeringOf, run.id)
  await s.dispatch(input)
  assert.equal(state.steered.length, 1); assert.equal(state.executions.length, 1)
  assert.equal(state.steered[0].turnId, run.turnId)
  const event = s.desktopSnapshot('p', cursor).events.find(e => e.type === 'route.assigned' && e.messageIds[0] === 'more')
  assert.equal(event?.type === 'route.assigned' && event.source, 'steering')
  state.release(); const finished = await s.wait(supplement.id, 1000)
  assert.equal(finished.status, 'completed'); assert.equal(finished.output.length, 1)
}, true))

test('a newly read-only input queues instead of steering a still-write-enabled turn', () => fixture(async (s, state) => {
  const topicId = s.createTopic('写作'); s.configure('main', { sandbox: 'workspace-write' })
  const first = await s.dispatch({ gatewayId: 'main', inputId: 'first', text: '写文章', topicId }) as Run
  s.configure('main', { sandbox: 'read-only' })
  const extra = await s.dispatch({ gatewayId: 'main', inputId: 'extra', text: '只阅读', topicId }) as Run
  assert.equal(extra.status, 'queued'); assert.equal(state.steered.length, 0)
  state.release(); await s.wait(first.id, 1000); await s.wait(extra.id, 1000)
  assert.equal(state.executions[1].sandbox, 'read-only')
}, true))

test('running request/progress and saved corrections are supplied to the next model decision', () => fixture(async (s, state) => {
  const topic = s.createTopic('写作')
  const run = await s.dispatch({ gatewayId: 'main', inputId: 'first', text: '写一篇文章', topicId: topic }) as Run
  await s.route({ gatewayId: 'main', inputId: 'route', text: '加一个简短结论' })
  assert.equal(state.calls.at(-1)?.running?.topicId, topic)
  assert.equal(state.calls.at(-1)?.running?.request, run.text)
  state.release(); await s.wait(run.id, 1000)
  const other = s.createTopic('露营'); s.correct('main', 'route', other)
  await s.route({ gatewayId: 'main', inputId: 'corrected-next', text: '再做一个具体安排' })
  assert.equal(state.calls.at(-1)?.corrections?.[0].rightId, other)
}, true))

test('background completion never steals the foreground continuation', () => fixture(async (s, state) => {
  const a = s.createTopic('写作'), b = s.createTopic('露营')
  const first = await s.dispatch({ gatewayId: 'main', inputId: 'first', text: '写一段', topicId: a }) as Run
  await s.wait(first.id, 1000); s.acknowledge(first.id)
  const second = await s.dispatch({ gatewayId: 'main', inputId: 'second', text: '安排出行', topicId: b, foreground: false }) as Run
  await s.wait(second.id, 1000); s.acknowledge(second.id)
  assert.equal(s.store.current('main'), a)
  const count = state.calls.length, next = await s.route({ gatewayId: 'main', inputId: 'next', text: '继续' })
  assert.equal(next.topicId, a); assert.equal(state.calls.length, count)
}))

test('a question after steering is answered through the supplemental run exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-steer-question-'))
  let notify!: Parameters<WorkerBackend['execute']>[1], release!: () => void, answers = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const backend: WorkerBackend = { execute: async (request, emit) => {
    notify = emit; emit({ type: 'started', threadId: 'native', turnId: 'turn' }); await gate; return { status: 'completed' }
  }, steer: async () => {}, respond: async () => { answers++ }, close: async () => {} }
  const s = new TheOneService({ dataDir: dir, backend })
  try {
    s.configure('main', { workspace: dir, routerMode: 'rules' }); const topicId = s.createTopic('写作')
    const first = await s.dispatch({ gatewayId: 'main', inputId: 'first', text: '写文章', topicId }) as Run
    const extra = await s.dispatch({ gatewayId: 'main', inputId: 'extra', text: '加结论', topicId }) as Run
    notify({ type: 'approval', approval: { id: 'q', requestId: 123, method: 'item/tool/requestUserInput', details: {}, threadId: 'native', turnId: 'turn', expiresAt: Date.now() + 10000 } })
    assert.equal(s.runtime.activity('main').find(r => r.id === extra.id)?.waitingKind, 'question')
    await s.respond(extra.id, 'q', { answers: {} })
    assert.equal(s.run(first.id).status, 'running'); assert.equal(s.run(extra.id).status, 'running')
    await assert.rejects(s.respond(first.id, 'q', { answers: {} }), /APPROVAL_EXPIRED_OR_UNKNOWN/)
    assert.equal(answers, 1)
  } finally { release(); await s.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('attachment-only input keeps the current topic and forwards its actual image input to the worker', () => fixture(async (s, state) => {
  const a = s.createTopic('看图'); s.selectTopic('main', a)
  const input = { gatewayId: 'main', inputId: 'image', text: '', attachments: [{ type: 'image' as const, url: 'https://example.com/image.png' }] }
  const result = await s.dispatch(input)
  assert.equal(result.topicId, a); assert.equal(state.calls.length, 0)
  assert.deepEqual(state.executions[0].attachments, input.attachments)
  assert.equal(s.store.routeReceipt((result as Run).id)?.source, 'rules')
}))
