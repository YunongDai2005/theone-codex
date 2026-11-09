import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'

async function fixture(fn: (s: TheOneService, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-theone-'))
  const s = new TheOneService({ dataDir: dir })
  try { s.configure('main', { workspace: dir }); await fn(s, dir) }
  finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('routing persists topics and duplicate inputs cannot silently change text or gateway', async () => fixture(async s => {
  const a = await s.route({ gatewayId: 'main', inputId: '1', text: '新话题：论文' })
  const again = await s.route({ gatewayId: 'main', inputId: '1', text: '新话题：论文' })
  assert.equal(again.topicId, a.topicId)
  await assert.rejects(s.route({ gatewayId: 'main', inputId: '1', text: '删除文件' }), /INPUT_CONFLICT/)
  const b = await s.route({ gatewayId: 'main', inputId: '2', text: '新话题：露营' })
  const back = await s.route({ gatewayId: 'main', inputId: '3', text: '继续论文' })
  assert.equal(back.topicId, a.topicId)
  assert.notEqual(a.topicId, b.topicId)
  assert.equal(s.listTopics().length, 2)
}))

test('private topics do not leak through another topic search or briefing', async () => fixture(async s => {
  const a = await s.route({ gatewayId: 'main', inputId: '1', text: '新话题：私人预算 98765' })
  const b = await s.route({ gatewayId: 'main', inputId: '2', text: '新话题：旅行' })
  s.manageTopic(a.topicId!, { private: true })
  assert.equal(s.search('98765', b.topicId).length, 0)
  assert.equal(s.search('98765', a.topicId).length, 1)
  assert.ok(!s.briefing(b.topicId!).includes('98765'))
}))

test('merge undo restores the source and its searchable messages', async () => fixture(async s => {
  const a = await s.route({ gatewayId: 'main', inputId: '1', text: '新话题：甲项目' })
  const b = await s.route({ gatewayId: 'main', inputId: '2', text: '新话题：乙项目' })
  s.merge(a.topicId!, b.topicId!)
  assert.equal(s.listTopics().length, 1)
  assert.equal(s.search('甲项目', b.topicId).length, 1)
  s.unmerge(a.topicId!)
  assert.equal(s.listTopics().length, 2)
  assert.equal(s.readTopic(a.topicId!).messages.length, 1)
}))

test('a fact cannot become confirmed through an invented quote', async () => fixture(async s => {
  const a = await s.route({ gatewayId: 'main', inputId: '1', text: '新话题：预算定为 2000 元' })
  const real = s.recordFact(a.topicId!, { label: '预算', value: '2000 元', quote: '预算定为 2000 元' })
  assert.equal(real.fact?.status, 'confirmed')
  const invented = s.recordFact(a.topicId!, { label: '人数', value: '8 人', quote: '一共 8 人' })
  assert.equal(invented.fact?.status, 'proposed')
}))

test('history import requires consent and is idempotent; export survives a reopen', async () => fixture(async (s, dir) => {
  const payload = { version: 1, topics: [{ id: 'old', title: '旧话题', messages: [{ id: 'm1', role: 'user', text: '远行记录' }] }] }
  assert.throws(() => s.importHistory(payload, false), /CONSENT/)
  s.importHistory(payload, true)
  s.importHistory(payload, true)
  assert.equal(s.search('远行记录').length, 1)
  const another = new TheOneService({ dataDir: dir })
  try { assert.equal(another.exportHistory().topics.length, 1) } finally { await another.close() }
  assert.match(s.briefing(s.listTopics()[0].id), /远行记录/)
}))

test('unconfigured and out-of-scope workspaces cannot execute', async () => fixture(async (s, dir) => {
  await assert.rejects(s.dispatch({ gatewayId: 'unknown', inputId: '1', text: 'hi' }), /GATEWAY/)
  await assert.rejects(s.dispatch({ gatewayId: 'main', inputId: '1', text: 'hi', cwd: tmpdir() }), /WORKSPACE/)
  assert.equal(s.settings('main').workspace, dir)
}))

test('merging a private source keeps its contents private after the merge', async () => fixture(async s => {
  const a = await s.route({ gatewayId: 'main', inputId: 'a', text: '新话题：secret-123' })
  const b = await s.route({ gatewayId: 'main', inputId: 'b', text: '新话题：公开' })
  const c = await s.route({ gatewayId: 'main', inputId: 'c', text: '新话题：其他' })
  s.manageTopic(a.topicId!, { private: true }); s.merge(a.topicId!, b.topicId!)
  assert.equal(s.search('secret-123', c.topicId).length, 0)
  s.unmerge(a.topicId!)
  assert.equal(s.store.isPrivate(a.topicId!), true)
}))

test('excluded topics remain exportable for backup while being absent from routing/search', async () => fixture(async s => {
  const a = await s.route({ gatewayId: 'main', inputId: 'a', text: '新话题：excluded-123' })
  s.manageTopic(a.topicId!, { excluded: true })
  assert.equal(s.search('excluded-123').length, 0)
  assert.equal(s.exportHistory().topics.length, 1)
}))

test('a conflicting import is rejected before any new topic from that payload is written', async () => fixture(async s => {
  s.importHistory({ version: 1, topics: [{ id: 'known', title: '已有', messages: [{ id: '1', role: 'user', text: 'original' }] }] }, true)
  assert.throws(() => s.importHistory({ version: 1, topics: [
    { id: 'new', title: '新增', messages: [] },
    { id: 'known', title: '已有', messages: [{ id: '1', role: 'user', text: 'changed' }] },
  ] }, true), /CONFLICT/)
  assert.equal(s.listTopics().length, 1)
}))
