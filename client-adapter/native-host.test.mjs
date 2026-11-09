import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeHost, PLUGIN_MENTION } from './native-host.mjs'

function fixture() {
  const storage = new Map(), requests = [], openings = []
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }
  const values = new Map([['user', 'user-a'], ['account', 'account-a'], ['workspace', 'D:/project'], ['selected', 'draft-1'], ['draft', 'draft-1'], ['location', { pathname: '/' }]])
  const modules = {
    DBCl: { L$F: id => id.startsWith('draft-'), _RT: id => '/threads/' + id },
    V3rO: { Tl: 'bound', RH: 'draft', oB: 'reverse' }, d6Ff: { OC: value => value }, RFDv: { oN: 'selected' },
    SPnB: { chatGptAuthenticatedUserId$: 'user', chatGptAuthenticatedAccountId$: 'account' }, kfGJ: { fI: 'local' },
    nlNF: { x2: 'location' }, ndjw: { pY: 'workspace' }, yWTM: { w9: () => 'home' }, E8Sp: { gM: 'navigation' },
    ILnd: { W1: async (...args) => { requests.push(args); return { structuredContent: { result: { version: 'test' } } } } },
    Dgwo: { V: () => ({ readThread: async (id, options) => { requests.push({ id, options }); return {} } }) },
    hvSK: { hI: (scope, params) => openings.push(params) },
  }
  const scope = { get: key => values.get(key), watch: fn => { fn({ get: key => values.get(key) }); return () => {} } }
  const host = createNativeHost({ scope, modules: id => modules[id], preview: { project: { id: 'project' } }, startDraft: (draft, created) => { requests.push(draft); created() } })
  return { host, values, requests, openings, modules, scope }
}

test('native draft captures the host draft identity and only pre-fills the plugin mention', async () => {
  const f = fixture(), record = await f.host.newDraft()
  assert.deepEqual(record, { clientThreadId: 'draft-1', workspace: 'D:/project' })
  assert.equal(f.requests[0].prefillPrompt, PLUGIN_MENTION)
  assert.equal(f.requests[0].autoSubmit, undefined)
  assert.equal(f.requests[0].sandbox, undefined)
  f.values.set('bound', 'real-thread')
  assert.equal(f.host.resolveThread(record.clientThreadId), 'real-thread')
})

test('tool bridge uses the existing local native MCP transport and refuses an account switch', async () => {
  const f = fixture()
  assert.deepEqual(await f.host.call('theone_desktop_state', { profileId: f.host.profileId }), { version: 'test' })
  assert.equal(f.requests[0][1], 'local')
  assert.equal(f.requests[0][3], 'theone_desktop_state')
  assert.deepEqual(f.requests[0][5], { retryOnTransportClosed: false })
  f.values.set('account', 'account-b')
  await assert.rejects(f.host.call('theone_desktop_state', {}), /账户已切换/)
  assert.equal(f.requests.length, 1)
})

test('returning to a main chat uses native navigation without changing its composer or sending', async () => {
  const f = fixture()
  await f.host.openThread('main')
  assert.equal(f.openings[0].routePath, '/threads/main')
  assert.equal(f.openings[0].clientThreadId, 'main')
  assert.equal(f.openings[0].state.prefillPrompt, undefined)
  assert.equal(f.openings[0].state.sidebarProductMode, 'codex')
  assert.equal(f.requests.length, 0)
})

test('home-route native drafts have an identity even though the host sidebar selection is null', () => {
  const f = fixture(); f.values.set('selected', null)
  assert.equal(f.host.current().clientThreadId, 'draft-1')
  f.values.set('draft', 'draft-2')
  assert.equal(f.host.current().clientThreadId, 'draft-2')
  f.values.set('location', { pathname: '/settings' })
  assert.equal(f.host.current().clientThreadId, null)
})

test('native send subscription forwards only local user requests and never propagates listener failures', async () => {
  const f = fixture(), events = new EventTarget(), seen = []
  globalThis.window = events
  assert.equal(typeof f.host.watchSend, 'function')
  const stop = f.host.watchSend(value => { seen.push(value); return Promise.reject(Error('offline')) })
  const send = detail => { const e = new Event('theone-user-send'); e.detail = detail; events.dispatchEvent(e) }
  send({ hostId: 'local', threadId: 'main', text: 'hi' })
  send({ hostId: 'remote', threadId: 'main', text: 'no' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(seen.length, 1); stop(); send({ hostId: 'local', threadId: 'main', text: 'again' }); assert.equal(seen.length, 1)
  delete globalThis.window
})
