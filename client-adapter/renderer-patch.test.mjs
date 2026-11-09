import test from 'node:test'
import assert from 'node:assert/strict'
import { openSync, readSync, closeSync } from 'node:fs'
import vm from 'node:vm'
import { patchRenderer } from './renderer-patch.mjs'
import { PLUGIN_MENTION } from './native-host.mjs'

// Exercise the actual installed navigation component, not a recreation of its layout.
const archive = process.env.THEONE_TEST_ASAR ?? 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0/app/resources/app.asar'
function installedSource() {
  const fd = openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16); readSync(fd, prefix, 0, 16, 0)
    const json = Buffer.alloc(prefix.readUInt32LE(12)); readSync(fd, json, 0, json.length, 16)
    let entry = JSON.parse(json)
    for (const part of 'webview/assets/async/499225.6d2e47bea2.js'.split('/')) entry = entry.files[part]
    const data = Buffer.alloc(entry.size); readSync(fd, data, 0, data.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset))
    return data.toString()
  } finally { closeSync(fd) }
}
const source = installedSource()
function component(source, name, next) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const end = source.indexOf(`function ${next}(`, start + 1)
  assert.ok(end > start, `Missing boundary after ${name}`)
  return source.slice(start, end)
}
function render(source, sidebarMode = 'codex', layout = 'standard', projectFlow = false) {
  const requests = [], scope = { identity: 'existing-native-app-scope', get: () => true }
  const preview = { project: { id: 'existing-project' }, sidebarProductMode: 'codex' }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props })
  const context = {
    i: { c: size => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) },
    r: { jsx, jsxs: jsx }, l: { gh: () => scope }, A: { u: 'app-scope' },
    c: { Fragment: 'fragment', useContext: () => ({ previewNavigationState: preview }), useRef: () => ({ current: null }), useEffect: () => {}, createElement: (type, props, ...children) => jsx(type, { ...props, children }) }, cq: { I: 'navigation-context' },
    n: () => ({}),
    // Controller/host behavior has separate tests. Here exercise the actual host's two
    // project-aware entry callbacks and both installed navigation layouts.
    TheOneDesktop: { useDesktop: ({ startDraft }) => ({ active: false, subtitle: '从这里继续聊', controls: null,
      open: () => startDraft({ ...preview, codexAppMode: 'codex', selectChat: true, freshDraft: true, prefillPrompt: PLUGIN_MENTION, prefillPromptFormat: 'markdown' }, () => {}) }) },
    d: { zy: () => ({ state: {} }) },
    aB: { startNewConversation: (actualScope, request) => requests.push({ scope: actualScope, request }) },
    a$: { ub: (actualScope, options) => {
      assert.equal(actualScope, scope)
      if (projectFlow) options.startNewConversationInProject(preview.project)
      else options.startNewConversation({ activeProject: preview.project })
    } },
    dt: { T$: 'projectless-allowed', Lk: 'local-project-actions' }, tF: { oN: 'active-thread-key' },
    dx: { E: (actualScope, project, request) => requests.push({ scope: actualScope, project, request }) },
    s1: { c0: 'native-section', jl: 'native-navigation-row' },
    sO: { sR: 'native-section' },
    nO: { JSV: 'native-new-chat-icon' },
    dE: () => ({ type: 'native-new-chat', props: { label: '新聊天' } }),
    dM: ({ item }) => ({ type: 'native-destination', props: item }),
    dF: ({ item }) => ({ type: 'native-destination', props: item }),
    ov: ({ children }) => children, o_: { X: () => ({ type: 'native-search' }) },
  }
  const navigation = layout === 'rail' ? source.slice(source.indexOf('function d$(e){'), source.indexOf('(0,tX._)(async()=>()=>null);', source.indexOf('function d$(e){'))) : component(source, 'dT', 'dE')
  const brandStart = source.indexOf('const TheOneCellSymbol=')
  const brand = brandStart < 0 ? '' : source.slice(brandStart, source.indexOf('var TheOneDesktop', brandStart))
  const code = brand + component(source, 'TheOneClientEntry', 'dT') + navigation
  const nativeSection = vm.runInNewContext(`(()=>{${code};return ${layout === 'rail' ? 'd$' : 'dT'}})()`, context)
  const tree = nativeSection({ sidebarMode, orbitDestination: { label: '你的 dot' }, leadingContent: { type: 'existing-leading' }, leadingDestination: { label: '你的 dot' }, trailingContent: { type: 'existing-trailing' }, showSearchNavItem: true })
  const flatten = nodes => nodes.filter(Boolean).flatMap(node => node.type === 'fragment' ? flatten(node.props.children) : [node])
  return { children: flatten(tree.props.children), requests, scope, preview }
}

