import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ContextStore } from '../../src/store.ts'

const topic = (id: string, title: string, entities: string[]) => ({ id, title, summary: `${title} 摘要`, entities, keywords: [title], lastState: '待续' })
const evidence = (quote: string) => ({ sessionId: 'w', seq: 1, speaker: 'user' as const, quote })

test('a merge can be taken apart: the source comes back as it was, and what it brought leaves the target', () => {
  const s = new ContextStore(':memory:')
  try {
    s.seed([topic('rent', '房租', ['押金', '房东']), topic('move', '搬家', ['搬家公司']), topic('jobs', '找工作', [])])
    s.moveTopic('rent', { title: '生活' })
    s.applyCard('rent', { summary: '押金和房租', aliases: ['押金那件事'], entities: [], settled: ['押金：3000'], open: ['退押金'] }, 1000)
    s.applyCard('move', { summary: '搬家安排', aliases: ['搬家那个'], entities: [], settled: ['日期：周六'], open: [] }, 1000)
    s.setConstraints('rent', '押金金额保密'); s.setConstraints('move', '只找周末')
    s.startTopicRun('m-rent', 'rent', 'w-rent', 100)
    s.setManualLink('rent', 'jobs', 1)
    const deposit = s.recordFact('rent', { label: '押金', kind: 'fact', value: '3000', status: 'confirmed', evidence: evidence('押金 3000'), origin: 'worker' }).fact!
    const before = { rent: s.contexts().find(c => c.id === 'rent')!, names: s.names('rent').get('rent'), settled: s.settled('rent'), open: s.openItems('rent') }

    s.mergeTopics('rent', 'move', 2000)
    assert.ok(!s.contexts().some(c => c.id === 'rent'))
    assert.ok(s.contexts().find(c => c.id === 'move')!.entities.includes('押金'))
    assert.ok(s.names('move').get('move')!.includes('押金那件事'))
    assert.equal(s.topicRun('m-rent')?.contextId, 'move')
    assert.equal(s.facts('move').some(f => f.id === deposit.id), true)
    assert.deepEqual(s.merges().map(m => ({ sourceId: m.sourceId, targetId: m.targetId, title: m.title })), [{ sourceId: 'rent', targetId: 'move', title: '房租' }])
    // The target goes on working after the merge.
    s.startTopicRun('m-after', 'move', 'w-move', 3000)
    s.addKeywords('move', ['纸箱'])

    assert.equal(s.unmergeTopic('rent'), 'move')
    const rent = s.contexts().find(c => c.id === 'rent')!
    assert.deepEqual(rent, before.rent)
    assert.deepEqual(s.names('rent').get('rent'), before.names)
    assert.deepEqual(s.settled('rent'), before.settled)
    assert.deepEqual(s.openItems('rent'), before.open)
    assert.equal(s.constraints('rent')?.text, '押金金额保密')
    assert.equal(s.groups().find(g => g.contextIds.includes('rent'))?.title, '生活')
    assert.equal(s.topicRun('m-rent')?.contextId, 'rent')
    assert.equal(s.facts('rent').find(f => f.id === deposit.id)?.value, '3000')
    assert.ok(s.links('rent').some(link => (link.a === 'jobs' || link.b === 'jobs') && link.manual === 1))
    // What the source brought leaves the target; what the target did since stays.
    const move = s.contexts().find(c => c.id === 'move')!
    assert.ok(!move.entities.includes('押金') && move.keywords.includes('纸箱'))
    assert.ok(!s.names('move').get('move')!.includes('押金那件事'))
    assert.equal(s.constraints('move')?.text, '只找周末')
    assert.equal(s.facts('move').some(f => f.id === deposit.id), false)
    assert.equal(s.topicRun('m-after')?.contextId, 'move')
    assert.ok(!s.links('move').some(link => link.a === 'jobs' || link.b === 'jobs'))
    assert.deepEqual(s.merges(), [])
    assert.throws(() => s.unmergeTopic('rent'))
  } finally { s.close() }
})

test('a merge into a topic that is later deleted can no longer be taken apart', () => {
  const s = new ContextStore(':memory:')
  try {
    s.seed([topic('a', '甲', []), topic('b', '乙', [])])
    s.mergeTopics('a', 'b')
    s.deleteTopic('b')
    assert.deepEqual(s.merges(), [])
    assert.throws(() => s.unmergeTopic('a'))
  } finally { s.close() }
})
