import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from '../src/service.ts'

async function fixture(fn: (service: TheOneService, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'theone-desktop-'))
  const service = new TheOneService({ dataDir: dir })
  try { await fn(service, dir) } finally { await service.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('desktop main binding survives service restart and never replaces another main implicitly', () => fixture(async (s, dir) => {
  assert.equal(s.desktopSnapshot('account-local').gateway, null)
  s.desktopBind('account-local', 'native-main', dir)
  s.configure('native-main', { sandbox: 'workspace-write' })
  s.desktopBind('account-local', 'native-main', dir)
  assert.equal(s.settings('native-main').sandbox, 'workspace-write')
  assert.throws(() => s.desktopBind('account-local', 'another-chat', dir), /ALREADY_BOUND/)
  const reopened = new TheOneService({ dataDir: dir })
  try {
    assert.equal(reopened.desktopSnapshot('account-local').gateway?.gatewayId, 'native-main')
    assert.equal(reopened.desktopSnapshot('another-account').gateway, null)
    assert.equal(reopened.status().runs.length, 0)
  } finally { await reopened.close() }
}))

test('topic selection changes the next short continuation without sending a message or starting work', () => fixture(async (s, dir) => {
  s.desktopBind('profile', 'main', dir)
  const a = s.createTopic('论文'), b = s.createTopic('露营')
  s.selectTopic('main', a)
  assert.equal(s.desktopSnapshot('profile').gateway?.currentTopicId, a)
  s.selectTopic('main', b)
  const routed = await s.route({ gatewayId: 'main', inputId: 'follow-up', text: '继续' })
  assert.equal(routed.topicId, b)
  assert.equal(s.status().runs.length, 0)
  s.selectTopic('main', null)
  assert.equal(s.desktopSnapshot('profile').gateway?.currentTopicId, null)
}))

test('desktop metadata never contains worker output, history or approval payloads', () => fixture(async (s, dir) => {
  s.desktopBind('profile', 'main', dir)
  const topicId = s.createTopic('产品')
  s.runtime.put('run', 'run-1', { id: 'run-1', gatewayId: 'main', topicId, status: 'completed', updatedAt: 42,
    output: [{ text: 'PRIVATE_OUTPUT_SENTINEL' }], text: 'PRIVATE_INPUT_SENTINEL', approvals: [{ command: 'PRIVATE_COMMAND_SENTINEL' }], delivered: false })
  const snapshot = s.desktopSnapshot('profile')
  assert.equal(snapshot.activity[0].status, 'completed')
  assert.equal(snapshot.activity[0].delivered, false)
  assert.ok(!JSON.stringify(snapshot).includes('SENTINEL'))
}))

test('excluded or missing topics cannot be selected from stale desktop controls', () => fixture(async (s, dir) => {
  s.desktopBind('profile', 'main', dir)
  const id = s.createTopic('隐藏')
  s.manageTopic(id, { excluded: true })
  assert.throws(() => s.selectTopic('main', id), /EXCLUDED/)
  assert.throws(() => s.selectTopic('main', 'missing'), /NOT_FOUND/)
  assert.equal(s.desktopSnapshot('profile').topics.length, 0)
}))

test('a topic chosen before the first send is mounted in the same desktop binding request', () => fixture(async (s, dir) => {
  const id = s.createTopic('写作')
  const snapshot = s.desktopBind('first-send', 'native-main', dir, id)
  assert.equal(snapshot.gateway?.currentTopicId, id)
  assert.equal(s.status().runs.length, 0)
  const routed = await s.route({ gatewayId: 'native-main', inputId: '1', text: '继续' })
  assert.equal(routed.topicId, id)
}))
