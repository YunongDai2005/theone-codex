import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp-server.ts'
import { TheOneService } from '../src/service.ts'

// Missing global metadata or a broken resource URI makes the installed app unreachable.
test('sidebar entrypoint opens with empty arguments and serves its app without starting work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-ui-'))
  const service = new TheOneService({ dataDir: dir })
  service.createTopic('旅行')
  const server = createMcpServer(service)
  const client = new Client({ name: 'ui-entrypoint-test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a); await client.connect(b)
    const { tools } = await client.listTools()
    const entry = tools.find(t => (t._meta?.['openai/ui'] as any)?.entrypoints?.some((e: any) => e.type === 'global'))
    assert.ok(entry, 'Host must discover a global sidebar entrypoint')
    assert.equal(entry.title, 'TheOne')
    const opened = await client.callTool({ name: entry.name, arguments: {} })
    assert.ok(!opened.isError)
    const result = (opened.structuredContent as any).result
    assert.equal(result.mode, 'launcher')
    assert.equal(result.topics[0].title, '旅行')
    assert.equal(result.status.gateways.length, 0)
    assert.equal(service.status().runs.length, 0)
    const uri = (entry._meta?.ui as any).resourceUri
    const resource = await client.readResource({ uri })
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app')
    assert.ok('text' in resource.contents[0] && resource.contents[0].text.length > 1000)
    assert.ok((resource.contents[0]._meta?.['openai/ui'] as any)?.availableDisplayModes.includes('fullscreen'))
    const panel = tools.find(t => (t._meta?.['openai/ui'] as any)?.entrypoints?.some((e: any) => e.type === 'thread'))
    assert.ok(panel && panel.name !== entry.name, 'Topic controls must be separate from the new native chat launcher')
    const panelResult = await client.callTool({ name: panel.name, arguments: {} })
    assert.equal((panelResult.structuredContent as any).result.mode, 'topics')
  } finally {
    await client.close(); await server.close(); await service.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
