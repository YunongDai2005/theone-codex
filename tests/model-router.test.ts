import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpRouter } from '../src/http-router.ts'
import { TheOneService } from '../src/service.ts'

test('model routing validates candidates and falls back explicitly on malformed results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-router-'))
  let body: any, response: unknown, calls = 0
  const server = createServer(async (req, res) => { let text = ''; for await (const chunk of req) text += chunk; body = JSON.parse(text); calls++; res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }], model: 'fixture' })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`
  const s = new TheOneService({ dataDir: dir, router: new HttpRouter({ endpoint, model: 'fixture' }) })
  try {
    s.configure('main', { workspace: dir, routerMode: 'model' })
    const topic = s.createTopic('书稿')
    response = { action: 'EXISTING', contextId: topic, reason: 'same writing project' }
    const routed = await s.route({ gatewayId: 'main', inputId: '1', text: '继续改那本书的开头' })
    assert.equal(routed.topicId, topic, JSON.stringify(routed)); assert.equal(calls, 1)
    assert.equal(body.tools, undefined)
    await s.route({ gatewayId: 'main', inputId: '1', text: '继续改那本书的开头' })
    assert.equal(calls, 1)
    response = { action: 'EXISTING', contextId: 'invented', reason: 'bad' }
    const bad = await s.route({ gatewayId: 'main', inputId: '2', text: '昨天另外那件事呢' })
    assert.notEqual(bad.topicId, 'invented')
    assert.match(bad.routingError!, /ROUTER_INVALID_DECISION/)
    assert.equal(bad.receipt.source, 'fallback'); assert.equal(bad.receipt.model, 'fixture')
    assert.equal(routed.receipt.source, 'http')
  } finally { await s.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); rmSync(dir, { recursive: true, force: true }) }
})

test('simultaneous identical model inputs share one in-flight route; conflicting text is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-route-dedupe-'))
  let calls = 0
  const s = new TheOneService({ dataDir: dir, router: { decide: async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { decision: { action: 'CREATE', title: '同一话题', reason: 'fixture' }, model: 'fixture', elapsedMs: 30 } } } })
  try {
    s.configure('main', { workspace: dir, routerMode: 'model' })
    const input = { gatewayId: 'main', inputId: 'a', text: '独立任务' }
    const pending = s.route(input)
    await assert.rejects(s.route({ ...input, text: 'different' }), /INPUT_CONFLICT/)
    const [a,b] = await Promise.all([pending, s.route(input)])
    // One shared quick + CREATE recheck sequence, rather than two independent routes.
    assert.equal(a.topicId, b.topicId); assert.equal(calls, 2); assert.equal(s.listTopics().length, 1)
    await s.route(input); assert.equal(calls, 2)
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('a reopened model gateway reports missing router configuration instead of silently pretending to use it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-router-reopen-'))
  const first = new TheOneService({ dataDir: dir, router: { decide: async () => { throw new Error('unused') } } })
  first.configure('main', { workspace: dir, routerMode: 'model' }); await first.close()
  const reopened = new TheOneService({ dataDir: dir })
  try {
    const routed = await reopened.route({ gatewayId: 'main', inputId: '1', text: '研究行程' })
    assert.equal(routed.routingError, 'MODEL_ROUTER_NOT_CONFIGURED')
  } finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }) }
})
