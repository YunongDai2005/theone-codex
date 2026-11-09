import { AppServer } from '../dist/app-server.js'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const app = new AppServer({ requestTimeoutMs: 30000 })
const manifest = JSON.parse(await readFile('release/theone/plugin.json', 'utf8'))
try {
  await app.connect()
  const { plugin } = await app.request('plugin/read', { pluginName: 'theone', marketplacePath: resolve('release/.agents/plugins/marketplace.json') })
  assert.equal(plugin.summary.installed, true)
  assert.equal(plugin.summary.enabled, true)
  assert.equal(plugin.summary.localVersion, manifest.version)
  const installedRoot = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugins/cache/theone-codex/theone', manifest.version)
  const shippedHash = createHash('sha256').update(await readFile('release/theone/server/main.mjs')).digest('hex')
  const installedHash = createHash('sha256').update(await readFile(join(installedRoot, 'server/main.mjs'))).digest('hex')
  assert.equal(installedHash, shippedHash)
  const { thread } = await app.request('thread/start', { cwd: process.cwd(), sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: true })
  const inventory = await app.request('mcpServerStatus/list', { threadId: thread.id })
  const server = inventory.data.find(s => Object.values(s.tools ?? {}).some(t => t.name === 'theone_status'))
  assert.ok(server, 'Installed native MCP server must be discoverable')
  const result = await app.request('mcpServer/tool/call', { threadId: thread.id, server: server.name, tool: 'theone_status', arguments: {} })
  assert.ok(!result.isError && !result.result?.isError)
  assert.ok(JSON.stringify(result).includes(manifest.version))
  const desktopState = await app.request('mcpServer/tool/call', { threadId: thread.id, server: server.name, tool: 'theone_desktop_state', arguments: { profileId: 'installation-read-only-check' } })
  assert.ok(!desktopState.isError)
  assert.ok(Array.isArray(desktopState.structuredContent?.result?.topics))
  assert.equal(desktopState.structuredContent.result.catalog?.available, true)
  for (const name of ['theone_history_models','theone_history_status','theone_history_sessions','theone_history_consent','theone_history_exclude','theone_history_refresh','theone_history_pause'])
    assert.ok(Object.values(server.tools).some(t => t.name === name), `Installed history tool missing: ${name}`)
  const history = await app.request('mcpServer/tool/call', { threadId: thread.id, server: server.name, tool: 'theone_history_status', arguments: {} })
  assert.ok(!history.isError && history.structuredContent?.result?.available)
  const models = await app.request('mcpServer/tool/call', { threadId: thread.id, server: server.name, tool: 'theone_history_models', arguments: {} })
  assert.ok(!models.isError && models.structuredContent?.result?.models.length)
  const entry = Object.values(server.tools).find(t => t.name === 'theone_open')
  assert.ok(entry?._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'global'), 'Native host must receive global entrypoint metadata')
  const opened = await app.request('mcpServer/tool/call', { threadId: thread.id, server: server.name, tool: 'theone_open', arguments: {} })
  assert.ok(!opened.isError)
  assert.ok(opened.structuredContent?.result?.status)
  assert.equal(opened.structuredContent.result.mode, 'launcher')
  const panel = Object.values(server.tools).find(t => t.name === 'theone_panel')
  assert.ok(panel?._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'thread'))
  const resource = await app.request('mcpServer/resource/read', { threadId: thread.id, server: server.name, uri: entry._meta.ui.resourceUri })
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.ok(resource.contents[0].text.length > 1000)
  const htmlHash = createHash('sha256').update(await readFile(join(installedRoot, 'ui/theone.html'))).digest('hex')
  assert.equal(htmlHash, createHash('sha256').update(await readFile('release/theone/ui/theone.html')).digest('hex'))
  const report = { at: new Date().toISOString(), scope: 'actual-local-user', installed: true, enabled: true, version: plugin.summary.localVersion, installedRoot,
    bundleSha256: installedHash, uiSha256: htmlHash, nativeToolCount: Object.keys(server.tools).length, nativeMcpCallPassed: true, nativeSidebarEntrypoint: true, nativeThreadEntrypoint: true, nativeResourceReadPassed: true, nativeOpenPassed: true,
    desktopStateToolVerified: true, historyToolsVerified: true, historyConsent: history.structuredContent.result.consent,
    historyModelChoicesVerified: true, historyModelSelection: models.structuredContent.result.selection,
    skill: plugin.skills.map(s => ({ name: s.name, enabled: s.enabled })), explicitModelTurnStarted: false,
    backgroundHistoryMayRunWithExistingConsent: history.structuredContent.result.consent === 'granted', desktopUiTested: false, hooksEnabled: false }
  await writeFile('evidence/local-installation-ui.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await app.close() }
