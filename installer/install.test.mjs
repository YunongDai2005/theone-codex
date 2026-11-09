import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const module = await import('./install.mjs').catch(() => ({}))
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'theone-installer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload'), home = join(root, 'home'), local = join(root, 'local')
  const env = { USERPROFILE: home, LOCALAPPDATA: local, CODEX_HOME: join(home, '.codex') }
  for (const [name, value] of Object.entries({
    'theone/plugin.json': JSON.stringify({ name: 'theone', version: '0.1.0' }),
    'theone/.codex-plugin/plugin.json': JSON.stringify({ name: 'theone', version: '0.1.0', mcpServers: './.mcp.json' }),
    'theone/mcp.json': JSON.stringify({ mcpServers: { theone: { command: './node/node.exe', args: ['${PLUGIN_ROOT}/server/main.mjs', 'serve'], cwd: '${PLUGIN_ROOT}' } } }),
    'theone/.mcp.json': JSON.stringify({ mcpServers: { theone: { command: './node/node.exe', args: ['${PLUGIN_ROOT}/server/main.mjs', 'serve'], cwd: '${PLUGIN_ROOT}' } } }),
    'theone/server/main.mjs': '// fixture', 'theone/node/node.exe': 'fixture', 'node/node.exe': 'fixture',
    '.agents/plugins/marketplace.json': JSON.stringify({ name: 'theone-codex', plugins: [{ name: 'theone', source: { source: 'local', path: './theone' } }] }),
    'client-adapter/build.mjs': '// fixture', 'client-adapter/install-launcher.mjs': '// fixture', 'client-adapter/patches.mjs': '// fixture',
    'installer/install.mjs': '// fixture',
  })) { const path = join(payload, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
  const calls = [], messages = [], removedLaunchers = [], installed = new Set(options.legacy ? ['gpt-theone@theone-local'] : []), markets = new Set(options.legacy ? ['theone-local'] : [])
  const deps = {
    env, platform: 'win32', log: message => messages.push(message),
    findCodex: async () => options.missing ? null : { command: 'fake-codex.exe', args: [] },
    run: async (_command, args) => {
      calls.push(args)
      if (options.fail?.(args)) throw new Error('fixture access denied')
      if (args.join(' ') === 'plugin list --json') return JSON.stringify({ installed: [...installed].map(pluginId => ({ pluginId, installed: true, enabled: true, source: { source: 'local', path: join(root, 'legacy-project/release/gpt-theone') } })) })
      if (args.join(' ') === 'plugin marketplace list --json') return JSON.stringify({ marketplaces: [...markets].map(name => ({ name })) })
      if (args[1] === 'remove') { assert.ok(installed.delete(args[2])); return '{}' }
      if (args[1] === 'marketplace' && args[2] === 'remove') { assert.ok(markets.delete(args[3])); return '{}' }
      if (args[1] === 'marketplace' && args[2] === 'add') { await access(join(args[3], '.agents/plugins/marketplace.json')); markets.add('theone-codex'); return '{}' }
      if (args[1] === 'add') { assert.equal(args[2], 'theone@theone-codex'); installed.add(args[2]); return '{}' }
      throw Error('Unexpected CLI request: ' + args.join(' '))
    },
    findDesktop: async () => options.desktop ?? null,
    buildClient: async ({ workspace }) => { const clientApp = join(workspace, '.theone/desktop-client/test/app'); await mkdir(clientApp, { recursive: true }); await writeFile(join(clientApp, 'ChatGPT.exe'), 'fixture'); return { clientApp } },
    installLauncher: async ({ workspace }) => { await writeFile(join(workspace, 'launcher.vbs'), 'fixture'); return { launcher: join(workspace, 'launcher.vbs') } },
    removeLauncher: async state => { removedLaunchers.push(state) },
    confirmDelete: async () => { throw Error('Default uninstall must not prompt') },
  }
  return { root, payload, env, deps, calls, messages, removedLaunchers, installed, markets }
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('missing Codex fails before any configuration or installation mutation', async t => {
  assert.equal(typeof module.install, 'function')
  const f = await fixture(t, { missing: true })
  await assert.rejects(module.install({ payload: f.payload }, f.deps), /Codex.*安装/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(access(join(f.env.LOCALAPPDATA, 'TheOne/install-state.json')))
})

test('legacy uninstall precedes new install and keeps the actual PLUGIN_DATA databases', async t => {
  assert.equal(typeof module.install, 'function')
  const f = await fixture(t, { legacy: true })
  const data = join(f.env.CODEX_HOME, 'plugins/data/agent-plugins/legacy-hash/theone')
  await mkdir(data, { recursive: true }); await writeFile(join(data, 'topics.db'), 'topics and routing')
  const result = await module.install({ payload: f.payload }, f.deps)
  assert.equal(result.dataDir, data)
  assert.equal(await readFile(join(data, 'topics.db'), 'utf8'), 'topics and routing')
  const mutations = f.calls.filter(a => a.includes('remove') || a.includes('add'))
  assert.deepEqual(mutations.map(a => a.slice(0, 3)), [['plugin','remove','gpt-theone@theone-local'], ['plugin','marketplace','remove'], ['plugin','marketplace','add'], ['plugin','add','theone@theone-codex']])
  assert.equal(f.installed.has('gpt-theone@theone-local'), false)
  const config = await readJson(join(result.packageRoot, 'theone/.mcp.json'))
  assert.equal(config.mcpServers.theone.env.THEONE_DATA_DIR, data)
  assert.equal(config.mcpServers.theone.command, './node/node.exe')
  assert.deepEqual(await readJson(join(result.packageRoot, 'theone/mcp.json')), config)
  await access(join(result.packageRoot, 'theone/node/node.exe'))
})

test('home fallback and explicit data overrides survive a renamed install', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t)
    const data = explicit ? join(f.root, 'custom-data') : join(f.env.USERPROFILE, '.gpt-theone')
    await mkdir(data, { recursive: true }); await writeFile(join(data, 'runtime.db'), 'settings')
    if (explicit) f.env.THEONE_DATA_DIR = data
    const result = await module.install({ payload: f.payload }, f.deps)
    assert.equal(result.dataDir, data)
  }
})

