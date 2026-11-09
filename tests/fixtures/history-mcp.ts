import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TheOneService } from '../../src/service.ts'
import { createMcpServer } from '../../src/mcp-server.ts'
const chats = [
  { id: 'sample-mixed', title: '旅行与写作', cwd: 'D:/示例/计划', updatedAt: 100, texts: ['云南旅行路线', '小说章节大纲'] },
  { id: 'sample-travel', title: '旅行住宿', cwd: 'D:/示例/计划', updatedAt: 101, texts: ['云南旅行酒店'] },
  { id: 'sample-private', title: '不参与整理的会话', cwd: 'D:/示例/私密', updatedAt: 102, texts: ['排除样例'] },
]
const service = new TheOneService({ dataDir: process.env.THEONE_DATA_DIR!, catalog: {
  source: { list: async () => chats.map(({ texts, ...s }) => s), read: async id => ({ turns: chats.find(s => s.id === id)!.texts.map((text,i) => ({ id: `${id}-${i}`, status: 'completed', items: [{ id: 'user-' + i, type: 'userMessage', content: [{ type: 'text', text }] }] })) }), close: async () => {} },
  model: { models: async () => [
    { model: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: '', reasoningEfforts: ['low','medium','high'], defaultEffort: 'medium', fastTier: 'priority' },
    { model: 'gpt-6-luna', displayName: 'GPT-6 Luna', description: '', reasoningEfforts: ['low','medium','high'], defaultEffort: 'medium', fastTier: 'priority' },
    { model: 'basic', displayName: '无快速模式示例', description: '', reasoningEfforts: ['low'], defaultEffort: 'low', fastTier: null },
  ], classify: async (input, signal, settings) => {
    if (settings?.model !== 'gpt-6-luna' || settings.effort !== 'medium' || !settings.fast) throw Error('UI did not pass the selected model, medium reasoning and Fast')
    await new Promise(resolve => setTimeout(resolve, 700)); signal.throwIfAborted()
    const groups = new Map<string, number[]>()
    for (const turn of input.turns) { const title = turn.text.includes('小说') ? '小说写作' : '云南旅行'; groups.set(title, [...groups.get(title) ?? [], turn.seq]) }
    return { topics: [...groups].map(([title, turns]) => ({ contextId: input.contexts.find((c: any) => c.title === title)?.id ?? null,
      title, turns, summary: title + '的历史整理结果', lastState: '待继续', entities: [], keywords: [title], groupId: null, groupTitle: '计划', groupSummary: '' })) }
  }, close: async () => {} },
} })
const server = createMcpServer(service)
await server.connect(new StdioServerTransport())
process.stdin.once('end', () => { void service.close().then(() => server.close()) })
