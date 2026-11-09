import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'

async function fixture(fn: (s: TheOneService, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-bubbles-'))
  const s = new TheOneService({ dataDir: dir })
  try { s.desktopBind('p', 'main', dir); s.configure('main', { routerMode: 'rules' }); await fn(s, dir) }
  finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('ordered durable events carry message ids and cursors and do not replay other gateways', () => fixture(async (s, dir) => {
  const initial = s.desktopSnapshot('p')
  assert.ok(initial.cursor)
  const a = await s.route({ gatewayId: 'main', inputId: 'a', text: '新话题：写作' })
  await s.route({ gatewayId: 'main', inputId: 'b', text: '继续写作' })
  s.configure('other', { workspace: dir, routerMode: 'rules' })
  await s.route({ gatewayId: 'other', inputId: 'hidden', text: '继续写作', topicId: a.topicId })
  const next = s.desktopSnapshot('p', initial.cursor)
  assert.equal(next.reset, false)
  const routes = next.events.filter(e => e.type === 'route.assigned')
  assert.equal(routes.length, 2)
  assert.deepEqual(routes.map(e => e.messageIds[0]), ['a','b'])
  assert.ok(routes[1].seq > routes[0].seq)
  assert.equal(s.desktopSnapshot('p', next.cursor).events.length, 0)
  const reopened = new TheOneService({ dataDir: dir })
  try { assert.deepEqual(reopened.desktopSnapshot('p', initial.cursor).events, next.events) } finally { await reopened.close() }
  assert.equal(s.desktopSnapshot('p', { epoch: 'old', seq: 0 }).reset, true)
}))

test('correction refuses busy topics with 409 and emits the corrected message after idle', () => fixture(async s => {
  const a = s.createTopic('写作'), b = s.createTopic('露营')
  const route = await s.route({ gatewayId: 'main', inputId: 'one', text: '修改细节', topicId: a })
  const run = { id: 'busy', gatewayId: 'main', topicId: b, status: 'running', pid: process.pid, updatedAt: Date.now() }
  s.runtime.put('run', 'busy', run)
  assert.throws(() => s.correct('main', 'one', b), (e: any) => e.statusCode === 409)
  s.runtime.put('run', 'busy', { ...run, status: 'completed' })
  const cursor = s.desktopSnapshot('p').cursor
  s.correct('main', 'one', b)
  const event = s.desktopSnapshot('p', cursor).events.find(e => e.type === 'route.moved')
  assert.deepEqual(event && { from: event.fromId, to: event.toId, id: event.messageId }, { from: route.topicId, to: b, id: 'one' })
  assert.equal(s.store.corrections('main')[0].rightId, b)
}))

test('busy merges queue once, can be cancelled, and merge then undo emit durable outcomes', () => fixture(async s => {
  assert.equal(typeof s.requestMerge, 'function')
  const a = s.createTopic('写作'), b = s.createTopic('笔记')
  s.runtime.put('run', 'busy', { id: 'busy', gatewayId: 'main', topicId: a, status: 'running', pid: process.pid })
  const op = s.requestMerge(a, b, 'one')
  assert.equal(op.state, 'queued'); assert.equal(s.requestMerge(a, b, 'one').operationId, op.operationId)
  assert.equal(s.desktopSnapshot('p').pendingMerges[0].operationId, op.operationId)
  assert.equal(s.cancelMerge(op.operationId).state, 'cancelled')
  const second = s.requestMerge(a, b, 'two'), cursor = s.desktopSnapshot('p').cursor
  s.runtime.remove('run', 'busy'); s.drainMerges()
  assert.equal(s.desktopSnapshot('p').pendingMerges.length, 0)
  assert.equal(s.desktopSnapshot('p').mergeReceipts.find(m => m.operationId === second.operationId)?.state, 'succeeded')
  assert.equal(s.listTopics().some(t => t.id === a), false)
  s.unmerge(a)
  assert.equal(s.listTopics().some(t => t.id === a), true)
  assert.ok(s.desktopSnapshot('p', cursor).events.some(e => e.type === 'topic.unmerged'))
}))

test('queued merges expire and invalidated targets fail without changing topic ownership', t => fixture(async s => {
  assert.equal(typeof s.requestMerge, 'function')
  const a = s.createTopic('写作'), b = s.createTopic('笔记')
  s.runtime.put('run', 'busy', { id: 'busy', topicId: a, status: 'running', pid: process.pid })
  const op = s.requestMerge(a, b, 'expire'), now = Date.now(), clock = t.mock.method(Date, 'now', () => now + 600000)
  try { s.drainMerges(); assert.equal(s.desktopSnapshot('p').mergeReceipts.find(m => m.operationId === op.operationId)?.state, 'expired') }
  finally { clock.mock.restore() }
  const fail = s.requestMerge(a, b, 'invalid'); s.manageTopic(b, { excluded: true }); s.runtime.remove('run', 'busy'); s.drainMerges()
  assert.equal(s.desktopSnapshot('p').mergeReceipts.find(m => m.operationId === fail.operationId)?.state, 'failed')
  assert.equal(s.store.merges().length, 0)
}))

test('duplicate suggestions persist, later retains them, decline suppresses repeats and accept uses the selected direction', () => fixture(async (s, dir) => {
  assert.equal(typeof s.detectSuggestions, 'function')
  const a = s.createTopic('日本旅行计划'), b = s.createTopic('日本旅行行程')
  s.detectSuggestions('main')
  const suggestion = s.desktopSnapshot('p').suggestions[0]
  assert.ok(suggestion)
  assert.equal(s.answerSuggestion(suggestion.suggestionId, 'later').outcome, 'done')
  assert.equal(s.desktopSnapshot('p').suggestions.length, 1)
  s.answerSuggestion(suggestion.suggestionId, 'decline'); s.detectSuggestions('main')
  assert.equal(s.desktopSnapshot('p').suggestions.length, 0)
  const c = s.createTopic('小说写作'), d = s.createTopic('小说写作规划')
  s.detectSuggestions('main')
  const accept = s.desktopSnapshot('p').suggestions.find(item => item.pair.includes(c))!
  assert.equal(s.answerSuggestion(accept.suggestionId, 'accept', { sourceId: d, targetId: c }).outcome, 'merged')
  assert.ok(s.store.merges().some(m => m.sourceId === d && m.targetId === c))
  const reopened = new TheOneService({ dataDir: dir })
  try { reopened.detectSuggestions('main'); assert.equal(reopened.desktopSnapshot('p').suggestions.some(item => item.pair.includes(a) && item.pair.includes(b)), false) } finally { await reopened.close() }
}))

test('bounded event history resets stale/future/scope cursors without replaying stale animations', () => fixture(async s => {
  const cursor = s.desktopSnapshot('p').cursor
  for (let i = 0; i < 2050; i++) s.runtime.appendEvent({ type: 'topic.changed', contextId: String(i) }, 'main')
  const reset = s.desktopSnapshot('p', cursor)
  assert.equal(reset.reset, true); assert.deepEqual(reset.events, []); assert.ok(reset.eventFloor > cursor.seq)
  assert.equal(s.desktopSnapshot('p', { ...reset.cursor, seq: reset.cursor.seq + 1 }).reset, true)
  assert.equal(s.desktopSnapshot('p', { ...reset.cursor, gatewayId: 'another' }).reset, true)
  assert.equal(s.desktopSnapshot('p', reset.cursor).reset, false)
}))

test('accepted suggestion retries preserve direction and edits invalidate a queued acceptance', () => fixture(async s => {
  const a = s.createTopic('日本旅行计划'), b = s.createTopic('日本旅行行程')
  s.detectSuggestions('main'); const suggestion = s.desktopSnapshot('p').suggestions[0]
  const direction = suggestion.directions[1]
  s.runtime.put('run', 'busy', { id: 'busy', topicId: a, status: 'running', pid: process.pid })
  const accepted = s.answerSuggestion(suggestion.suggestionId, 'accept', direction)
  assert.equal(accepted.outcome, 'queued')
  assert.equal(s.answerSuggestion(suggestion.suggestionId, 'accept').operation?.operationId, accepted.operation?.operationId)
  s.manageTopic(b, { summary: '这次改成另一次不同的出行' }); s.drainMerges()
  assert.equal(s.desktopSnapshot('p').mergeReceipts.find(op => op.operationId === accepted.operation?.operationId)?.state, 'failed')
  assert.equal(s.store.merges().length, 0)
}))
