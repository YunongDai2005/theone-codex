/**
 * What a topic did with one message, read back from its own DSH session: whether its turn finished,
 * the reply it gave, and the steps that may have changed something. Used after a restart, when
 * TheOne's memory of the run is gone but the topic session (persisted by DSH) still has it all.
 */

/** Tools that only read or ask; any other tool may have changed files, run commands or sent something. */
const READ_ONLY = new Set(['read', 'read_image', 'glob', 'grep', 'ls', 'list_agents', 'job_list', 'job_output', 'get_goal',
  'ask_user_question', 'exit_plan_mode', 'todo_write', 'skill', 'web_search', 'web_fetch',
  'theone_search_history', 'theone_read_topic', 'theone_read_fact', 'theone_update_state', 'theone_task', 'theone_handback'])

/** Whether a tool may change files, run commands or send something (anything but reading and asking). */
export const changesSomething = (name: string) => !READ_ONLY.has(name)

interface Event { type: string; seq: number; data: unknown }

export interface TopicTurn {
  /** The message reached the topic. */
  found: boolean
  /** What the user asked, as the topic received it. */
  request: string
  /** Its turn ended normally. */
  completed: boolean
  /** The topic's last words in that turn. */
  reply: string
  /** Steps that may have changed something, in plain words ("修改 src/a.ts", "运行 npm test"). */
  changes: string[]
  /** The topic session's first and last event of that turn. */
  startSeq?: number
  endSeq?: number
}

type Block = { type: string; text?: string }
const textOf = (content: readonly Block[] | undefined) => (content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()

/** One step in a few words, from the tool's name and the arguments the model gave it. */
export function describeStep(name: string, args: string): string {
  let value: Record<string, unknown> = {}
  try { value = JSON.parse(args) as Record<string, unknown> } catch { /* not JSON: name only */ }
  const pick = (...keys: string[]) => keys.map(key => value[key]).find((item): item is string => typeof item === 'string' && !!item.trim())
  const path = pick('file_path', 'path', 'notebook_path')
  const command = pick('command', 'cmd')
  const clip = (text: string) => text.length > 80 ? `${text.slice(0, 77)}…` : text
  if (command) return `运行 ${clip(command.replace(/\s+/g, ' ').trim())}`
  if (path) return `${/write|create/.test(name) ? '写入' : '修改'} ${clip(path)}`
  return `调用 ${name}`
}

/**
 * The topic's turn for message `messageId` (or, when it arrived batched under another id, the
 * latest one carrying `text`), up to the next message from the user.
 */
export function topicTurn(events: readonly Event[], messageId: string, text?: string): TopicTurn {
  const isUser = (event: Event) => event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'user'
  let start = events.findIndex(event => event.type === 'user/message' && (event.data as { id?: string }).id === messageId)
  if (start < 0 && text?.trim()) start = events.findLastIndex(event => isUser(event) && textOf((event.data as { content?: Block[] }).content).includes(text.trim()))
  if (start < 0) return { found: false, request: text ?? '', completed: false, reply: '', changes: [] }
  const request = textOf((events[start].data as { content?: Block[] }).content)
  const next = events.findIndex((event, index) => index > start && isUser(event))
  const span = events.slice(start, next < 0 ? undefined : next)
  const endAt = span.findIndex(event => event.type === 'turn/end')
  const turn = endAt < 0 ? span : span.slice(0, endAt + 1)
  const end = endAt < 0 ? undefined : turn[endAt]
  const completed = (end?.data as { reason?: { kind?: string } } | undefined)?.reason?.kind === 'completed'
  const reply = turn.reduce((last, event) => {
    if (event.type !== 'assistant/message') return last
    const said = textOf((event.data as { message?: { content?: Block[] } }).message?.content)
    return said || last
  }, '')
  const changes = turn.flatMap(event => {
    if (event.type !== 'tool/call') return []
    const call = event.data as { name: string; arguments: string }
    return READ_ONLY.has(call.name) ? [] : [describeStep(call.name, call.arguments)]
  })
  return { found: true, request, completed, reply, changes: [...new Set(changes)], startSeq: events[start].seq, ...(turn.length ? { endSeq: turn.at(-1)!.seq } : {}) }
}

/** What the topic is told the next time it works, about the message a restart cut off. */
export function resumeNote(turn: TopicTurn): string {
  const asked = turn.request.length > 200 ? `${turn.request.slice(0, 197)}…` : turn.request
  return [`上次的这条消息做到一半时，DSH 重启打断了你：「${asked}」。`,
    turn.changes.length ? `那时已经做过：${turn.changes.slice(0, 12).join('；')}${turn.changes.length > 12 ? ` 等 ${turn.changes.length} 步` : ''}。` : '那时还没有做过会改动东西的步骤。',
    '如果用户要你接着做，先检查现状（文件、命令结果），不要重复已经做过的改动。'].join('\n')
}

/** What a topic is told the next time it works, about a message that reached it by mistake. */
export function misrouteNote(request: string, movedTo: string): string {
  const asked = request.length > 200 ? `${request.slice(0, 197)}…` : request
  return `之前交给你的这条消息分错了，已经转给「${movedTo}」处理：「${asked}」。那一轮的内容和结论不属于这个话题，不要沿用。`
}
