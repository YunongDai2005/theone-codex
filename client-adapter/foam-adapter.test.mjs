import test from 'node:test'
import assert from 'node:assert/strict'
import * as adapter from './foam-adapter.mjs'
const { foamModel, foamChanges, foamActions } = adapter

test('DSH cells reflect the latest actual work state, selected topic and completed fold', () => {
  const state = { gateway: { currentTopicId: 'a' }, topics: [{ id: 'a', title: '写作' }, { id: 'b', title: '旅行', done: true }, { id: 'c', title: '审批' }], activity: [
    { id: 'r2', topicId: 'a', status: 'completed', delivered: false, updatedAt: 100 },
    { id: 'r1', topicId: 'a', status: 'completed', delivered: true, updatedAt: 50 }, { id: 'r3', topicId: 'c', status: 'waiting_approval', updatedAt: 100 }] }
  const model = foamModel(state, 100)
  assert.equal(model.topics[0].phase, 'answered'); assert.equal(model.topics[0].current, true)
  assert.equal(model.topics[1].aside, true); assert.equal(model.topics[2].status, 'approval')
  assert.deepEqual(foamChanges(null, state), [])
  assert.deepEqual(foamChanges(state, { ...state, topics: [...state.topics, { id: 'd' }], activity: [{ id: 'r4', topicId: 'b' }, ...state.activity] }), [], 'snapshots alone cannot invent events')
})

test('server event feed retains alternates/messageId, maps steering and clarification, and settles old merge events', () => {
  assert.equal(typeof adapter.foamEventsFrom, 'function')
  const snapshot = { topics: [{ id: 'a' }, { id: 'b' }], activity: [{ id: 'work', source: 'steering' }] }
  const events = adapter.foamEventsFrom([
    { type: 'route.assigned', contextId: 'a', messageIds: ['message'], alternateIds: ['b'], workItemId: 'first' },
    { type: 'route.assigned', contextId: 'a', workItemId: 'work' },
    { type: 'route.blocked', candidateIds: ['a','b'] }, { type: 'route.resolved', contextId: 'b' },
    { type: 'topic.merged', sourceId: 'a', targetId: 'b' }, { type: 'topic.unmerged', sourceId: 'a', targetId: 'b' },
  ], snapshot)
  assert.deepEqual(events, [{ kind: 'route', to: 'a', alternates: ['b'], messageId: 'message' }, { kind: 'supplement', to: 'a' },
    { kind: 'clarify', candidates: ['a','b'] }, { kind: 'resolve', to: 'b' }, { kind: 'unmerged', id: 'a', into: 'b' }])
})

test('queued outcomes play once and old queued receipts cannot overwrite terminal state', () => {
  assert.equal(typeof adapter.mergeOutcomes, 'function')
  const seen = new Map(), op = { operationId: 'op', sourceId: 'a', targetId: 'b' }
  assert.deepEqual(adapter.mergeOutcomes(seen, [{ ...op, state: 'queued' }, { ...op, state: 'succeeded' }]), [{ kind: 'merged', id: 'a', into: 'b', undo: true }])
  assert.deepEqual(adapter.mergeOutcomes(seen, [{ ...op, state: 'queued' }, { ...op, state: 'failed' }]), [])
  const cancelled = { ...op, operationId: 'cancelled' }
  assert.deepEqual(adapter.mergeOutcomes(seen, [{ ...cancelled, state: 'queued' }, { ...cancelled, state: 'cancelled' }]), [{ kind: 'mergeEnded', id: 'a', into: 'b', failed: false }])
  assert.deepEqual(adapter.settleFoamEvents([{ kind: 'merged', id: 'a', into: 'b', undo: true }], { topics: [{ id: 'a' }] }), [])
})

test('fine topic states, asking, one-off, queue reasons and visible suggestions reach the unchanged foam renderer', () => {
  const model = foamModel({ gateway: { currentTopicId: 'other' }, topics: [{ id: 'a' }, { id: 'b' }, { id: 'c', oneOff: true, done: true }],
    clarification: { candidateIds: ['b'] }, activity: [{ id: '1', topicId: 'a', status: 'waiting_approval', waitingKind: 'question', updatedAt: 1 },
      { id: '2', topicId: 'b', status: 'queued', queueReason: 'topic_busy', updatedAt: 1 }],
    pendingMerges: [], suggestions: [{ suggestionId: 'suggest', pair: ['a','b'], directions: [{ sourceId: 'a', targetId: 'b' }], state: 'pending', expiresAt: 1000 }] }, 10)
  assert.equal(model.topics[0].status, 'question'); assert.equal(model.topics[0].asking, true)
  assert.equal(model.topics[1].asking, true); assert.equal(model.topics[1].queueReason, 'topic_busy')
  assert.equal(model.topics[2].oneOff, true); assert.equal(model.topics[2].aside, true)
  assert.equal(model.suggestions[0].id, 'suggest')
})

test('gestures report queued merges, suggestion outcomes and reroute 409 through real transport errors', async () => {
  const calls = [], controller = { state: { gateway: { gatewayId: 'main' }, activity: [] }, action: async fn => fn(), refresh: async () => {} }
  const host = { call: async (tool, args) => { calls.push({ tool, args }); if (tool === 'theone_correct_route') throw Object.assign(Error('TOPIC_BUSY'), { statusCode: 409 }); if (tool === 'theone_answer_suggestion') return { outcome: 'queued' }; return { state: 'queued' } } }
  const actions = foamActions(controller, host, () => {}, key => key)
  assert.equal(await actions.merge('a','b'), 'queued')
  assert.equal(await actions.answerSuggestion('suggest','accept',{ sourceId:'a',targetId:'b' }), 'queued')
  assert.equal(await actions.reroute('message','b'), 409)
  assert.deepEqual(calls.at(-1).args, { gatewayId: 'main', inputId: 'message', topicId: 'b' })
})

test('cell gestures use real topic operations and report a refused merge without faking success', async () => {
  const requests = [], controller = { state: { activity: [{ id: 'run', topicId: 'a', status: 'running' }] }, action: async op => { try { return await op() } catch { return null } }, refresh: async () => {}, selectTopic: id => requests.push(['select', id]) }
  const host = { call: async (name, args) => { requests.push([name,args]); if (name === 'theone_merge_topics') throw Error('TOPIC_BUSY') } }
  const actions = foamActions(controller, host, () => {}, key => key)
  actions.mount('a'); assert.equal(requests[0][0], 'select')
  assert.equal(await actions.merge('a', 'b'), 'failed')
  assert.equal(await actions.putAside('a'), true)
  assert.equal(requests.at(-1)[1].done, true)
  assert.ok(!requests.some(([name]) => /dispatch|respond/.test(name)))
})
