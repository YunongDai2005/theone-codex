import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTopicLabel, bubbleLabel } from '../src/topic-label.ts'
import { ContextStore } from '../src/store.ts'
import { validateRoutingDecision } from '../src/llm-router.ts'
import { validateCatalog } from '../src/history-classification.ts'

test('labels normalize short Chinese and Latin names without truncating invalid metadata', () => {
  for (const [input, expected] of [[' 书稿 ', '书稿'], ['Ｃｏｄｅｘ  Router', 'Codex Router'], ['山由云', '山由云'], ['A', 'A']]) assert.equal(normalizeTopicLabel(input), expected)
  for (const input of [null, 1, '', '中', '一二三四五', 'three long words', 'Codex-6', 'A'.repeat(25), '书\n稿']) assert.equal(normalizeTopicLabel(input), undefined)
})

test('bubble labels prefer stored label, short title, then an entity actually present in title', () => {
  const topic = { title: '旅游', label: '旅行', entities: ['日本'], keywords: [] }
  assert.equal(bubbleLabel(topic), '旅行')
  assert.equal(bubbleLabel({ ...topic, label: undefined }), '旅游')
  assert.equal(bubbleLabel({ ...topic, title: 'Codex Router 开发计划', label: 'invalid long label', entities: ['Router', 'Codex'] }), 'Codex')
  assert.equal(bubbleLabel({ ...topic, title: '完全不同的复杂事情', label: undefined }), null)
})

test('model routing and historical imports persist normalized labels', () => {
  const store = new ContextStore(':memory:')
  try {
    const decision = validateRoutingDecision({ action: 'CREATE', title: '新路由器', label: ' 路由 ', reason: 'new' }, { text: '开发路由', contexts: [] })
    const route = store.plan('a', 'main', 'main', decision)
    assert.equal(store.lookupContext(route.decision.contextId!)?.label, '路由')
    const parts = [{ seq: 1, endSeq: 1, text: '旅行', fingerprint: '1' }]
    const topics = validateCatalog({ topics: [{ contextId: null, title: '日本旅行计划', label: ' 旅行 ', summary: '行程', lastState: '规划', entities: ['日本'], keywords: [], turns: [1], groupId: null, groupTitle: '旅行', groupSummary: '' }] }, parts, [], [])
    store.importTopics('session', undefined, parts, topics)
    assert.equal(store.contexts().find(t => t.title === '日本旅行计划')?.label, '旅行')
  } finally { store.close() }
})
