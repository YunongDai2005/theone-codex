import test from 'node:test'
import assert from 'node:assert/strict'

const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }) }
const flatten = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(flatten)]
test('the shared model picker preserves model, effort and fast interactions for either purpose', async () => {
  const mod = await import('./model-picker.mjs').catch(() => ({}))
  assert.equal(typeof mod.ModelPicker, 'function')
  for (const label of ['整理模型','路由模型']) {
    const changes = [], tree = mod.ModelPicker({ React, label, options: { models: [{ model: 'luna', displayName: 'Luna', reasoningEfforts: ['low','medium'], fastTier: 'priority' }] },
      selection: { model: 'luna', effort: 'low', fast: false }, select: change => changes.push(change) })
    const nodes = flatten(tree), model = nodes.find(n => n.props['aria-label'] === label), effort = nodes.find(n => n.props['aria-label'] === '思考强度'), fast = nodes.find(n => n.props['aria-label'] === '快速模式')
    model.props.onChange({ target: { value: 'luna' } }); effort.props.onChange({ target: { value: 'medium' } }); fast.props.onClick()
    assert.deepEqual(changes, [{ model: 'luna' }, { effort: 'medium' }, { fast: true }])
    assert.equal(fast.props['aria-pressed'], false)
  }
})

test('the shared picker disables unavailable Fast and saving an unsupported model selection', async () => {
  const mod = await import('./model-picker.mjs').catch(() => ({}))
  assert.equal(typeof mod.ModelPicker, 'function')
  const options = { models: [{ model: 'basic', displayName: 'Basic', reasoningEfforts: ['low'] }] }, selection = { model: 'basic', effort: 'low', fast: true }
  const tree = mod.ModelPicker({ React, label: '路由模型', options, selection, select: () => {} })
  assert.equal(flatten(tree).find(n => n.props['aria-label'] === '快速模式').props.disabled, true)
  assert.equal(mod.modelSelectionValid(options, selection), false)
})
