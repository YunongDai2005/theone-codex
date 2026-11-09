import { createInterface } from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
let n = 0, pending = new Map(), requestNo = 1000, threads = new Map()
const finish = (threadId, turnId, text, status = 'completed') => {
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `a-${turnId}`, text, phase: 'final_answer' } } })
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } })
}
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (!msg.method) {
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); finish(p.threadId, p.turnId, p.kind === 'question' ? JSON.stringify(msg.result?.answers) : msg.result?.decision === 'accept' ? 'approved' : 'declined') }
    return
  }
  const result = value => send({ id: msg.id, result: value })
  const p = msg.params ?? {}
  if (msg.method === 'initialize') result({ userAgent: 'fake-codex', platformFamily: 'windows' })
  else if (msg.method === 'thread/start') { const id = `t-${++n}`; threads.set(id, []); result({ thread: { id } }) }
  else if (msg.method === 'thread/resume') { if (!threads.has(p.threadId)) threads.set(p.threadId, []); result({ thread: { id: p.threadId } }) }
  else if (msg.method === 'turn/start') {
    const id = `v-${++n}`, text = p.input.at(-1).text, threadId = p.threadId
    result({ turn: { id, status: 'inProgress' } })
    send({ method: 'turn/started', params: { threadId, turn: { id } } })
    if (text.includes('crash')) return process.exit(2)
    if (text.includes('hang')) return
    if (text.includes('unknown-request')) { const requestId = ++requestNo; pending.set(requestId, { threadId, turnId: id }); send({ id: requestId, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'fixture' } }); return }
    if (text.includes('question-request')) { const requestId = ++requestNo; pending.set(requestId, { threadId, turnId: id, kind: 'question' }); send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId, turnId: id, itemId: 'question', questions: [{ id: 'color', header: 'Color', question: 'Which color?' }] } }); return }
    if (text.includes('approve')) { const requestId = ++requestNo; pending.set(requestId, { threadId, turnId: id }); send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: id, itemId: 'cmd', command: 'write a file' } }); return }
    const history = threads.get(threadId); history.push(text)
    setTimeout(() => finish(threadId, id, JSON.stringify({ history, cwd: p.cwd, sandbox: p.sandboxPolicy, input: p.input })), 20)
  }
  else if (msg.method === 'turn/interrupt') { result({}); finish(p.threadId, p.turnId, 'stopped', 'interrupted') }
  else if (msg.method === 'thread/compact/start') result({})
  else if (msg.method !== 'initialized') send({ id: msg.id, error: { code: -32601, message: 'Unknown method' } })
})
