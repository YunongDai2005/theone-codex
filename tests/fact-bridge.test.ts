import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'

test('fact lookup respects sharing, and retraction needs actual saved withdrawal evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-facts-')), s = new TheOneService({ dataDir: dir })
  try {
    s.configure('main', { workspace: dir })
    const a = await s.route({ gatewayId: 'main', inputId: 'a', text: '新话题：预算定为 2000 元' })
    const b = s.createTopic('旅行计划')
    const result = s.recordFact(a.topicId!, { label: '预算', value: '2000 元', quote: '预算定为 2000 元' })
    assert.equal(s.lookupFacts('预算', b).length, 1)
    assert.throws(() => s.retractFact(a.topicId!, result.fact!.id, '撤回预算'), /EVIDENCE/)
    s.manageTopic(a.topicId!, { excluded: true })
    assert.equal(s.lookupFacts('预算', b).length, 0)
    s.manageTopic(a.topicId!, { excluded: false, private: true })
    assert.equal(s.lookupFacts('预算', b).length, 0)
    await s.route({ gatewayId: 'main', inputId: 'withdraw', topicId: a.topicId!, text: '撤回预算，重新讨论' })
    assert.equal(s.retractFact(a.topicId!, result.fact!.id, '撤回预算').outcome, 'retracted')
    assert.match(s.briefing(a.topicId!), /retracted/)
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
})
