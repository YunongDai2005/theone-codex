import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
let config, pending, experimental
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params ?? {}, reply = result => send({ id: m.id, result })
  if (m.method === 'initialize') { experimental = p.capabilities?.experimentalApi; return reply({}) }
  if (m.method === 'initialized') return
  if (m.method === 'config/read') return reply({ config: { model: 'gpt-6-astra', model_reasoning_effort: 'max', service_tier: 'priority', mcp_servers: { unsafe: { command: 'never-run' } }, plugins: { 'test@example': { enabled: true } } } })
  if (m.method === 'model/list') return reply({ data: p.cursor ? [
    { id: 'luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: 'Economical', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', inputModalities: ['text'], serviceTiers: [{ id: 'priority', name: 'Fast' }] },
    { id: 'basic', model: 'basic', displayName: 'Basic', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', inputModalities: ['text'], serviceTiers: [] },
    { id: 'hidden', model: 'hidden', hidden: true, supportedReasoningEfforts: [], inputModalities: ['text'] },
  ] : [{ id: 'astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium', inputModalities: ['text'], serviceTiers: [{ id: 'priority', name: 'Fast' }], isDefault: true }], nextCursor: p.cursor ? null : 'models-page2' })
  if (m.method === 'thread/list') return reply({ data: [{ id: p.cursor ? 'second' : 'first', name: '旧聊天', cwd: process.cwd(), updatedAt: 123, source: 'cli', status: { type: 'idle' } }], nextCursor: p.cursor ? null : 'page2' })
  if (m.method === 'thread/read') return reply({ thread: { id: p.threadId, historyMode: 'paginated', turns: [] } })
  if (m.method === 'thread/turns/list') return reply({ data: [{ id: p.cursor ? 'turn2' : 'turn1', status: 'completed', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '旅行' }] }] }], nextCursor: p.cursor ? null : 'older' })
  if (m.method === 'thread/start') {
    if (!experimental) return send({ id: m.id, error: { code: -32600, message: 'thread/start.environments requires experimentalApi capability' } })
    config = p
    if (process.env.CATALOG_EXPECT_MODEL && (p.model !== process.env.CATALOG_EXPECT_MODEL || p.serviceTier !== process.env.CATALOG_EXPECT_TIER)) return send({ id: m.id, error: { code: -1, message: 'wrong classification model or speed' } })
    if (!p.ephemeral || p.sandbox !== 'read-only' || p.config['mcp_servers.unsafe.enabled'] !== false || p.config['features.shell_tool'] !== false || p.config['features.plugins'] !== false) return send({ id: m.id, error: { code: -1, message: 'unsafe catalog model configuration' } })
    return reply({ thread: { id: 'classifier' }, model: p.model ?? 'gpt-6-astra' })
  }
  if (m.method === 'turn/start') {
    if (process.env.CATALOG_EXPECT_MODEL && (p.model !== process.env.CATALOG_EXPECT_MODEL || p.effort !== process.env.CATALOG_EXPECT_EFFORT || p.serviceTier !== process.env.CATALOG_EXPECT_TIER)) return send({ id: m.id, error: { code: -1, message: 'wrong classification effort or inherited speed' } })
    if (!p.outputSchema || !p.input[0].text.includes('quoted') || !config.developerInstructions.includes('JSON')) return send({ id: m.id, error: { code: -1, message: 'classification contract missing' } })
    reply({ turn: { id: 'turn' } }); pending = true
    if (p.input[0].text.includes('WAIT_FOR_ABORT')) return
    const output = p.outputSchema.properties.matches ? { matches: [] } : { topics: [] }
    send({ method: 'item/completed', params: { threadId: 'classifier', item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(output) } } })
    send({ method: 'turn/completed', params: { threadId: 'classifier', turn: { id: 'turn', status: 'completed' } } }); return
  }
  if (m.method === 'turn/interrupt') { reply({}); if (pending) send({ method: 'turn/completed', params: { threadId: 'classifier', turn: { id: 'turn', status: 'interrupted' } } }); return }
  if (m.method === 'thread/unsubscribe') return reply({})
  send({ id: m.id, error: { code: -32601, message: 'unexpected method ' + m.method } })
})