test('ambiguous legacy databases stop before uninstall with an actionable data-directory error', async t => {
  const f = await fixture(t, { legacy: true })
  for (const hash of ['one','two']) { const p = join(f.env.CODEX_HOME, 'plugins/data/agent-plugins', hash, 'theone'); await mkdir(p, { recursive: true }); await writeFile(join(p, 'topics.db'), 'topics') }
  await assert.rejects(module.install({ payload: f.payload }, f.deps), /THEONE_DATA_DIR/)
  assert.ok(f.installed.has('gpt-theone@theone-local'))
  assert.equal(f.calls.some(a => a.includes('remove')), false)
})

test('unsupported desktop keeps a verified plugin-only install and explains how to use it', async t => {
  const f = await fixture(t, { desktop: { version: '99.0.0.0', app: 'unused' } })
  f.deps.buildClient = async () => { throw Error('Must not build unsupported desktop') }
  const result = await module.install({ payload: f.payload }, f.deps)
  assert.equal(result.desktop, 'unsupported')
  assert.ok(f.installed.has('theone@theone-codex'))
  assert.match(f.messages.join('\n'), /只安装.*插件/)
  assert.match(f.messages.join('\n'), /重启 Codex/)
})

test('supported desktop builds a local copy and creates the launcher without claiming a live UI test', async t => {
  const f = await fixture(t, { desktop: { version: '26.1103.4239.0', app: 'fixture' } })
  const result = await module.install({ payload: f.payload }, f.deps)
  assert.equal(result.desktop, 'installed')
  await access(join(result.clientApp, 'ChatGPT.exe'))
  assert.equal(result.runtimeLaunchVerified, false)
})

test('uninstall removes only managed payloads and keeps topic data without prompting', async t => {
  const f = await fixture(t)
  const result = await module.install({ payload: f.payload }, f.deps)
  await mkdir(result.dataDir, { recursive: true }); await writeFile(join(result.dataDir, 'topics.db'), 'keep me')
  const outcome = await module.uninstall({}, f.deps)
  assert.equal(outcome.dataPreserved, true)
  assert.equal(await readFile(join(result.dataDir, 'topics.db'), 'utf8'), 'keep me')
  await assert.rejects(access(result.packageRoot))
  assert.equal(f.installed.size, 0); assert.equal(f.markets.size, 0)
  assert.match(f.messages.join('\n'), /保留/)
})

test('reinstall remembers data after legacy removal and refreshes marketplace registration', async t => {
  const f = await fixture(t, { legacy: true })
  const first = await module.install({ payload: f.payload }, f.deps)
  const second = await module.install({ payload: f.payload }, f.deps)
  assert.equal(first.dataDir, second.dataDir)
  assert.notEqual(first.packageRoot, second.packageRoot)
  assert.equal(f.installed.size, 1)
})

