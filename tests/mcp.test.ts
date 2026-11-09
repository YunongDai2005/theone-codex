import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp-server.ts'
import { TheOneService } from '../src/service.ts'

test('MCP route panel supports correction, undo, and content-free feedback diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-ux-mcp-')), service = new TheOneService({ dataDir: dir })
  const server = createMcpServer(service), client = new Client({ name: 'ux-client', version: '1' }), [a,b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    service.configure('main', { workspace: dir })
    const original = service.createTopic('原话题'), target = service.createTopic('新话题')
    await service.route({ gatewayId: 'main', inputId: 'message', text: 'private-message', topicId: original })
    const call = (name: string, args: object) => client.callTool({ name, arguments: args as any })
    const recent = await call('theone_recent_routes', { gatewayId: 'main' })
    assert.equal(recent.isError, undefined)
    assert.equal((recent.structuredContent as any).result.routes[0].inputId, 'message')
    assert.equal((await call('theone_correct_route', { gatewayId: 'main', inputId: 'message', topicId: target })).isError, undefined)
    assert.equal((await call('theone_correct_route', { gatewayId: 'main', inputId: 'message', undo: true })).isError, undefined)
    assert.equal(service.search('private-message')[0].topicId, original)
    const feedback = await call('theone_feedback_diagnostics', { gatewayId: 'main', inputId: 'message' })
    assert.equal(feedback.isError, undefined); assert.doesNotMatch(JSON.stringify(feedback), /private-message|原话题|新话题|theone-ux-mcp/)
  } finally { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('official MCP client can discover, validate and use the topic workflow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-mcp-'))
  const service = new TheOneService({ dataDir: dir })
  const server = createMcpServer(service), client = new Client({ name: 'test-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    const { tools } = await client.listTools()
    assert.ok(tools.some(t => t.name === 'theone_dispatch'))
    for (const name of ['theone_preroute','theone_cancel_merge','theone_answer_suggestion','theone_check_updates']) assert.ok(tools.some(t => t.name === name))
    assert.equal(tools.find(t => t.name === 'theone_dispatch')!.annotations!.readOnlyHint, false)
    const bad = await client.callTool({ name: 'theone_configure', arguments: { gatewayId: 'main', workspace: dir, sandbox: 'danger-full-access' } })
    assert.equal(bad.isError, true)
    await client.callTool({ name: 'theone_configure', arguments: { gatewayId: 'main', workspace: dir } })
    const route = await client.callTool({ name: 'theone_route', arguments: { gatewayId: 'main', inputId: '1', text: '新话题：测试' } })
    assert.equal(route.isError, undefined)
    const listed = await client.callTool({ name: 'theone_list_topics', arguments: {} })
    assert.equal((listed.structuredContent as { result: unknown[] }).result.length, 1)
    const resources = await client.listResources()
    assert.ok(resources.resources.some(r => r.uri === 'theone://status'))
  } finally { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('native MCP exposes cursor feeds, queued merges and structured correction conflicts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-parity-mcp-')), service = new TheOneService({ dataDir: dir })
  const server = createMcpServer(service), client = new Client({ name: 'parity-client', version: '1' }), [a,b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    service.desktopBind('p', 'main', dir); service.configure('main', { routerMode: 'rules' })
    const sourceId = service.createTopic('写作'), targetId = service.createTopic('笔记')
    const invoke = async (name: string, args: object) => client.callTool({ name, arguments: args as any })
    await invoke('theone_preroute', { gatewayId: 'main', inputId: 'input', text: '继续' })
    await invoke('theone_route', { gatewayId: 'main', inputId: 'input', text: '继续', topicId: sourceId })
    service.runtime.put('run', 'busy', { id: 'busy', topicId: sourceId, status: 'running', pid: process.pid })
    const refused = await invoke('theone_correct_route', { gatewayId: 'main', inputId: 'input', topicId: targetId })
    assert.equal(refused.isError, true); assert.equal((refused.structuredContent as any).statusCode, 409)
    const merged = await invoke('theone_merge_topics', { sourceId, targetId, whenIdle: true, requestId: 'merge' })
    assert.equal((merged.structuredContent as any).result.state, 'queued')
    const snapshot = (await invoke('theone_desktop_state', { profileId: 'p' })).structuredContent as any
    assert.equal(snapshot.result.pendingMerges.length, 1)
    const again = await invoke('theone_desktop_state', { profileId: 'p', cursor: snapshot.result.cursor })
    assert.deepEqual((again.structuredContent as any).result.events, [])
    const cancelled = await invoke('theone_cancel_merge', { operationId: (merged.structuredContent as any).result.operationId })
    assert.equal((cancelled.structuredContent as any).result.state, 'cancelled')
  } finally { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('native history controls persist first-use consent and expose manual refresh through MCP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-catalog-mcp-'))
  const service = new TheOneService({ dataDir: dir, catalog: { source: { list: async () => [], read: async () => { throw Error('No content expected') }, close: async () => {} },
    model: { models: async () => [{ model: 'gpt-6-luna', displayName: 'Luna', description: '', reasoningEfforts: ['medium'], defaultEffort: 'medium', fastTier: 'priority' }], classify: async () => { throw Error('No model expected') }, close: async () => {} } } })
  const server = createMcpServer(service), client = new Client({ name: 'history-test', version: '1' })
  const [a,b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    const invoke = async (name: string, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return (result.structuredContent as any).result }
    assert.equal((await invoke('theone_history_status')).consent, 'ask')
    assert.equal((await invoke('theone_history_consent', { consent: false })).consent, 'declined')
    assert.equal((await invoke('theone_history_sessions')).sessions.length, 0)
    const settings = { model: 'gpt-6-luna', effort: 'medium', fast: true }
    assert.equal((await invoke('theone_history_models')).selection.model, 'gpt-6-luna')
    const bad = await client.callTool({ name: 'theone_history_consent', arguments: { consent: true, modelSettings: { ...settings, model: 'missing' } } })
    assert.equal(bad.isError, true); assert.equal((await invoke('theone_history_status')).consent, 'declined')
    await invoke('theone_history_consent', { consent: true, modelSettings: settings })
    assert.deepEqual((await invoke('theone_history_status')).modelSettings, settings)
    await invoke('theone_history_refresh')
    assert.equal((await invoke('theone_desktop_state', { profileId: 'test' })).catalog.consent, 'granted')
  } finally { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('MCP dispatch validates proposal shape and saves routing settings separately from history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-routing-mcp-'))
  const models = [{ model: 'gpt-6-luna', displayName: 'Luna', description: '', reasoningEfforts: ['low','medium'], defaultEffort: 'medium', fastTier: 'priority' }]
  const service = new TheOneService({ dataDir: dir, router: { models: async () => models, decide: async () => { throw Error('proposal should skip inference') } },
    backend: { execute: async () => ({ status: 'completed' }), respond: async () => {}, close: async () => {} } })
  const server = createMcpServer(service), client = new Client({ name: 'routing-test', version: '1' })
  const [a,b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    const invoke = async (name: string, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return (result.structuredContent as any).result }
    assert.equal((await invoke('theone_configure', { gatewayId: 'main', workspace: dir })).routerMode, 'auto')
    assert.deepEqual((await invoke('theone_router_models')).selection, { model: 'gpt-6-luna', effort: 'low', fast: false })
    const settings = { model: 'gpt-6-luna', effort: 'medium', fast: true }
    service.runtime.put('catalog-model-settings', 'main', { ...settings, fast: false })
    await invoke('theone_router_configure', { modelSettings: settings })
    assert.deepEqual(service.runtime.get('router-model-settings', 'main'), settings)
    assert.deepEqual(service.runtime.get('catalog-model-settings', 'main'), { ...settings, fast: false })
    const unavailable = await client.callTool({ name: 'theone_router_configure', arguments: { modelSettings: { ...settings, model: 'removed' } } })
    assert.equal(unavailable.isError, true); assert.deepEqual((await invoke('theone_router_models')).selection, settings)
    const bad = await client.callTool({ name: 'theone_dispatch', arguments: { gatewayId: 'main', inputId: 'bad', text: '任务', proposal: { topicId: 'x', newTopic: { title: '新话题' }, confidence: 'high' } } })
    assert.equal(bad.isError, true)
    const routed = await invoke('theone_dispatch', { gatewayId: 'main', inputId: '1', text: '安排旅行', proposal: { newTopic: { title: '长途旅行计划', label: ' 旅行 ' }, confidence: 'high' } })
    assert.equal(routed.receipt.source, 'proposal'); assert.equal(routed.catalog[0].label, '旅行')
    const again = await invoke('theone_dispatch', { gatewayId: 'main', inputId: '1', text: '安排旅行', catalogVersion: routed.catalogVersion })
    assert.equal(again.id, routed.id); assert.equal(again.catalog, undefined)
    assert.equal(service.desktopSnapshot('test').topics[0].label, '旅行')
    const reopened = new TheOneService({ dataDir: dir })
    try { assert.deepEqual(reopened.runtime.get('router-model-settings', 'main'), settings) } finally { await reopened.close() }
  } finally { await client.close(); await server.close(); await service.close(); rmSync(dir, { recursive: true, force: true }) }
})
