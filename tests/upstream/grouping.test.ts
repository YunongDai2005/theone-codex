import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextStore } from '../../src/store.ts'

const topic = (id: string, title: string) => ({ id, title, summary: title, entities: [], keywords: [], lastState: '' })
const groupOf = (store: ContextStore, id: string) => store.groups().find(group => group.contextIds.includes(id))?.title

test('a new topic files itself with a topic it draws on, else with its project folder; otherwise it stays unfiled', () => {
  const store = new ContextStore(':memory:')
  try {
    store.seed([topic('thesis', '开题报告'), topic('app', '发票导出'), topic('dinner', '晚饭')])
    store.moveTopic('thesis', { title: '论文' })
    store.moveTopic('app', { title: '发票项目' })
    // Draws on the thesis topic: joins its workspace.
    const drawn = store.plan('m1', 'chat', 'default', { action: 'CREATE', title: '文献综述', reason: 'x', relatedIds: ['dinner', 'thesis'] })
    assert.equal(groupOf(store, drawn.decision.contextId!), '论文')
    // Works in the same project folder as the invoice topic: joins that workspace.
    store.plan('m0', 'chat', 'default', { action: 'CREATE', title: '发票 PDF', reason: 'x', folder: '/work/invoice' })
    const first = store.contexts().find(context => context.title === '发票 PDF')!
    store.moveTopic(first.id, { title: '发票项目' })
    const sameFolder = store.plan('m2', 'chat', 'default', { action: 'CREATE', title: '发票邮件', reason: 'x', folder: '/work/invoice' })
    assert.equal(groupOf(store, sameFolder.decision.contextId!), '发票项目')
    // Nothing to go by: left for the user, never guessed.
    const alone = store.plan('m3', 'chat', 'default', { action: 'CREATE', title: '周末爬山', reason: 'x' })
    assert.equal(groupOf(store, alone.decision.contextId!), undefined)
    // Filing is only a placement: the user can move it out again.
    store.moveTopic(drawn.decision.contextId!, null)
    assert.equal(groupOf(store, drawn.decision.contextId!), undefined)
  } finally { store.close() }
})
