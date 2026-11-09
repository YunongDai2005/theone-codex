// Test-only process boundary: AppServer's JSON-RPC framing, pending requests and notifications stay real.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { routerProtocol } from './router-app-server.mjs'
import { catalogProtocol } from './catalog-app-server.mjs'

export function installInProcessRouter(t) {
  let pid = 0
  const mock = t.mock.method(childProcess, 'spawn', (_command, _args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    let stopped = false
    child.kill = () => {
      if (stopped) return false
      stopped = true; child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('exit', 0)); return true
    }
    const send = value => { if (!stopped) child.stdout.write(JSON.stringify(value) + '\n') }
    const receive = _args[0]?.endsWith('catalog-app-server.mjs') ? catalogProtocol(send, options.env, process.cwd())
      : routerProtocol(send, options.env, () => child.kill(), ++pid)
    let text = ''
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      text += chunk.toString()
      while (text.includes('\n')) { const end = text.indexOf('\n'), line = text.slice(0, end); text = text.slice(end + 1); queueMicrotask(() => { if (!stopped) receive(JSON.parse(line)) }) }
      done()
    } })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}
