import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopController } from './desktop-controller.mjs'

test('overlapping desktop reads never replace a newer cursor and scope changes reset the feed', async () => {
  const replies = []
  const controller = new DesktopController({ load: () => null, save: () => {}, current: () => ({}), call: () => new Promise(resolve => replies.push(resolve)) })
  const first = controller.refresh(), second = controller.refresh()
  replies[1]({ gateway: null, topics: [{ id: 'new' }], cursor: { epoch: 'e', seq: 8, gatewayId: null } }); await second
  replies[0]({ gateway: null, topics: [{ id: 'old' }], cursor: { epoch: 'e', seq: 7, gatewayId: null } }); await first
  assert.equal(controller.state.topics[0].id, 'new')
  const third = controller.refresh()
  replies[2]({ gateway: null, topics: [], reset: true, cursor: { epoch: 'fresh', seq: 0, gatewayId: null } }); await third
  assert.equal(controller.state.cursor.epoch, 'fresh')
})

function fixture() {
  let saved = null, snapshot = { gateway: null, topics: [], activity: [] }, current = { locationKey: 'initial', workspace: 'D:/project' }
  const requests = [], openings = [], bindings = new Map()
  const host = {
    profileId: 'local-profile', load: () => saved, save: value => { saved = value }, current: () => current,
    resolveThread: id => bindings.get(id),
    newDraft: async () => { const record = { clientThreadId: 'draft-1', workspace: current.workspace }; openings.push('new'); current = { ...current, ...record }; return record },
    openThread: async id => { openings.push(id); current = { ...current, threadId: id } },
    readThread: async () => ({}),
    call: async (name, args) => {
      requests.push({ name, args })
      if (name === 'theone_desktop_state') return snapshot
      if (name === 'theone_desktop_bind') { snapshot = { ...snapshot, gateway: { gatewayId: args.gatewayId, workspace: args.workspace, enabled: true, currentTopicId: null } }; return snapshot }
      if (name === 'theone_select_topic') { snapshot = { ...snapshot, gateway: { ...snapshot.gateway, currentTopicId: args.topicId } }; return {} }
    },
  }
  return { host, requests, openings, bindings, saved: () => saved, setSnapshot: s => { snapshot = s }, navigate: key => { current = { locationKey: key, workspace: 'D:/elsewhere' } } }
}

test('send prerouting binds the first main draft, ignores other chats and silently tolerates transport failure', async () => {
  const f = fixture(), c = new DesktopController(f.host)
  assert.equal(typeof c.preroute, 'function')
  await c.open(); f.bindings.set('draft-1', 'native-1')
  await c.preroute({ threadId: 'native-1', text: '继续写作' })
  assert.equal(f.requests.at(-1).name, 'theone_preroute')
  assert.deepEqual(f.requests.at(-1).args, { gatewayId: 'native-1', text: '继续写作' })
  const count = f.requests.length
  await c.preroute({ threadId: 'other', text: '别的聊天' }); assert.equal(f.requests.length, count)
  f.host.call = async () => { throw Error('offline') }
  await c.preroute({ threadId: 'native-1', text: '继续写作' }); assert.equal(c.state.error, null)
})

test('routing settings remain separate from history and update failures stay silent', async () => {
  const f = fixture(), c = new DesktopController(f.host), calls = []
  assert.equal(typeof c.routerModels, 'function')
  c.emit({ historyModelSelection: { model: 'history', effort: 'medium', fast: false } })
  f.host.call = async (name, args) => {
    calls.push({ name, args })
    if (name === 'theone_check_updates') throw Error('offline')
    if (name === 'theone_router_models') return { models: [{ model: 'luna', reasoningEfforts: ['low','medium'], defaultEffort: 'low', fastTier: 'priority' }], selection: { model: 'luna', effort: 'low', fast: false } }
    return args.modelSettings
  }
  await c.routerModels(); c.routerSelectModel({ fast: true }); await c.routerSave()
  assert.deepEqual(calls.at(-1), { name: 'theone_router_configure', args: { modelSettings: { model: 'luna', effort: 'low', fast: true } } })
  assert.equal(c.state.historyModelSelection.model, 'history')
  await c.checkUpdates(true); assert.equal(c.state.error, null); assert.equal(c.state.update, null)
})

test('repeated clicks reuse the same unsent native draft instead of clearing it', async () => {
  const f = fixture(), c = new DesktopController(f.host)
  await Promise.all([c.open(), c.open()]); await c.open()
  assert.equal(f.openings.filter(x => x === 'new').length, 1)
  assert.equal(f.saved().clientThreadId, 'draft-1')
  assert.equal(f.requests.filter(x => x.name === 'theone_desktop_bind').length, 0)
})

test('first real send binds the main identity; restarting the controller reopens the same chat', async () => {
  const f = fixture(), c = new DesktopController(f.host)
  await c.open(); f.bindings.set('draft-1', 'native-1'); await c.sync()
  const restarted = new DesktopController(f.host)
  await restarted.open()
  assert.equal(f.saved().threadId, 'native-1')
  assert.equal(f.openings.at(-1), 'native-1')
  assert.equal(f.openings.filter(x => x === 'new').length, 1)
  assert.equal(f.requests.filter(x => x.name === 'theone_desktop_bind').length, 1)
})

