import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextStore } from '../src/store.ts'
import { resolveContext } from '../src/router.ts'

test('topics keep their independent state and an explicit reference returns to the original topic', () => {
  const store = new ContextStore(':memory:')
  try {
    const a = store.createTopic('论文', '写毕业论文')
    const b = store.createTopic('露营', '周末露营')
    assert.notEqual(a, b, 'each topic must have an independent identity')
    assert.equal(store.contexts().length, 2)
    const route = resolveContext('继续论文', store.contexts(), b)
    assert.equal(route.contextId, a)
    assert.equal(route.action, 'SWAP')
  } finally { store.close() }
})