test('adds one native TheOne row immediately below New chat without replacing the remaining controls', () => {
  const before = render(source), after = render(patchRenderer(source))
  assert.equal(after.children[0].type, 'native-new-chat')
  assert.equal(after.children[1].props?.['aria-label'], 'TheOne')
  assert.equal(after.children[1].type, 'native-navigation-row')
  assert.equal(after.children.filter(x => x.props?.['aria-label'] === 'TheOne').length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(after.children.slice(2))), JSON.parse(JSON.stringify(before.children.slice(1))))
  assert.equal(after.requests.length, 0, 'Rendering the button must not create or send a chat')
})

test('click opens an editable native Codex draft with the installed plugin mention and current project', () => {
  const { children, requests, scope, preview } = render(patchRenderer(source))
  const row = children.find(x => x.props?.['aria-label'] === 'TheOne')
  assert.ok(row, 'TheOne native action is missing')
  row.props.onClick()
  assert.equal(requests.length, 1)
  const { request, scope: actualScope } = requests[0]
  assert.equal(actualScope, scope)
  assert.equal(request.project, preview.project)
  assert.equal(request.codexAppMode, 'codex')
  assert.equal(request.selectChat, true)
  assert.equal(request.freshDraft, true)
  assert.match(request.prefillPrompt, /\[@TheOne\]\(plugin:\/\/theone@theone-codex\)/)
  assert.equal(request.prefillPromptFormat, 'markdown')
  assert.equal(request.autoSubmit, undefined)
  assert.equal(request.send, undefined)
  assert.equal(request.approvalPolicy, undefined)
  assert.equal(request.sandbox, undefined)
})

test('leaves the ChatGPT sidebar untouched', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(render(patchRenderer(source), 'chatgpt').children)), JSON.parse(JSON.stringify(render(source, 'chatgpt').children)))
})

test('refuses an unknown client build and repeated patching', () => {
  assert.throws(() => patchRenderer(source + '\n'), /unsupported|mismatch/i)
  assert.throws(() => patchRenderer(patchRenderer(source)), /already|unsupported|mismatch/i)
})

test('adds TheOne between New chat and Your Dot in the navigation-rail layout used on this desktop', () => {
  const { children } = render(patchRenderer(source), 'codex', 'rail')
  assert.equal(children[0].type, 'native-new-chat')
  assert.equal(children[1].props?.['aria-label'], 'TheOne')
  assert.equal(children[2].props?.label, '你的 dot')
  assert.equal(children.length, 3)
  assert.deepEqual(JSON.parse(JSON.stringify(render(patchRenderer(source), 'chatgpt', 'rail').children)), JSON.parse(JSON.stringify(render(source, 'chatgpt', 'rail').children)))
})

test('retains the selected project when native navigation chooses the project-specific flow', () => {
  const { children, requests, preview, scope } = render(patchRenderer(source), 'codex', 'rail', true)
  const row = children.find(x => x.props?.['aria-label'] === 'TheOne')
  assert.ok(row, 'TheOne is missing from the actual desktop navigation layout')
  row.props.onClick()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].scope, scope)
  assert.equal(requests[0].project, preview.project)
  assert.equal(requests[0].request.codexAppMode, 'codex')
  assert.match(requests[0].request.prefillPrompt, /plugin:\/\/theone@theone-codex/)
})
