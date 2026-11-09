import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TheOneService } from './service.ts'
import { CodexBackend } from './codex-backend.ts'
import { createMcpServer } from './mcp-server.ts'
import { TaskManager } from './tasks.ts'
import { hookContext } from './hook.ts'
import { AppServer, findCodex } from './app-server.ts'
import { routerFromEnvironment } from './http-router.ts'
import { CodexHistorySource, CodexCatalogModel } from './codex-history.ts'
import { CodexRouter } from './codex-router.ts'

const dataDir = process.env.THEONE_DATA_DIR ?? (process.env.PLUGIN_DATA ? join(process.env.PLUGIN_DATA, 'theone') : join(homedir(), '.gpt-theone'))
const mode = process.argv[2] ?? 'serve'
if (mode === 'hook') {
  let text = ''
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 1000000) { text = '{}'; break } }
  try { process.stdout.write(JSON.stringify(hookContext(JSON.parse(text), dataDir, process.env.THEONE_WORKER === '1'))) }
  catch { process.stdout.write('{}') }
} else if (mode === 'doctor') {
  const client = new AppServer({ worker: true })
  try { await client.connect(); const result = await client.request('model/list', { limit: 1 }); process.stdout.write(JSON.stringify({ version: '0.1.0-alpha.9', node: process.version, codex: findCodex(), initialized: true, availableModels: result.data?.length ?? 0, dataDir }, null, 2) + '\n') }
  finally { await client.close() }
} else if (mode === 'serve') {
  // An app-server worker inherits this environment. Do not expose a recursive execution gateway.
  if (process.env.THEONE_WORKER === '1') process.exit(0)
  const router = routerFromEnvironment() ?? new CodexRouter({ timeoutMs: process.env.THEONE_ROUTER_TIMEOUT_MS ? Number(process.env.THEONE_ROUTER_TIMEOUT_MS) : undefined })
  const service = new TheOneService({ dataDir, backend: new CodexBackend(), router, catalog: { source: new CodexHistorySource(), model: new CodexCatalogModel() } })
  const tasks = new TaskManager(service, dataDir)
  const server = createMcpServer(service, tasks)
  let closing = false
  const close = async () => { if (closing) return; closing = true; await tasks.close(); await service.close(); await server.close() }
  process.once('SIGINT', () => { void close() }); process.once('SIGTERM', () => { void close() }); process.stdin.once('end', () => { void close() })
  await server.connect(new StdioServerTransport())
} else { process.stderr.write('Usage: node main.js [serve|hook|doctor]\n'); process.exitCode = 2 }