test('CLI failure is actionable and cannot be mistaken for success', async t => {
  const f = await fixture(t, { fail: args => args[1] === 'add' })
  await assert.rejects(module.install({ payload: f.payload }, f.deps), /安装插件.*fixture access denied.*重新运行/s)
  assert.equal(f.messages.some(m => m.includes('安装完成')), false)
  assert.ok((await readJson(join(f.env.LOCALAPPDATA, 'TheOne/install-state.json'))).dataDir)
})

test('explicit deletion still requires confirmation and cannot delete an arbitrary parent directory', async t => {
  const f = await fixture(t)
  const result = await module.install({ payload: f.payload }, f.deps)
  await mkdir(result.dataDir, { recursive: true }); await writeFile(join(result.dataDir, 'topics.db'), 'keep me')
  f.deps.confirmDelete = async () => false
  await module.uninstall({ deleteData: true }, f.deps)
  assert.equal(await readFile(join(result.dataDir, 'topics.db'), 'utf8'), 'keep me')
})

test('corrupt payload and cache-local data are rejected before removing the old plugin', async t => {
  const f = await fixture(t, { legacy: true })
  await rm(join(f.payload, 'theone/node/node.exe'))
  await assert.rejects(module.install({ payload: f.payload }, f.deps), /安装包/)
  assert.equal(f.calls.some(a => a.includes('remove')), false)
  await writeFile(join(f.payload, 'theone/node/node.exe'), 'fixture')
  f.env.THEONE_DATA_DIR = join(f.env.CODEX_HOME, 'plugins/cache/theone-local/gpt-theone/data')
  await assert.rejects(module.install({ payload: f.payload }, f.deps), /缓存.*迁出/)
  assert.equal(f.calls.some(a => a.includes('remove')), false)
})

test('desktop build errors retain the installed plugin and a recoverable failure record', async t => {
  const f = await fixture(t, { desktop: { version: '26.1103.4239.0', app: 'fixture' } })
  f.deps.buildClient = async () => { throw Error('fixture renderer hash mismatch') }
  const result = await module.install({ payload: f.payload }, f.deps)
  assert.equal(result.desktop, 'failed')
  assert.ok(f.installed.has('theone@theone-codex'))
  assert.match(result.desktopError, /hash mismatch/)
  assert.match(f.messages.join('\n'), /重新运行安装程序/)
})

test('data is deleted only after an explicit flag and affirmative confirmation', async t => {
  const f = await fixture(t)
  const installed = await module.install({ payload: f.payload }, f.deps)
  await mkdir(installed.dataDir, { recursive: true }); await writeFile(join(installed.dataDir, 'topics.db'), 'user authorized deletion')
  let asked = false
  f.deps.confirmDelete = async path => { assert.equal(path, installed.dataDir); asked = true; return true }
  const result = await module.uninstall({ deleteData: true }, f.deps)
  assert.ok(asked); assert.equal(result.dataPreserved, false)
  await assert.rejects(access(installed.dataDir))
})

test('uninstall refuses a managed-package path outside its root and preserves the directory', async t => {
  const f = await fixture(t)
  const installed = await module.install({ payload: f.payload }, f.deps)
  const statePath = join(f.env.LOCALAPPDATA, 'TheOne/install-state.json')
  const state = await readJson(statePath)
  state.packages = [f.payload]; await writeFile(statePath, JSON.stringify(state))
  await assert.rejects(module.uninstall({}, f.deps), /管理目录之外/)
  await access(f.payload)
})

test('legacy shortcut migration uses the old registered source even after a failed installation is retried', async t => {
  const f = await fixture(t, { legacy: true })
  const originalRun = f.deps.run
  f.deps.run = async (command, args) => { if (args[1] === 'add') throw Error('temporary CLI failure'); return originalRun(command, args) }
  await assert.rejects(module.install({ payload: f.payload }, f.deps), /temporary CLI failure/)
  assert.equal(f.installed.has('gpt-theone@theone-local'), false)
  f.deps.run = originalRun
  const result = await module.install({ payload: f.payload }, f.deps)
  const old = f.removedLaunchers.find(item => item.launcherWorkspace === join(f.root, 'legacy-project'))
  assert.ok(old, 'Old shortcut ownership must survive removal of the legacy plugin')
  assert.equal(old.packageRoot, result.packageRoot, 'Use the new side-effect-free remover, not the old install script')
})
