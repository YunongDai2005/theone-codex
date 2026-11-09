import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopController } from './desktop-controller.mjs'

const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) }
const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n?.children?.map(text).join('') ?? ''

test('routing panel presents receipts, candidate moves, arbitrary destinations, undo and report actions', async () => {
  const mod = await import('./route-panels.mjs').catch(() => ({}))
  assert.equal(typeof mod.RoutePanel, 'function')
  const calls = [], topics = [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }, { id: 'c', title: '丙' }]
  const route = { inputId: 'm', at: 1, excerpt: '<private>', decision: { contextId: 'a', alternateIds: ['b','gone'] }, receipt: { mode: 'rules', errorCode: 'ROUTER_TIMEOUT', elapsedMs: 1250 } }
  const render = row => mod.RoutePanel({ React, routes: [row], topics, move: (...args) => calls.push(args), report: id => calls.push(['report', id]) })
  let tree = render(route)
  assert.match(text(tree), /规则判断/); assert.match(text(tree), /分类出错：ROUTER_TIMEOUT/)
  nodes(tree).find(n => n.type === 'button' && text(n) === '换到 乙').props.onClick()
  nodes(tree).find(n => n.type === 'select').props.onChange({ target: { value: 'c' } })
  nodes(tree).find(n => n.type === 'button' && text(n) === '报告问题').props.onClick()
  tree = render({ ...route, correctedTo: 'b' }); assert.match(text(tree), /已改到 乙/)
  nodes(tree).find(n => n.type === 'button' && text(n) === '撤销').props.onClick()
  assert.deepEqual(calls, [['m','b'],['m','c'],['report','m'],['m',undefined,true]])
  assert.match(text(render({ ...route, decision: { action: 'CLARIFY' } })), /\? 追问/)
  assert.match(text(render({ ...route, decision: { contextId: 'gone' } })), /（已删除的话题）/)
})

test('feedback preview is the copied report; GitHub and email links never carry its contents', async () => {
  const mod = await import('./route-panels.mjs').catch(() => ({})); assert.equal(typeof mod.FeedbackPanel, 'function')
  let copied
  const tree = mod.FeedbackPanel({ React, description: '按钮没反应', change: () => {}, diagnostics: { version: '0.1.0', codexVersion: '1.2.3', routes: [{ source: 'rules', errorCode: null, elapsedMs: 12 }] }, adapterVersion: '0.4.3', copy: report => { copied = report } })
  const all = nodes(tree)
  all.find(n => n.type === 'button' && text(n) === '复制内容').props.onClick()
  assert.equal(copied, text(all.find(n => n.type === 'pre')))
  assert.match(copied, /按钮没反应/); assert.match(copied, /0.4.3/)
  assert.deepEqual(all.filter(n => n.type === 'a').map(n => n.props.href), ['https://github.com/YunongDai2005/theone-codex/issues/new','mailto:theone@yulid.org'])
})

test('route controller passes the public input id and translates 409 without claiming a move succeeded', async () => {
  const calls = [], c = new DesktopController({ load: () => null, current: () => ({}), call: async (name, args) => {
    calls.push({ name, args }); if (name === 'theone_correct_route') throw Object.assign(Error('TOPIC_BUSY'), { statusCode: 409 })
    return { routes: [], stats: { total: 0 } }
  } })
  c.emit({ gateway: { gatewayId: 'main' } })
  assert.equal(typeof c.correctRoute, 'function')
  await c.correctRoute('m', undefined, true)
  assert.deepEqual(calls[0], { name: 'theone_correct_route', args: { gatewayId: 'main', inputId: 'm', undo: true } })
  assert.match(c.state.error, /正在处理|忙/)
})

test('a slow routing poll cannot replace a newer correction receipt', async () => {
  const replies = [], c = new DesktopController({ load: () => null, current: () => ({}), call: () => new Promise(resolve => replies.push(resolve)) })
  c.emit({ gateway: { gatewayId: 'main' } })
  const first = c.recentRoutes(), second = c.recentRoutes()
  replies[1]({ routes: [{ inputId: 'm', correctedTo: 'b' }] }); await second
  replies[0]({ routes: [{ inputId: 'm' }] }); await first
  assert.equal(c.state.routes[0].correctedTo, 'b')
})
