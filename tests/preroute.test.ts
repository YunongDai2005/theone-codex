import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'
import { hookContext } from '../src/hook.ts'
import type { RoutingRouter } from '../src/llm-router.ts'
import { Preroutes, enqueuePreroute, PREROUTE_LIMIT } from '../src/preroute.ts'
import { RuntimeStore } from '../src/runtime-store.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function fixture(fn: (s: TheOneService, state: { calls: number; release: () => void }, topic: string, dir: string) => Promise<void>, held = false) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-preroute-'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const state = { calls: 0, release }
  const router: RoutingRouter = { decide: async (input, signal) => {
    state.calls++
    if (held) await Promise.race([gate, new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))])
    return { decision: { action: 'MOUNT', contextId: input.contexts[0].id, reason: 'fixture' }, model: 'fixture', elapsedMs: 1 }
  } }
  const s = new TheOneService({ dataDir: dir, router, backend: { execute: async () => ({ status: 'completed' }), respond: async () => {}, close: async () => {} } })
  try { s.configure('main', { workspace: dir }); const topic = s.createTopic('写作'); await fn(s, state, topic, dir) }
  finally { release(); await s.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('preroute returns immediately, deduplicates, and completed dispatch reuses the full routing result', async () => fixture(async (s, state, topic) => {
  assert.equal(typeof s.preroute, 'function')
  const input = { gatewayId: 'main', inputId: 'one', text: '安排后续工作' }
  const first = s.preroute(input), second = s.preroute(input)
  assert.equal(first.key, second.key)
  await tick()
  assert.equal(state.calls, 1)
  assert.equal(s.readTopic(topic).messages.length, 0, 'speculation cannot route or execute input')
  const result = await s.dispatch(input)
  assert.equal(result.topicId, topic); assert.equal(result.receipt.source, 'preroute')
  assert.equal(result.receipt.waitMs, 0); assert.equal(state.calls, 1)
  s.preroute(input); await tick(); assert.equal(state.calls, 1)
}))

test('in-flight validated high proposal runs immediately and records agreement with the shadow', async () => fixture(async (s, state, topic) => {
  assert.equal(typeof s.preroute, 'function')
  const input = { gatewayId: 'main', inputId: 'one', text: '安排后续工作' }
  s.preroute(input); await tick()
  const result = await s.dispatch({ ...input, proposal: { topicId: topic, confidence: 'high' } })
  assert.equal(result.receipt.source, 'proposal'); assert.equal(result.receipt.waitMs, 0)
  state.release(); await tick()
  const shadow = s.runtime.all<any>('preroute-shadow')[0]
  assert.equal(shadow.agreed, true); assert.equal(state.calls, 1)
}, true))

test('in-flight missing or invalid proposals wait for the existing operation without a second call', async () => {
  for (const proposal of [undefined, { topicId: 'missing', confidence: 'high' as const }, { topicId: 'missing', confidence: 'low' as const }]) await fixture(async (s, state, topic) => {
    assert.equal(typeof s.preroute, 'function')
    const input = { gatewayId: 'main', inputId: 'one', text: '安排后续工作' }
    s.preroute(input); await tick()
    let completed = false
    const pending = s.dispatch({ ...input, proposal }).then(result => { completed = true; return result })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(completed, false)
    state.release()
    const result = await pending
    assert.equal(result.topicId, topic); assert.equal(result.receipt.source, 'preroute')
    assert.ok(result.receipt.waitMs! >= 10); assert.equal(state.calls, 1)
  }, true)
})

test('explicit topic discards speculation and never waits for it', async () => fixture(async (s, state, topic) => {
  assert.equal(typeof s.preroute, 'function')
  const other = s.createTopic('露营'), input = { gatewayId: 'main', inputId: 'one', text: '安排后续工作' }
  s.preroute(input); await tick()
  const result = await s.dispatch({ ...input, topicId: other })
  assert.equal(result.topicId, other); assert.equal(result.receipt.source, 'explicit')
  state.release(); await tick(); assert.equal(s.runtime.all('preroute-shadow').length, 0)
  assert.equal(s.readTopic(topic).messages.length, 0)
}, true))

test('anonymous normalized-text speculation is consumed by one input and isolated by gateway', async () => fixture(async (s, state, topic, dir) => {
  assert.equal(typeof s.preroute, 'function')
  s.configure('other', { workspace: dir })
  const first = s.preroute({ gatewayId: 'main', text: 'Ａ  后续\r\n工作' })
  assert.equal(s.preroute({ gatewayId: 'main', text: 'A 后续 工作' }).key, first.key)
  await tick()
  const result = await s.dispatch({ gatewayId: 'main', inputId: 'one', text: 'A 后续 工作' })
  assert.equal(result.receipt.source, 'preroute'); assert.equal(result.topicId, topic)
  s.preroute({ gatewayId: 'main', text: 'A 后续 工作' }); await tick()
  assert.equal(state.calls, 1, 'the same anonymous key remains deduplicated after consumption')
  const other = await s.route({ gatewayId: 'other', inputId: 'one', text: 'A 后续 工作' })
  assert.notEqual(other.receipt.source, 'preroute')
  const repeated = await s.route({ gatewayId: 'main', inputId: 'two', text: 'A 后续 工作' })
  assert.notEqual(repeated.receipt.source, 'preroute'); assert.equal(state.calls, 3)
}))

test('expired entries reroute and same input id with different text is rejected', async t => fixture(async (s, state) => {
  assert.equal(typeof s.preroute, 'function')
  const input = { gatewayId: 'main', inputId: 'one', text: '安排后续工作' }
  s.preroute(input); await tick()
  assert.throws(() => s.preroute({ ...input, text: 'different' }), /INPUT_CONFLICT/)
  const now = Date.now(); const clock = t.mock.method(Date, 'now', () => now + 600000)
  try {
    const result = await s.dispatch(input)
    assert.notEqual(result.receipt.source, 'preroute'); assert.equal(state.calls, 2)
  } finally { clock.mock.restore() }
}))

test('hook queues once with turn_id, makes no model call, and the server consumes the queue', async () => fixture(async (s, state, topic, dir) => {
  const context = hookContext({ session_id: 'main', turn_id: 'turn-1', prompt: '安排后续工作' }, dir)
  assert.match(JSON.stringify(context), /turn-1/)
  assert.equal(s.runtime.all('preroute').length, 1)
  hookContext({ session_id: 'main', turn_id: 'turn-1', prompt: '安排后续工作' }, dir)
  assert.equal(state.calls, 0); assert.equal(s.runtime.all('preroute').length, 1)
  const result = await s.dispatch({ gatewayId: 'main', inputId: 'turn-1', text: '安排后续工作' })
  assert.equal(result.receipt.source, 'preroute'); assert.equal(result.topicId, topic); assert.equal(state.calls, 1)
}))

test('queued hook work is discarded when the gateway was disabled before the server claimed it', () => fixture(async (s, state, _topic, dir) => {
  hookContext({ session_id: 'main', turn_id: 'disabled', prompt: '安排后续工作' }, dir)
  s.configure('main', { enabled: false })
  await new Promise(resolve => setTimeout(resolve, 550))
  assert.equal(state.calls, 0)
  assert.equal(s.runtime.all<any>('preroute')[0].state, 'discarded')
}))

test('switching to rules while a preroute is pending discards its model decision', () => fixture(async (s, state) => {
  const input = { gatewayId: 'main', inputId: 'rules-change', text: '安排后续工作' }
  s.preroute(input); await tick(); s.configure('main', { routerMode: 'rules' }); state.release()
  const result = await s.route(input)
  assert.equal(result.receipt.source, 'rules'); assert.equal(state.calls, 1)
}, true))

test('disabling a gateway while dispatch waits prevents assigning or executing its cached result', () => fixture(async (s, state, topic) => {
  const input = { gatewayId: 'main', inputId: 'disabled-wait', text: '安排后续工作' }
  s.preroute(input); await tick()
  const pending = s.dispatch(input)
  s.configure('main', { enabled: false }); state.release()
  await assert.rejects(pending, /GATEWAY_DISABLED/)
  assert.equal(s.readTopic(topic).messages.length, 0); assert.equal(s.runs().length, 0)
}, true))

test('a cached topic excluded while waiting cannot be assigned or resurrected by unclear fallback', () => fixture(async (s, state, topic) => {
  const input = { gatewayId: 'main', inputId: 'excluded-wait', text: '安排后续工作' }
  s.selectTopic('main', topic); s.preroute(input); await tick()
  const pending = s.route(input)
  s.manageTopic(topic, { excluded: true }); state.release()
  const result = await pending
  assert.notEqual(result.topicId, topic); assert.equal(state.calls, 1)
}, true))

test('renderer/hook trigger order and multiple service connections still perform one route', () => fixture(async (s, state, _topic, dir) => {
  const second = new TheOneService({ dataDir: dir, router: { decide: async () => { throw Error('duplicate inference') } } })
  try {
    const text = '安排后续工作', renderer = s.preroute({ gatewayId: 'main', text })
    hookContext({ session_id: 'main', turn_id: 'turn-1', prompt: text }, dir)
    assert.equal(second.preroute({ gatewayId: 'main', inputId: 'turn-1', text }).key, renderer.key)
    await tick(); assert.equal(state.calls, 1); state.release()
    const route = await second.route({ gatewayId: 'main', inputId: 'turn-1', text })
    assert.equal(route.receipt.source, 'preroute')
    hookContext({ session_id: 'main', turn_id: 'turn-2', prompt: '下一个任务' }, dir)
    const hooked = s.runtime.all<any>('preroute').find(e => e.inputId === 'turn-2')
    assert.equal(s.preroute({ gatewayId: 'main', text: '下一个任务' }).key, hooked.key)
    await tick(); assert.equal(state.calls, 2)
  } finally { await second.close() }
}, true))

test('bounded queue refuses excess active entries and frees only expired or finished entries', () => fixture(async s => {
  for (let i = 0; i < PREROUTE_LIMIT; i++) enqueuePreroute(s.runtime, { gatewayId: 'main', inputId: String(i), text: 'queued' })
  assert.throws(() => enqueuePreroute(s.runtime, { gatewayId: 'main', inputId: 'extra', text: 'queued' }), /PREROUTE_CAPACITY/)
  const first = s.runtime.all<any>('preroute')[0]
  s.runtime.put('preroute', first.key, { ...first, state: 'done' })
  enqueuePreroute(s.runtime, { gatewayId: 'main', inputId: 'extra', text: 'queued' })
  assert.equal(s.runtime.all('preroute').length, PREROUTE_LIMIT)
  assert.equal(s.runtime.get('preroute', first.key), undefined)
}))

test('waiting retains the original inference deadline and never starts a replacement call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-pre-deadline-')), db = new RuntimeStore(join(dir, 'runtime.db'))
  let calls = 0
  const pre = new Preroutes(db, async (_entry, signal) => {
    calls++; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    throw Error('unreachable')
  }, new AbortController().signal, 50)
  try {
    const input = { gatewayId: 'main', inputId: 'one', text: 'slow' }; pre.enqueue(input)
    await new Promise(resolve => setTimeout(resolve, 20))
    await assert.rejects(pre.wait(pre.take(input)!), /ROUTER_TIMEOUT/)
    assert.equal(calls, 1)
    await pre.close()
    assert.equal(db.all<any>('preroute')[0].state, 'discarded')
  } finally { await pre.close(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('pre-routing runs the same retry and recheck pipeline and preserves the receipt', () => fixture(async (s, state, topic) => {
  const router = (s as any).options.router
  router.decide = async () => {
    state.calls++
    if (state.calls === 1) throw Error('ROUTER_INVALID_JSON')
    return { decision: state.calls === 2 ? { action: 'CREATE', title: '新计划', reason: 'new' } : { action: 'MOUNT', contextId: topic, reason: 'reviewed' }, model: 'fixture', elapsedMs: 1 }
  }
  const input = { gatewayId: 'main', inputId: 'review', text: '安排后续工作' }
  s.preroute(input); await tick()
  const result = await s.route(input)
  assert.equal(result.receipt.source, 'preroute'); assert.equal(state.calls, 3)
  assert.deepEqual(result.receipt.callDetails?.map(call => call.layer), ['quick','quick','recheck'])
}))
