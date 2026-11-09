import test from 'node:test'
import assert from 'node:assert/strict'
import { foamModel, foamChanges, foamActions } from './foam-adapter.mjs'

test('DSH cells reflect the latest actual work state, selected topic and completed fold', () => {
  const state = { gateway: { currentTopicId: 'a' }, topics: [{ id: 'a', title: '写作' }, { id: 'b', title: '旅行', done: true }, { id: 'c', title: '审批' }], activity: [
    { id: 'r2', topicId: 'a', status: 'completed', delivered: false, updatedAt: 100 },
    { id: 'r1', topicId: 'a', status: 'running', updatedAt: 50 }, { id: 'r3', topicId: 'c', status: 'waiting_approval', updatedAt: 100 }] }
  const model = foamModel(state, 100)
  assert.equal(model.topics[0].phase, 'answered'); assert.equal(model.topics[0].current, true)
  assert.equal(model.topics[1].aside, true); assert.equal(model.topics[2].status, 'approval')
  assert.deepEqual(foamChanges(null, state), [])
  assert.deepEqual(foamChanges(state, { ...state, topics: [...state.topics, { id: 'd' }], activity: [{ id: 'r4', topicId: 'b' }, ...state.activity] }), [{ kind: 'create', to: 'd' }, { kind: 'route', to: 'b' }])
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
