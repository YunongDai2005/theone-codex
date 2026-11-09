import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
export function workerProtocol(send, crash = () => {}) {
let n = 0, pending = new Map(), requestNo = 1000, threads = new Map(), turns = new Map()
const finish = (threadId, turnId, text, status = 'completed') => {
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `a-${turnId}`, text, phase: 'final_answer' } } })
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } })
}
return msg => {
  if (!msg.method) {
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      if (p.next && msg.result?.decision === 'accept') { p.next(); return }
      finish(p.threadId, p.turnId, p.kind === 'question' ? JSON.stringify(msg.result?.answers) : msg.result?.decision === 'accept' ? 'approved' : 'declined')
    }
    return
  }
  const result = value => send({ id: msg.id, result: value })
  const p = msg.params ?? {}
  if (msg.method === 'initialize') result({ userAgent: 'codex_cli_rs/1.2.3 (fixture)', platformFamily: 'windows' })
  else if (msg.method === 'thread/start') { const id = `t-${++n}`; threads.set(id, []); result({ thread: { id } }) }
  else if (msg.method === 'thread/resume') { if (!threads.has(p.threadId)) threads.set(p.threadId, []); result({ thread: { id: p.threadId } }) }
  else if (msg.method === 'turn/start') {
    const id = `v-${++n}`, text = p.input.slice(1).filter(i => i.type === 'text').at(-1)?.text ?? '', threadId = p.threadId
    turns.set(threadId, id)
    result({ turn: { id, status: 'inProgress' } })
    send({ method: 'turn/started', params: { threadId, turn: { id } } })
    if (text.startsWith('target-check:')) {
      const { outside, file, twice, hold, expectedSandbox } = JSON.parse(text.slice('target-check:'.length))
      if (expectedSandbox && p.sandboxPolicy.type !== expectedSandbox) { finish(threadId, id, 'unsafe-initial-sandbox', 'failed'); return }
      const request = (second = false) => {
        const itemId = second ? 'second-change' : 'first-change'
        const cwd = outside ?? p.cwd
        if (file) send({ method: 'item/started', params: { threadId, turnId: id, item: { id: itemId, type: 'fileChange', status: 'inProgress', changes: [{ path: cwd + '/file.txt', kind: { type: 'update' }, diff: '' }] } } })
        const requestId = ++requestNo
        pending.set(requestId, { threadId, turnId: id, ...(twice && !second ? { next: () => request(true) } : hold ? { next: () => {} } : {}) })
        send({ id: requestId, method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
          params: { threadId, turnId: id, itemId, startedAtMs: Date.now(), ...(file ? {} : { command: 'write a file', cwd }) } })
      }
      request(); return
    }
    if (text?.includes('crash')) return crash()
    if (text.includes('hang')) return
    if (text.includes('unknown-request')) { const requestId = ++requestNo; pending.set(requestId, { threadId, turnId: id }); send({ id: requestId, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'fixture' } }); return }
    if (text.includes('question-request')) { const requestId = ++requestNo; pending.set(requestId, { threadId, turnId: id, kind: 'question' }); send({ id: requestId, method: 'item/tool/requestUserInput', params: { threadId, turnId: id, itemId: 'question', questions: [{ id: 'color', header: 'Color', question: 'Which color?' }] } }); return }
    if (text.includes('approve')) { const requestId = ++requestNo; pending.set(requestId, { threadId, turnId: id }); send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: id, itemId: 'cmd', command: 'write a file' } }); return }
    const history = threads.get(threadId); history.push(text)
    setTimeout(() => finish(threadId, id, JSON.stringify({ history, cwd: p.cwd, sandbox: p.sandboxPolicy, input: p.input })), 20)
  }
  else if (msg.method === 'turn/steer') {
    if (turns.get(p.threadId) !== p.expectedTurnId) return send({ id: msg.id, error: { code: -32000, message: 'turn mismatch' } })
    result({ turnId: p.expectedTurnId }); finish(p.threadId, p.expectedTurnId, JSON.stringify({ steered: p.input }))
  }
  else if (msg.method === 'turn/interrupt') { result({}); finish(p.threadId, p.turnId, 'stopped', 'interrupted') }
  else if (msg.method === 'thread/compact/start') result({})
  else if (msg.method !== 'initialized') send({ id: msg.id, error: { code: -32601, message: 'Unknown method' } })
}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receive = workerProtocol(message => process.stdout.write(JSON.stringify(message) + '\n'), () => process.exit(2))
  createInterface({ input: process.stdin }).on('line', line => receive(JSON.parse(line)))
}
