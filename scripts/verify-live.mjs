import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { TheOneService } from '../dist/service.js'
import { CodexBackend } from '../dist/codex-backend.js'

await mkdir('.theone', { recursive: true })
const dir = await mkdtemp(resolve('.theone/live-smoke-'))
let service = new TheOneService({ dataDir: dir, backend: new CodexBackend() })
const alpha = `ALPHA-${randomUUID().slice(0,8)}`, beta = `BETA-${randomUUID().slice(0,8)}`
const awaitRun = async run => {
  for (let i = 0; i < 12; i++) {
    const result = await service.wait(run.id, 15000)
    if (['completed','failed','interrupted','cancelled','waiting_approval'].includes(result.status)) return result
  }
  await service.cancel(run.id); throw new Error('LIVE_TEST_TIMEOUT')
}
const answer = run => run.output.filter(m => !m.phase || m.phase === 'final_answer').map(m => m.text).join('\n')
let report
try {
  service.configure('live-smoke', { workspace: dir, sandbox: 'read-only', effort: 'low' })
  const a = service.createTopic('移植验收 A'), b = service.createTopic('移植验收 B')
  const one = await awaitRun(await service.dispatch({ gatewayId: 'live-smoke', inputId: 'a1', topicId: a, text: `这是无副作用的插件验收。此话题的测试代号是 ${alpha}。仅回复该代号，不调用工具、不读取文件。` }))
  console.log(JSON.stringify({ step: 'A', status: one.status, outputPresent: !!answer(one), error: one.error }))
  assert.equal(one.status, 'completed'); assert.ok(answer(one).includes(alpha))
  const two = await awaitRun(await service.dispatch({ gatewayId: 'live-smoke', inputId: 'b1', topicId: b, text: `这是无副作用的插件验收。此话题的测试代号是 ${beta}。仅回复该代号，不调用工具、不读取文件。` }))
  console.log(JSON.stringify({ step: 'B', status: two.status, outputPresent: !!answer(two), error: two.error }))
  assert.equal(two.status, 'completed'); assert.ok(answer(two).includes(beta)); assert.notEqual(one.threadId, two.threadId)
  await service.close()
  service = new TheOneService({ dataDir: dir, backend: new CodexBackend() })
  assert.equal(service.run(one.id).status, 'completed')
  const resumed = await awaitRun(await service.dispatch({ gatewayId: 'live-smoke', inputId: 'a2', topicId: a, text: '回到本话题。只回复之前记住的测试代号，不调用任何工具。' }))
  console.log(JSON.stringify({ step: 'A-resumed', status: resumed.status, error: resumed.error }))
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.threadId, one.threadId); assert.ok(answer(resumed).includes(alpha)); assert.ok(!answer(resumed).includes(beta))
  report = { at: new Date().toISOString(), liveCodex: true, syntheticDataOnly: true, sandbox: 'read-only', passed: true,
    threads: { a: one.threadId, b: two.threadId }, turns: [one.turnId, two.turnId, resumed.turnId], separateThreads: true, resumedSameThread: true, correctTopicRecall: true, resumedAfterProcessRestart: true }
} catch (error) { report = { at: new Date().toISOString(), liveCodex: true, passed: false, error: error.message }; throw error }
finally { await writeFile('evidence/live-codex-validation.json', JSON.stringify(report, null, 2) + '\n'); await service.close() }
console.log(JSON.stringify(report, null, 2))
