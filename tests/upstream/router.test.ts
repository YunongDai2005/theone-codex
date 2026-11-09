import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveContext } from '../../src/router.ts'
import { ContextStore } from '../../src/store.ts'

const contexts = JSON.parse(readFileSync(new URL('../../fixtures/contexts.json', import.meta.url), 'utf8'))
const cases = [
  ['Qwen 后来怎么解决的？', undefined, 'MOUNT', 'ctx_qwen_9070xt'],
  ['那 Q8 为什么慢？', 'ctx_qwen_9070xt', 'KEEP', 'ctx_qwen_9070xt'],
  ['继续', 'ctx_thesis', 'KEEP', 'ctx_thesis'],
  ['不是这个，是论文那个', 'ctx_qwen_9070xt', 'SWAP', 'ctx_thesis'],
  ['不是 Qwen，是论文那个', 'ctx_qwen_9070xt', 'SWAP', 'ctx_thesis'],
  ['Qwen 跟论文结合一下', 'ctx_qwen_9070xt', 'KEEP', 'ctx_qwen_9070xt'],
  ['这个跟论文结合一下', 'ctx_qwen_9070xt', 'KEEP', 'ctx_qwen_9070xt'],
  ['论文跟 Qwen 结合一下', undefined, 'MOUNT', 'ctx_thesis'],
  ['继续昨天那个', 'ctx_thesis', 'CLARIFY', undefined],
  ['不是这个，是另一个模型', 'ctx_qwen_9070xt', 'CLARIFY', undefined],
  ['我想开始学日语', undefined, 'CREATE', undefined],
  ['新话题：学日语', 'ctx_thesis', 'CREATE', undefined],
  ['新话题：Qwen 的新部署实验', 'ctx_qwen_9070xt', 'CREATE', undefined],
  ['那个模型不行', undefined, 'CLARIFY', undefined],
] as const
for (const [input, current, action, contextId] of cases) {
  test(`router: ${input}`, () => {
    const result = resolveContext(input, contexts, current)
    assert.equal(result.action, action)
    assert.equal(result.contextId, contextId)
  })
}

test('combining topics works in one and brings the other along instead of asking which', () => {
  assert.deepEqual(resolveContext('这个跟论文结合一下', contexts, 'ctx_qwen_9070xt').relatedIds, ['ctx_thesis'])
  assert.deepEqual(resolveContext('论文跟 Qwen 结合一下', contexts).relatedIds, ['ctx_qwen_9070xt'])
})

test('CREATE planning is atomic and idempotent; interrupted execution cannot repeat', () => {
  const store = new ContextStore(':memory:')
  try {
    const proposal = resolveContext('新话题：学日语', [])
    const first = store.plan('message-1', 'gateway-1', 'default', proposal)
    assert.deepEqual(store.plan('message-1', 'gateway-1', 'default', proposal), first)
    assert.equal(store.contexts().length, 1)
    store.claim('message-1')
    assert.throws(() => store.claim('message-1'), /already started/)
    assert.equal(store.current('default'), first.decision.contextId)
  } finally { store.close() }
})

const regressionCases = [
  ['不是 Q8 的问题，是 Qwen 的配置', 'ctx_qwen_9070xt', 'KEEP', 'ctx_qwen_9070xt'],
  ['不要 Qwen', 'ctx_thesis', 'CLARIFY', undefined],
  ['先不管 Qwen，先把论文改好', 'ctx_qwen_9070xt', 'SWAP', 'ctx_thesis'],
  ['检查论文，然后继续配置 Qwen', 'ctx_thesis', 'SWAP', 'ctx_qwen_9070xt'],
  ['还有你说的那个方案，具体怎么做', 'ctx_thesis', 'KEEP', 'ctx_thesis'],
  ['合成一个 MD 然后归档', 'ctx_thesis', 'KEEP', 'ctx_thesis'],
  ['我想了解摄影', 'ctx_thesis', 'CREATE', undefined],
  ['回到上周那个，继续', 'ctx_thesis', 'CLARIFY', undefined],
] as const
for (const [text, current, action, contextId] of regressionCases) {
  test(`routing regression: ${text}`, () => {
    const result = resolveContext(text, contexts, current)
    assert.equal(result.action, action)
    assert.equal(result.contextId, contextId)
  })
}

test('clarification examples come from the supplied catalog', () => {
  const result = resolveContext('之前那个', [{ id: 'gardening', title: '种花', summary: '阳台种花', entities: ['月季'], keywords: [], lastState: '育苗' }])
  assert.match(result.question!, /月季/)
  assert.doesNotMatch(result.question!, /Qwen|论文/)
})

test('a generic keyword alone starts a standalone topic instead of forcing a switch', () => {
  const catalog = [
    { id: 'host', title: '家庭主机', summary: '维护电脑', entities: ['AI Box'], keywords: ['硬盘'], lastState: '配置' },
    { id: 'tools', title: '工具', summary: '插件', entities: ['Harness'], keywords: ['浏览器'], lastState: '配置' },
  ]
  assert.equal(resolveContext('有没有给 AI 做的浏览器', catalog, 'host').action, 'CREATE')
  assert.equal(resolveContext('回到浏览器那个', catalog, 'host').contextId, 'tools')
  assert.equal(resolveContext('Harness 的浏览器', catalog, 'host').contextId, 'tools')
  assert.equal(resolveContext('浏览器那个', catalog).contextId, 'tools')
})
