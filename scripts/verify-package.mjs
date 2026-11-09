import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { findCodex, AppServer } from '../dist/app-server.js'

await mkdir('.theone', { recursive: true })
const temp = await mkdtemp(resolve('.theone/package-validation-'))
const codexHome = join(temp, 'codex-home'), dataDir = join(temp, 'data')
await mkdir(codexHome, { recursive: true })
const env = { ...process.env, CODEX_HOME: codexHome, THEONE_DATA_DIR: dataDir }
const cli = (args) => execFileSync(findCodex(), args, { env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
cli(['plugin', 'marketplace', 'add', resolve('release')])
const installation = JSON.parse(cli(['plugin', 'add', 'gpt-theone@theone-local', '--json']))
const listing = JSON.parse(cli(['plugin', 'list', '--marketplace', 'theone-local', '--json']))
const client = new Client({ name: 'package-test', version: '1' })
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('release/gpt-theone/server/main.mjs')], env, stderr: 'pipe' })
await client.connect(transport)
let toolCount
try {
  const { tools } = await client.listTools(); toolCount = tools.length
  assert.ok(tools.some(t => t.name === 'theone_dispatch'))
  const launch = tools.find(t => t._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'global'))
  const panel = tools.find(t => t._meta?.['openai/ui']?.entrypoints?.some(e => e.type === 'thread'))
  assert.ok(launch && panel && launch.name !== panel.name)
  const ui = await client.readResource({ uri: launch._meta.ui.resourceUri })
  assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.ok(ui.contents[0].text.length > 1000)
  const configured = await client.callTool({ name: 'theone_configure', arguments: { gatewayId: 'package-test', workspace: temp } })
  assert.ok(!configured.isError)
  const route = await client.callTool({ name: 'theone_route', arguments: { gatewayId: 'package-test', inputId: '1', text: '新话题：安装验证' } })
  assert.ok(!route.isError)
} finally { await client.close() }
const app = new AppServer({ env, requestTimeoutMs: 20000 })
let skillVisible = false, nativeToolCount = 0, nativeMcpCallPassed = false
try {
  await app.connect()
  const result = await app.request('skills/list', { cwds: [temp] })
  const skills = result.data.flatMap(entry => entry.skills)
  const installedSkill = skills.find(s => s.path.replace(/\\/g, '/').toLowerCase().startsWith(codexHome.replace(/\\/g, '/').toLowerCase() + '/') && s.path.replace(/\\/g, '/').endsWith('/skills/theone/SKILL.md'))
  skillVisible = !!installedSkill
  assert.ok(skillVisible, 'Installed plugin skill must be discoverable by native Codex')
  const { thread } = await app.request('thread/start', { cwd: temp, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: true })
  const inventory = await app.request('mcpServerStatus/list', { threadId: thread.id })
  const owned = inventory.data.find(s => Object.values(s.tools ?? {}).some(t => t.name === 'theone_status'))
  if (!owned) console.error(JSON.stringify({ nativeMcpInventory: inventory }, null, 2))
  assert.ok(owned, 'Native Codex must load the installed plugin MCP server')
  nativeToolCount = Object.keys(owned.tools).length
  const called = await app.request('mcpServer/tool/call', { threadId: thread.id, server: owned.name, tool: 'theone_status', arguments: {} })
  assert.ok(!called.isError && !called.result?.isError)
  nativeMcpCallPassed = true
} finally { await app.close() }
const report = { at: new Date().toISOString(), isolatedCodexHome: true, installation, listing, toolCount, skillVisible, nativeToolCount, nativeMcpCallPassed, mcpWorkflowPassed: true }
await writeFile('evidence/package-validation-ui.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
