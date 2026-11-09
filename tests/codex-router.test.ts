import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodexRouter } from '../src/codex-router.ts'
import { RouterFailure } from '../src/llm-router.ts'
import { recommendedRouterModel } from '../src/router-model-settings.ts'
// @ts-expect-error JavaScript fixture has no declaration file.
import { installInProcessRouter } from './fixtures/in-process-router.mjs'

const input = { text: '继续', contexts: [{ id: 'book', title: '书稿', summary: '', entities: [], keywords: [], lastState: '' }] }
async function fixture(fn: (router: CodexRouter, log: () => any[]) => Promise<void>, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-router-'))
  const router = new CodexRouter({ command: process.execPath, args: [resolve('tests/fixtures/router-app-server.mjs')],
    env: { ROUTER_LOG: join(dir, 'log'), ROUTER_MARKER: join(dir, 'marker') }, ...options })
  try { await fn(router, () => readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))) }
  finally { await router.close(); rmSync(dir, { recursive: true, force: true }) }
}
test('Codex router reuses initialization, isolates turns and defaults to Luna low standard', async () => fixture(async (router, log) => {
  assert.deepEqual((await router.models()).map(m => m.model), ['gpt-6-astra', 'gpt-6-luna'])
  const a = await router.decide(input), b = await router.decide({ ...input, text: 'CREATE' })
  assert.equal(a.decision.contextId, 'book'); assert.equal(a.model, 'gpt-6-luna'); assert.ok(a.elapsedMs >= 0)
  assert.equal(b.decision.label, '路由')
  assert.equal(log().filter(m => m.method === 'initialize').length, 1)
  const turns = log().filter(m => m.method === 'turn/start')
  assert.ok(turns.every(m => m.params.effort === 'low' && m.params.serviceTier === 'default'))
  assert.equal(log().filter(m => m.method === 'thread/unsubscribe').length, 2)
}))
for (const [text, code] of [['WAIT', 'ROUTER_TIMEOUT'], ['INVALID_JSON', 'ROUTER_INVALID_JSON'], ['INVALID_ID', 'ROUTER_INVALID_DECISION'], ['TOOL', 'ROUTER_ATTEMPTED_TOOL']]) {
  test(`Codex router reports ${code} and recovers for the next call`, async () => fixture(async router => {
    await assert.rejects(router.decide({ ...input, text }), (e: unknown) => e instanceof RouterFailure && e.code === code)
    assert.equal((await router.decide(input)).decision.contextId, 'book')
  }, { timeoutMs: text === 'WAIT' ? 2500 : 3000 }))
}
test('Codex router reconnects after a dead transport without replaying the failed call', async () => fixture(async (router, log) => {
  await assert.rejects(router.decide({ ...input, text: 'DISCONNECT' }), (e: unknown) => e instanceof RouterFailure && e.code === 'ROUTER_DISCONNECTED')
  assert.equal((await router.decide(input)).decision.contextId, 'book')
  assert.equal(log().filter(m => m.method === 'initialize').length, 2)
}))
test('saved model, effort and Fast are checked and passed independently of defaults', async () => fixture(async (router, log) => {
  for (const [selection, code] of [
    [{ model: 'missing', effort: 'low', fast: false }, 'ROUTER_MODEL_UNAVAILABLE'],
    [{ model: 'gpt-6-luna', effort: 'ultra', fast: false }, 'ROUTER_EFFORT_UNAVAILABLE'],
  ] as const) await assert.rejects(router.decide(input, undefined, undefined, { modelSettings: selection }), (e: unknown) => e instanceof RouterFailure && e.code === code)
  assert.equal(log().filter(m => m.method === 'turn/start').length, 0)
  const result = await router.decide(input, undefined, undefined, { modelSettings: { model: 'gpt-6-astra', effort: 'high', fast: true } })
  assert.equal(result.model, 'gpt-6-astra')
  const turn = log().find(m => m.method === 'turn/start').params
  assert.equal(turn.effort, 'high'); assert.equal(turn.serviceTier, 'priority')
}))
test('no available economical model never selects the global default', () => {
  assert.equal(recommendedRouterModel([{ model: 'gpt-6-astra', displayName: '', description: '', reasoningEfforts: ['low'], defaultEffort: 'low', fastTier: null }]), null)
})

test('in-process JSON-RPC fixture verifies router behavior without requiring child processes', async t => {
  installInProcessRouter(t)
  // Keep a live test handle: the simulated transport has no child process to keep Node alive.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  await t.test('isolated turns reuse one initialization and honor default/custom settings', async () => fixture(async (router, log) => {
    assert.equal((await router.decide(input)).decision.contextId, 'book')
    assert.equal((await router.decide({ ...input, text: 'CREATE' })).decision.label, '路由')
    const chosen = await router.decide(input, undefined, undefined, { modelSettings: { model: 'gpt-6-astra', effort: 'high', fast: true } })
    assert.equal(chosen.model, 'gpt-6-astra')
    assert.equal(log().filter(m => m.method === 'initialize').length, 1)
    assert.deepEqual(log().filter(m => m.method === 'turn/start').map(m => [m.params.effort, m.params.serviceTier]), [['low','default'], ['low','default'], ['high','priority']])
  }))
  for (const [text, code] of [['WAIT','ROUTER_TIMEOUT'], ['INVALID_JSON','ROUTER_INVALID_JSON'], ['INVALID_ID','ROUTER_INVALID_DECISION'], ['TOOL','ROUTER_ATTEMPTED_TOOL'], ['DISCONNECT','ROUTER_DISCONNECTED']]) {
    await t.test(code, async () => fixture(async router => {
      await assert.rejects(router.decide({ ...input, text }), (e: unknown) => e instanceof RouterFailure && e.code === code)
      assert.equal((await router.decide(input)).decision.contextId, 'book')
    }, { timeoutMs: 100 }))
  }
  await t.test('invalid saved model fails before inference, with no replacement', async () => fixture(async (router, log) => {
    await assert.rejects(router.decide(input, undefined, undefined, { modelSettings: { model: 'removed', effort: 'low', fast: false } }),
      (e: unknown) => e instanceof RouterFailure && e.code === 'ROUTER_MODEL_UNAVAILABLE' && e.meta?.attempts?.[0].sent === false)
    assert.equal(log().filter(m => m.method === 'turn/start').length, 0)
  }))
  await t.test('deadline covers initialization and a substituted model is rejected', async () => {
    for (const method of ['initialize', 'model/list', 'config/read']) {
      await fixture(async router => { await assert.rejects(router.decide(input), /ROUTER_TIMEOUT/) }, { timeoutMs: 50, env: { ROUTER_HANG_METHOD: method } })
    }
    await fixture(async router => { await assert.rejects(router.decide(input), /ROUTER_MODEL_MISMATCH/) }, { env: { ROUTER_WRONG_MODEL: '1' } })
  })
  await t.test('cancellation settles and parallel turns never mix their output', async () => fixture(async router => {
    const abort = new AbortController(), pending = router.decide({ ...input, text: 'WAIT' }, abort.signal)
    setTimeout(() => abort.abort(), 10)
    await assert.rejects(pending, /ROUTER_ABORTED/)
    const [a,b] = await Promise.all([router.decide(input), router.decide({ ...input, text: 'CREATE' })])
    assert.equal(a.decision.contextId, 'book'); assert.equal(b.decision.title, '开发路由器')
  }))
})
