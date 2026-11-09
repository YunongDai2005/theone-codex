import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
export function routerProtocol(send, env, exit, pid) {
let initialized = false, count = 0
const threads = new Map()
return m => {
  const p = m.params ?? {}
  const reply = result => send({ id: m.id, result })
  const fail = message => send({ id: m.id, error: { code: -1, message } })
  if (env.ROUTER_LOG) appendFileSync(env.ROUTER_LOG, JSON.stringify({ method: m.method, params: p, pid }) + '\n')
  if (env.ROUTER_HANG_METHOD === m.method) return
  if (m.method === 'initialize') { initialized = p.capabilities?.experimentalApi; return reply({}) }
  if (m.method === 'initialized') return
  if (m.method === 'model/list') return reply({ data: p.cursor ? [
    { model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], serviceTiers: [{ id: 'priority' }], inputModalities: ['text'] },
  ] : [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }], inputModalities: ['text'] }], nextCursor: p.cursor ? null : 'second' })
  if (m.method === 'config/read') return reply({ config: { mcp_servers: { unsafe: {} }, plugins: { unsafe: {} } } })
  if (m.method === 'thread/start') {
    if (!initialized || !p.ephemeral || p.sandbox !== 'read-only' || p.environments?.length !== 0 || p.config['mcp_servers.unsafe.enabled'] !== false || p.config['features.shell_tool'] !== false || p.config['features.plugins'] !== false || p.config['features.multi_agent'] !== false) return fail('unsafe thread')
    const id = 'router-' + ++count; threads.set(id, p)
    return reply({ thread: { id }, model: env.ROUTER_WRONG_MODEL ? 'wrong' : p.model })
  }
  if (m.method === 'turn/start') {
    if (!threads.has(p.threadId) || p.environments?.length !== 0 || p.sandboxPolicy?.networkAccess !== false || !p.disabledPluginIds?.includes('unsafe') || !p.outputSchema?.properties?.label) return fail('unsafe turn or missing schema')
    const text = p.input[0].text, data = JSON.parse(text.slice(text.indexOf('\n') + 1)), threadId = p.threadId
    if (data.text === 'DISCONNECT' && !existsSync(env.ROUTER_MARKER)) { writeFileSync(env.ROUTER_MARKER, 'once'); exit(); return }
    reply({ turn: { id: 'turn' } })
    if (data.text === 'WAIT') return
    if (data.text === 'TOOL') { send({ method: 'item/started', params: { threadId, item: { type: 'commandExecution' } } }); return }
    const output = data.text === 'CREATE' ? { action: 'CREATE', title: '开发路由器', label: ' 路由 ', reason: 'new' }
      : { action: 'EXISTING', contextId: data.text === 'INVALID_ID' ? 'invented' : data.contexts[0].id, reason: 'existing' }
    send({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', phase: 'final_answer', text: data.text === 'INVALID_JSON' ? '{bad' : JSON.stringify(output) } } })
    send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } }); return
  }
  if (m.method === 'thread/unsubscribe') { threads.delete(p.threadId); return reply({}) }
  if (m.method === 'turn/interrupt') return reply({})
  return fail('unexpected ' + m.method)
}
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const receive = routerProtocol(value => process.stdout.write(JSON.stringify(value) + '\n'), process.env, () => process.exit(0), process.pid)
  createInterface({ input: process.stdin }).on('line', line => receive(JSON.parse(line)))
}
