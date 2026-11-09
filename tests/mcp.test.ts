import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp-server.ts'
import { TheOneService } from '../src/service.ts'

test('official MCP client can discover, validate and use the topic workflow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-mcp-'))
  const service = new TheOneService({ dataDir: dir })
  const server = createMcpServer(service), client = new Client({ name: 'test-client', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    const { tools } = await client.listTools()
    assert.ok(tools.some(t => t.name === 'theone_dispatch'))
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
