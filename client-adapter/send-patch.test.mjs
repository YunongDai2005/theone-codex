import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readArchiveFile } from './archive.mjs'

test('installed native send seam emits input before dispatch without delaying or changing the send', async () => {
  const module = await import('./send-patch.mjs').catch(() => ({}))
  assert.equal(typeof module.patchSendRenderer, 'function')
  const source = readArchiveFile('C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0/app/resources/app.asar', module.SEND_RENDERER_PATH).toString()
  const patched = module.patchSendRenderer(source)
  const start = patched.indexOf('this.executeTurnStart='), end = patched.indexOf(',this.threadCreation=', start)
  assert.ok(start > 0 && end > start)
  const events = [], input = { request: { threadId: 'thread', input: [{ type: 'text', text: '继续写作' }] } }, result = Promise.resolve('native')
  const manager = { hostId: 'local', streamRecovery: { wrapTurnStart: fn => fn } }
  const send = (...args) => { events.push({ kind: 'send', args }); return result }
  vm.runInNewContext(`(function(){${patched.slice(start, end)}}).call(manager)`, { manager, X: send,
    window: { dispatchEvent: event => events.push(event) }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } } })
  assert.equal(manager.executeTurnStart('thread', input), result)
  assert.equal(events[0].type, 'theone-user-send'); assert.equal(events[0].detail.text, '继续写作')
  assert.equal(events[0].detail.threadId, 'thread'); assert.deepEqual(events[1].args, ['thread', input])
  events.length = 0
  manager.executeTurnStart('thread', { request: { input: [], toolOutput: {} } })
  assert.equal(events.length, 1)
  assert.throws(() => module.patchSendRenderer(source + '\n'), /mismatch/)
})

test('broken preroute listeners cannot stop native send', async () => {
  const module = await import('./send-patch.mjs').catch(() => ({}))
  assert.equal(typeof module.patchSendRenderer, 'function')
  const source = module.patchSendRenderer(readArchiveFile('C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0/app/resources/app.asar', module.SEND_RENDERER_PATH).toString())
  const start = source.indexOf('this.executeTurnStart='), end = source.indexOf(',this.threadCreation=', start)
  const manager = { hostId: 'local', streamRecovery: { wrapTurnStart: fn => fn } }
  vm.runInNewContext(`(function(){${source.slice(start, end)}}).call(manager)`, { manager, X: () => 'sent', window: { dispatchEvent: () => { throw Error('offline') } }, CustomEvent: class {} })
  assert.equal(manager.executeTurnStart('thread', { request: { input: [{ type: 'text', text: 'hi' }] } }), 'sent')
})
