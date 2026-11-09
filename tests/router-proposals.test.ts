import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'
import { RouterFailure, type RoutingRouter } from '../src/llm-router.ts'

async function fixture(fn: (s: TheOneService, calls: string[], dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-proposal-')), calls: string[] = []
  const router: RoutingRouter = { decide: async input => {
    calls.push(input.text)
    if (input.text === 'FAIL') throw new RouterFailure('ROUTER_TIMEOUT')
    return { decision: { action: 'MOUNT', contextId: input.contexts[0].id, reason: 'model-choice' }, model: 'fixture-model', elapsedMs: 2 }
  } }
  const s = new TheOneService({ dataDir: dir, router, backend: {
    execute: async () => ({ status: 'completed' }), respond: async () => {}, close: async () => {},
  } })
  try { s.configure('main', { workspace: dir }); await fn(s, calls, dir) }
  finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('only new gateways default to auto; stored rules survives configure and reopen', async () => fixture(async (s, _, dir) => {
  assert.equal(s.settings('main').routerMode, 'auto')
  s.configure('main', { routerMode: 'rules' })
  s.configure('main', { enabled: true })
  const reopened = new TheOneService({ dataDir: dir })
  try { assert.equal(reopened.settings('main').routerMode, 'rules') } finally { await reopened.close() }
}))

test('high proposal uses its topic without inference and persists its receipt', async () => fixture(async (s, calls) => {
  const id = s.createTopic('书稿')
  const result = await s.dispatch({ gatewayId: 'main', inputId: '1', text: '接着做', proposal: { topicId: id, confidence: 'high' } })
  assert.equal(result.topicId, id); assert.equal(result.receipt.source, 'proposal'); assert.deepEqual(calls, [])
  assert.equal(result.receipt.model, undefined); assert.ok(result.receipt.elapsedMs! >= 0)
  assert.equal(s.store.routeReceipt((result as any).id)?.source, 'proposal')
}))

test('new proposal normalizes its label and does not create duplicate titles', async () => fixture(async (s, calls) => {
  const a = await s.route({ gatewayId: 'main', inputId: '1', text: '安排一本书', proposal: { newTopic: { title: 'Book project', label: 'Ｂｏｏｋ' }, confidence: 'high' } })
  assert.equal(a.receipt.source, 'proposal'); assert.equal(s.readTopic(a.topicId!).label, 'Book')
  const b = await s.route({ gatewayId: 'main', inputId: '2', text: '调整细节', proposal: { newTopic: { title: ' book PROJECT ', label: 'Book' }, confidence: 'high' } })
  assert.equal(b.topicId, a.topicId); assert.equal(s.listTopics().length, 1)
  assert.equal(b.receipt.source, 'proposal'); assert.deepEqual(calls, [])
}))

for (const reason of ['missing', 'excluded', 'private', 'scope', 'conflict', 'low'] as const) {
  test(`invalid proposal (${reason}) falls through to model`, async () => fixture(async (s, calls) => {
    const current = s.createTopic('书稿'), other = s.createTopic('露营')
    s.selectTopic('main', current)
    if (reason === 'excluded') s.manageTopic(other, { excluded: true })
    if (reason === 'private') s.manageTopic(other, { private: true })
    if (reason === 'scope') s.configure('main', { linkScope: 'off' })
    const result = await s.route({ gatewayId: 'main', inputId: '1', text: reason === 'conflict' ? '继续书稿' : '调整细节',
      proposal: { topicId: reason === 'missing' ? 'missing' : other, confidence: reason === 'low' ? 'low' : 'high' } })
    assert.equal(calls.length, 1); assert.notEqual(result.receipt.source, 'proposal'); assert.equal(result.receipt.model, 'fixture-model')
    if (['excluded','private','scope'].includes(reason)) assert.equal(result.topicId, current)
  }))
}

test('explicit topic wins even over a conflicting proposal; rules mode never invokes model', async () => fixture(async (s, calls) => {
  const a = s.createTopic('书稿'), b = s.createTopic('露营')
  const first = await s.route({ gatewayId: 'main', inputId: '1', text: '继续露营', topicId: a, proposal: { topicId: b, confidence: 'high' } })
  assert.equal(first.topicId, a); assert.equal(first.receipt.source, 'explicit')
  s.configure('main', { routerMode: 'rules' })
  const second = await s.route({ gatewayId: 'main', inputId: '2', text: '继续书稿', proposal: { topicId: b, confidence: 'high' } })
  assert.equal(second.topicId, a); assert.equal(second.receipt.source, 'rules'); assert.deepEqual(calls, [])
}))

test('fallback receipt includes the failure code and elapsed time', async () => fixture(async (s) => {
  s.createTopic('书稿')
  const result = await s.route({ gatewayId: 'main', inputId: '1', text: 'FAIL' })
  assert.equal(result.routingError, 'ROUTER_TIMEOUT'); assert.equal(result.receipt.source, 'fallback')
  assert.equal(result.receipt.errorCode, result.routingError); assert.ok(result.receipt.elapsedMs! >= 0)
}))

test('conflicting new proposals and hidden same-name proposals go through model validation', async () => fixture(async (s, calls) => {
  const current = s.createTopic('书稿'), hidden = s.createTopic('私密预算')
  s.selectTopic('main', current); s.manageTopic(hidden, { private: true })
  const conflict = await s.route({ gatewayId: 'main', inputId: '1', text: '继续书稿', proposal: { newTopic: { title: '新安排', label: '安排' }, confidence: 'high' } })
  assert.equal(conflict.topicId, current); assert.notEqual(conflict.receipt.source, 'proposal')
  const duplicate = await s.route({ gatewayId: 'main', inputId: '2', text: '调整安排', proposal: { newTopic: { title: '私密预算', label: '预算' }, confidence: 'high' } })
  assert.equal(duplicate.topicId, current); assert.equal(calls.length, 2); assert.equal(s.listTopics().length, 2)
}))

test('model mode ignores a high proposal and duplicate delivery cannot reroute it', async () => fixture(async (s, calls) => {
  const a = s.createTopic('书稿'), b = s.createTopic('露营')
  s.configure('main', { routerMode: 'model' })
  const input = { gatewayId: 'main', inputId: '1', text: '安排后续', proposal: { topicId: a, confidence: 'high' as const } }
  const first = await s.route(input)
  assert.notEqual(first.receipt.source, 'proposal'); assert.equal(calls.length, 1)
  const again = await s.route({ ...input, proposal: { topicId: b, confidence: 'high' } })
  assert.equal(again.topicId, first.topicId); assert.equal(calls.length, 1)
}))

test('dispatch catalog is bounded, privacy filtered, versioned and omitted when unchanged', async () => fixture(async (s) => {
  const a = s.createTopic('书稿'), privateId = s.createTopic('私密预算'), excluded = s.createTopic('排除事项')
  s.manageTopic(privateId, { private: true }); s.manageTopic(excluded, { excluded: true })
  const input = { gatewayId: 'main', inputId: '1', text: '继续', topicId: a }
  const first = await s.dispatch(input)
  assert.deepEqual(first.catalog?.map(t => t.id), [a]); assert.equal(first.catalog?.[0].label, '书稿')
  assert.equal(typeof first.catalogVersion, 'string')
  const again = await s.dispatch({ ...input, catalogVersion: first.catalogVersion })
  assert.equal(again.catalog, undefined); assert.equal(again.catalogVersion, first.catalogVersion)
  // A caller that does not pass its version (a new chat, or one that lost the catalog to compaction) gets it again.
  assert.deepEqual((await s.dispatch(input)).catalog?.map(t => t.id), [a])
  s.manageTopic(a, { title: '新版书稿' })
  const changed = await s.dispatch(input)
  assert.notEqual(changed.catalogVersion, first.catalogVersion); assert.equal(changed.catalog?.[0].title, '新版书稿')
  for (let i = 0; i < 90; i++) s.createTopic('项目' + i)
  const bounded = await s.dispatch(input)
  assert.ok(bounded.catalog!.length <= 80); assert.ok(JSON.stringify(bounded.catalog).length <= 12000); assert.equal(bounded.catalogTruncated, true)
}))