test('choosing a topic mounts it and returns to the main chat without submitting a model message', async () => {
  const f = fixture(); f.setSnapshot({ gateway: { gatewayId: 'main', workspace: 'D:/project', enabled: true }, topics: [{ id: 'topic-a', title: '论文' }], activity: [] })
  const c = new DesktopController(f.host)
  await c.selectTopic('topic-a')
  assert.equal(f.openings.at(-1), 'main')
  assert.equal(f.requests.find(x => x.name === 'theone_select_topic').args.topicId, 'topic-a')
  assert.equal(c.getSnapshot().gateway.currentTopicId, 'topic-a')
  assert.ok(!f.requests.some(x => /dispatch|respond/.test(x.name)))
})

test('late metadata does not pull the user back after they leave the opening operation', async () => {
  const f = fixture(); let finish
  f.host.call = () => new Promise(resolve => { finish = resolve })
  const c = new DesktopController(f.host), opening = c.open()
  c.cancelNavigation(); finish({ gateway: { gatewayId: 'main', workspace: 'D:/project' }, topics: [], activity: [] })
  await opening
  assert.deepEqual(f.openings, [])
})

test('a missing main chat shows an error without creating another or discarding the binding', async () => {
  const f = fixture(); f.host.save({ threadId: 'missing', workspace: 'D:/project' }); f.host.readThread = async () => { throw Error('THREAD_NOT_FOUND') }
  const c = new DesktopController(f.host)
  await c.open()
  assert.deepEqual(f.openings, [])
  assert.equal(f.saved().threadId, 'missing')
  assert.match(c.getSnapshot().error, /THREAD_NOT_FOUND/)
})

test('changing settings never broadens permissions as part of opening the main chat', async () => {
  const f = fixture(); f.setSnapshot({ gateway: { gatewayId: 'main', workspace: 'D:/project', sandbox: 'read-only', enabled: true }, topics: [], activity: [] })
  const c = new DesktopController(f.host); await c.open()
  assert.ok(!f.requests.some(x => x.name === 'theone_configure'))
})

test('a topic selected in an unsent main draft survives the client controller restarting', async () => {
  const f = fixture(); f.setSnapshot({ gateway: null, topics: [{ id: 'topic-a', title: '写作' }], activity: [] })
  const c = new DesktopController(f.host); await c.selectTopic('topic-a')
  const restarted = new DesktopController(f.host)
  assert.equal(restarted.getSnapshot().pendingTopicId, 'topic-a')
  f.bindings.set('draft-1', 'native-1'); await restarted.sync()
  assert.equal(f.requests.find(x => x.name === 'theone_desktop_bind').args.topicId, 'topic-a')
})

test('first opening offers history setup; skipping persists and later organizing preserves the native draft', async () => {
  const f = fixture(), c = new DesktopController(f.host), original = f.host.call
  let consent = 'ask'
  f.host.call = async (name,args) => {
    if (name === 'theone_desktop_state') return { gateway: null, topics: [], activity: [], catalog: { available: true, consent } }
    if (name === 'theone_history_consent') { consent = args.consent ? 'granted' : 'declined'; return { consent } }
    return original(name,args)
  }
  await c.open(); assert.equal(c.state.historyPrompt, true)
  await c.historyConsent(false); assert.equal(c.state.historyPrompt, false)
  await c.open(); assert.equal(c.state.historyPrompt, false)
  await c.historyConsent(true); assert.equal(c.state.catalog.consent, 'granted')
  assert.deepEqual(f.openings, ['new'])
})

test('history checkbox responds immediately and rolls back visibly when saving fails', async () => {
  const f = fixture(), c = new DesktopController(f.host)
  c.emit({ historyChoices: { sessions: [{ id: 'old', excluded: false }], folders: [] } })
  let fail
  f.host.call = () => new Promise((_resolve, reject) => { fail = reject })
  const pending = c.historyExclude('session', 'old', true)
  assert.equal(c.state.historyChoices.sessions[0].excluded, true)
  fail(Error('SAVE_FAILED')); await pending
  assert.equal(c.state.historyChoices.sessions[0].excluded, false); assert.equal(c.state.error, 'SAVE_FAILED')
})

test('history setup loads saved model options and sends all three choices on start and later refresh', async () => {
  const f = fixture(), c = new DesktopController(f.host), original = f.host.call
  f.host.call = async (name,args) => {
    if (name === 'theone_history_models') return { models: [
      { model: 'luna', reasoningEfforts: ['low','medium'], defaultEffort: 'medium', fastTier: 'priority' },
      { model: 'basic', reasoningEfforts: ['low'], defaultEffort: 'low', fastTier: null },
    ], selection: { model: 'luna', effort: 'medium', fast: false } }
    return original(name,args)
  }
  assert.equal(typeof c.historyModels, 'function')
  await c.historyModels()
  c.historySelectModel({ fast: true })
  await c.historyConsent(true)
  assert.deepEqual(f.requests.find(r => r.name === 'theone_history_consent').args, { consent: true, modelSettings: { model: 'luna', effort: 'medium', fast: true } })
  c.historySelectModel({ model: 'basic' })
  assert.deepEqual(c.state.historyModelSelection, { model: 'basic', effort: 'low', fast: false })
  await c.historyRefresh()
  assert.deepEqual(f.requests.find(r => r.name === 'theone_history_refresh').args.modelSettings, { model: 'basic', effort: 'low', fast: false })
})

test('model-list errors remain visible inside setup even after background status refresh', async () => {
  const f = fixture(), c = new DesktopController(f.host), original = f.host.call
  f.host.call = async (name,args) => { if (name === 'theone_history_models') throw Error('MODELS_UNAVAILABLE'); return original(name,args) }
  assert.equal(typeof c.historyModels, 'function')
  await c.historyModels(); await c.refresh()
  assert.equal(c.state.historyModelsError, 'MODELS_UNAVAILABLE'); assert.equal(c.state.historyModelOptions, null)
})
