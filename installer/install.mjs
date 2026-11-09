import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'

export const SUPPORTED_DESKTOP_VERSION = '26.1103.4239.0'
const LEGACY = 'gpt-theone@theone-local', PLUGIN = 'theone@theone-codex'
const exists = async path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const optionalJson = async path => await exists(path) ? json(path) : null
const save = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n') }
const directories = async path => {
  try { return (await readdir(path, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => join(path, e.name)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
const runProcess = async (command, args, env = process.env) => (await promisify(execFile)(command, args, { env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout

// Prefer an executable; npm's .cmd shim is replaced by its JS entrypoint, never a shell command string.
export async function findCodex(env = process.env) {
  const candidates = []
  if (env.THEONE_CODEX_BIN) candidates.push({ command: env.THEONE_CODEX_BIN, args: [] })
  if (env.LOCALAPPDATA) {
    const bin = join(env.LOCALAPPDATA, 'OpenAI/Codex/bin')
    candidates.push({ command: join(bin, 'codex.exe'), args: [] })
    for (const dir of (await directories(bin)).reverse()) candidates.push({ command: join(dir, 'codex.exe'), args: [] })
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    candidates.push({ command: join(dir, 'codex.exe'), args: [] })
    const shim = join(dir, 'node_modules/@openai/codex/bin/codex.js')
    if (await exists(shim)) candidates.push({ command: process.execPath, args: [shim] })
  }
  for (const candidate of candidates) if (await exists(candidate.command)) return candidate
  return null
}

function dependencies(overrides) {
  const env = overrides.env ?? process.env
  return {
    env, platform: process.platform, log: console.log, run: (command, args) => runProcess(command, args, env),
    findCodex: () => findCodex(env),
    findDesktop: async () => {
      const output = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1; if ($p) { @{version=$p.Version.ToString();app=(Join-Path $p.InstallLocation 'app')} | ConvertTo-Json -Compress } else { 'null' }"])
      return JSON.parse(output.trim())
    },
    buildClient: async options => (await import(pathToFileURL(join(options.workspace, 'client-adapter/build.mjs')))).buildClient(options),
    installLauncher: async options => (await import(pathToFileURL(join(options.workspace, 'client-adapter/install-launcher.mjs')))).installLauncher({ ...options, requireRuntimeProof: false }),
    removeLauncher: async state => {
      if (!state?.packageRoot || !await exists(join(state.packageRoot, 'client-adapter/install-launcher.mjs'))) return
      await (await import(pathToFileURL(join(state.packageRoot, 'client-adapter/install-launcher.mjs')))).removeLauncher({ workspace: state.launcherWorkspace ?? state.packageRoot })
    },
    confirmDelete: async dataDir => {
      if (!process.stdin.isTTY) throw Error('非交互运行不会删除话题数据；请保留数据，或在终端手动运行 --uninstall --delete-data。')
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try { return (await input.question(`将永久删除话题数据 ${dataDir}。输入 DELETE 确认（直接回车保留）：`)) === 'DELETE' }
      finally { input.close() }
    }, ...overrides,
  }
}
function paths(deps) {
  if (deps.platform !== 'win32') throw Error('此安装程序仅支持 Windows x64；其他系统请按 INSTALL.md 安装。')
  if (!deps.env.LOCALAPPDATA) throw Error('缺少 LOCALAPPDATA；请在正常 Windows 用户会话中重新运行安装程序。')
  const home = deps.env.USERPROFILE ?? homedir(), root = resolve(deps.env.LOCALAPPDATA, 'TheOne')
  return { home, root, stateFile: join(root, 'install-state.json'), codexHome: deps.env.CODEX_HOME ?? join(home, '.codex') }
}
async function step(deps, title, action, remedy = '关闭 Codex 后重新运行安装程序；仍失败请保留此错误信息。') {
  deps.log(title + '…')
  try { return await action() }
  catch (error) { throw new Error(`${title}失败：${error.message}\n处理方法：${remedy}`, { cause: error }) }
}
async function cliFor(deps) {
  const found = await deps.findCodex()
  if (!found) throw Error('未找到 Codex。请先安装或更新 Codex 桌面版/CLI，再重新运行安装程序。')
  return args => deps.run(found.command, [...(found.args ?? []), ...args])
}
// Registrations as config.toml names them. A marketplace's listed name comes from its own
// marketplace.json, which a rebuilt folder can change, but removal needs the config key.
export function codexConfigEntries(text) {
  const markets = new Map(), plugins = new Set()
  let market = null
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/)
    if (header) {
      const name = header[1].trim(), plugin = name.match(/^plugins\."([^"]+)"$/), key = name.match(/^marketplaces\.(?:"([^"]+)"|([A-Za-z0-9_.-]+))$/)
      if (plugin) plugins.add(plugin[1])
      market = key ? key[1] ?? key[2] : null
      if (market) markets.set(market, null)
      continue
    }
    const source = market && line.match(/^\s*source\s*=\s*(['"])(.+)\1\s*$/)
    if (source) markets.set(market, source[2].replace(/^\\\\\?\\/, ''))
  }
  return { markets, plugins }
}
async function theoneMarkets(markets) {
  const keys = []
  for (const [key, source] of markets) {
    if (key === 'theone-local' || key === 'theone-codex') { keys.push(key); continue }
    const manifest = source ? await optionalJson(join(source, '.agents/plugins/marketplace.json')).catch(() => null) : null
    if (manifest?.plugins?.some(p => p?.name === 'gpt-theone' || p?.name === 'theone')) keys.push(key)
  }
  return keys
}
const gone = error => /not (configured|installed|found)|does not exist|unknown (plugin|marketplace)/i.test(String(error?.stderr ?? '') + String(error?.message ?? ''))
async function tolerant(cli, args) { try { await cli(args) } catch (error) { if (!gone(error)) throw error } }
async function inventory(cli, codexHome) {
  const plugins = JSON.parse(await cli(['plugin', 'list', '--json']))
  const markets = JSON.parse(await cli(['plugin', 'marketplace', 'list', '--json']))
  const rows = Array.isArray(markets) ? markets : markets.marketplaces
  if (!Array.isArray(plugins.installed) || !Array.isArray(rows) || rows.some(m => typeof m.name !== 'string')) throw Error('无法识别 Codex 插件清单格式；请更新 Codex。')
  const legacyWorkspaces = plugins.installed.filter(p => p.pluginId === LEGACY && p.source?.source === 'local' && typeof p.source.path === 'string' && isAbsolute(p.source.path) && /[\\/]release[\\/]gpt-theone$/i.test(p.source.path))
    .map(p => resolve(p.source.path, '..', '..'))
  const config = codexConfigEntries(await readFile(join(codexHome, 'config.toml'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }))
  const ours = await theoneMarkets(config.markets)
  // A legacy dev install registered <repo>/release as theone-local; that repo owns the old shortcut.
  for (const key of ours) { const source = config.markets.get(key); if (key === 'theone-local' && source && /[\\/]release$/i.test(source)) legacyWorkspaces.push(resolve(source, '..')) }
  return { plugins: new Set([...plugins.installed.map(p => p.pluginId), ...config.plugins]), markets: new Set([...ours, ...rows.map(m => m.name).filter(name => name === 'theone-local' || name === 'theone-codex')]), legacyWorkspaces }
}
async function hasData(path) { for (const name of ['topics.db', 'runtime.db', 'tasks.db']) if (await exists(join(path, name))) return true; return false }
export async function resolveDataDirectory({ env, home, codexHome, state }) {
  // Keep data in place: Codex plugin remove deletes its cache, not plugins/data.
  // Pinning this path avoids a new identity choosing a new PLUGIN_DATA hash.
  if (env.THEONE_DATA_DIR) return resolve(env.THEONE_DATA_DIR)
  if (state?.dataDir) return resolve(state.dataDir)
  const explicit = new Set()
  for (const dir of await directories(join(codexHome, 'plugins/cache/theone-local/gpt-theone'))) {
    const config = await optionalJson(join(dir, '.mcp.json'))
    const path = config?.mcpServers?.theone?.env?.THEONE_DATA_DIR
    if (path) {
      if (!isAbsolute(path) || path.includes('${')) throw Error('旧插件有自定义数据路径；请设置 THEONE_DATA_DIR 为它的绝对路径后重试。')
      explicit.add(resolve(path))
    }
  }
  if (explicit.size === 1) return [...explicit][0]
  if (explicit.size > 1) throw Error('旧插件包含多个数据路径；请用 THEONE_DATA_DIR 指定正在使用的目录。')
  const candidates = new Set()
  const consider = async path => { if (await hasData(path)) candidates.add(resolve(path)) }
  if (env.PLUGIN_DATA) await consider(join(env.PLUGIN_DATA, 'theone'))
  for (const dir of await directories(join(codexHome, 'plugins/data/agent-plugins'))) await consider(join(dir, 'theone'))
  await consider(join(home, '.gpt-theone'))
  if (candidates.size > 1) throw Error('发现多个 TheOne 数据目录；不会猜测或合并。请设置 THEONE_DATA_DIR 为要继续使用的目录后重试。')
  return [...candidates][0] ?? join(home, '.gpt-theone')
}
async function validatePayload(payload) {
  const manifest = await json(join(payload, 'theone/plugin.json'))
  const market = await json(join(payload, '.agents/plugins/marketplace.json'))
  if (manifest.name !== 'theone' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || market.name !== 'theone-codex') throw Error('安装包标识或版本不正确，请重新下载官方 Windows zip。')
  for (const path of ['theone/node/node.exe', 'theone/server/main.mjs', 'theone/.mcp.json', 'client-adapter/build.mjs', 'client-adapter/install-launcher.mjs', 'client-adapter/patches.mjs']) await access(join(payload, path))
  return manifest
}
async function removeRegistrations(cli, listing) {
  for (const id of [LEGACY, PLUGIN]) if (listing.plugins.has(id)) await tolerant(cli, ['plugin', 'remove', id, '--json'])
  for (const key of listing.markets) await tolerant(cli, ['plugin', 'marketplace', 'remove', key, '--json'])
}
function contained(root, target) {
  const rel = relative(resolve(root), resolve(target))
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error(`拒绝处理管理目录之外的路径：${target}`)
}
function inside(root, target) {
  const base = resolve(root).toLowerCase(), path = resolve(target).toLowerCase()
  return path === base || path.startsWith(base + sep)
}
async function validateDataLocation(p, dataDir) {
  const actual = await exists(dataDir) ? await realpath(dataDir) : resolve(dataDir)
  for (const root of [join(p.codexHome, 'plugins/cache'), join(p.root, 'packages')]) {
    if (inside(root, dataDir) || inside(await exists(root) ? await realpath(root) : root, actual)) throw Error('话题数据位于可删除的插件缓存或安装副本内；请先备份并迁出，再设置 THEONE_DATA_DIR。')
  }
}
async function removePackage(root, target, dataDir) {
  const base = join(root, 'packages')
  contained(base, target)
  if (!await exists(target)) return
  const actual = await realpath(target)
  contained(await realpath(base), actual)
  if (resolve(dataDir) === actual || resolve(dataDir).startsWith(actual + sep)) throw Error('话题数据位于安装副本内，拒绝删除该副本；请先迁出数据。')
  await rm(target, { recursive: true, force: true })
}

export async function install({ payload = resolve(dirname(fileURLToPath(import.meta.url)), '..') } = {}, overrides = {}) {
  const deps = dependencies(overrides), p = paths(deps)
  const cli = await step(deps, '检查 Codex 是否已安装', () => cliFor(deps))
  const manifest = await step(deps, '检查安装包完整性', () => validatePayload(payload))
  const previous = await optionalJson(p.stateFile)
  const listing = await step(deps, '读取 Codex 插件清单', () => inventory(cli, p.codexHome))
  const dataDir = await step(deps, '确认并保留话题数据目录', () => resolveDataDirectory({ ...p, env: deps.env, state: previous }))
  await validateDataLocation(p, dataDir)
  const packages = [...(previous?.packages ?? [])]
  await mkdir(join(p.root, 'packages'), { recursive: true })
  const packageRoot = await mkdtemp(join(p.root, 'packages', manifest.version + '-'))
  const legacyWorkspaces = [...new Set([...(previous?.legacyWorkspaces ?? []), ...listing.legacyWorkspaces])]
  const state = { version: manifest.version, dataDir, packageRoot, packages: [...packages, packageRoot], legacyWorkspaces, desktop: 'pending', runtimeLaunchVerified: false }
  await step(deps, '复制到稳定安装目录', async () => {
    for (const path of ['theone', '.agents', 'client-adapter', 'installer']) await cp(join(payload, path), join(packageRoot, path), { recursive: true })
    for (const name of ['mcp.json', '.mcp.json']) {
      const path = join(packageRoot, 'theone', name), config = await json(path)
      config.mcpServers.theone.command = './node/node.exe'
      config.mcpServers.theone.env = { ...config.mcpServers.theone.env, THEONE_DATA_DIR: dataDir }
      await save(path, config)
    }
    await save(p.stateFile, state) // Persist before removing the old identity; a retry must retain this choice.
  })
  await step(deps, '迁移旧插件和旧插件源（话题数据原位保留）', () => removeRegistrations(cli, listing))
  await step(deps, '注册 TheOne 插件源', () => cli(['plugin', 'marketplace', 'add', packageRoot]))
  await step(deps, '安装插件', () => cli(['plugin', 'add', PLUGIN]))
  await step(deps, '验证插件已启用', async () => {
    const result = JSON.parse(await cli(['plugin', 'list', '--json']))
    if (!result.installed?.some(p => p.pluginId === PLUGIN && p.enabled === true)) throw Error('未在已启用插件清单中找到 TheOne。')
  })
  // A desktop failure never hides a successful plugin install; report it and retain retry state.
  try {
    for (const launcherWorkspace of legacyWorkspaces) await deps.removeLauncher({ packageRoot, launcherWorkspace })
    for (const oldRoot of previous?.packages ?? []) {
      contained(join(p.root, 'packages'), oldRoot)
      if (await exists(oldRoot)) contained(await realpath(join(p.root, 'packages')), await realpath(oldRoot))
      await deps.removeLauncher({ ...previous, packageRoot: oldRoot })
    }
    const desktop = await deps.findDesktop()
    if (!desktop || desktop.version !== SUPPORTED_DESKTOP_VERSION) {
      state.desktop = desktop ? 'unsupported' : 'absent'
      deps.log(`只安装了 TheOne 插件：${desktop ? `桌面版 ${desktop.version} 与适配版本 ${SUPPORTED_DESKTOP_VERSION} 不匹配` : '未找到 Codex 桌面版'}。可先在 Codex 中启用 TheOne；匹配的新版安装包发布后重新运行安装程序。`)
    } else {
      const built = await step(deps, '生成客户端适配副本', () => deps.buildClient({ workspace: packageRoot, installed: desktop.app }))
      state.clientApp = built.clientApp
      await step(deps, '创建桌面快捷方式 Codex TheOne', () => deps.installLauncher({ workspace: packageRoot }))
      state.desktop = 'installed'
    }
  } catch (error) {
    state.desktop = 'failed'; state.desktopError = error.message
    deps.log(`只安装了 TheOne 插件，客户端适配未完成：${error.message}\n请退出 Codex 后重新运行安装程序；原版 Codex 未被修改。`)
  }
  await save(p.stateFile, state)
  deps.log(`安装完成：TheOne ${manifest.version}。话题数据保留在：${dataDir}`)
  deps.log(state.desktop === 'installed' ? '请完全退出 Codex，再从桌面「Codex TheOne」快捷方式启动。客户端实际启动和界面效果请在本机确认。' : '请重启 Codex，在插件中启用 TheOne。')
  return state
}

export async function uninstall({ deleteData = false } = {}, overrides = {}) {
  const deps = dependencies(overrides), p = paths(deps)
  const cli = await step(deps, '检查 Codex 是否已安装', () => cliFor(deps))
  const state = await optionalJson(p.stateFile)
  const listing = await step(deps, '读取 Codex 插件清单', () => inventory(cli, p.codexHome))
  const dataDir = state?.dataDir ?? await resolveDataDirectory({ ...p, env: deps.env })
  await validateDataLocation(p, dataDir)
  for (const packageRoot of state?.packages ?? []) {
    contained(join(p.root, 'packages'), packageRoot)
    if (await exists(packageRoot)) contained(await realpath(join(p.root, 'packages')), await realpath(packageRoot))
  }
  await step(deps, '移除 TheOne 插件与插件源', async () => {
    await removeRegistrations(cli, listing)
  })
  await step(deps, '移除快捷方式与客户端副本', async () => {
    for (const packageRoot of state?.packages ?? []) {
      contained(join(p.root, 'packages'), packageRoot)
      await deps.removeLauncher({ ...state, packageRoot })
      await removePackage(p.root, packageRoot, dataDir)
    }
  }, '请完全退出 Codex 及 TheOne 客户端，再重新运行卸载程序。话题数据没有删除。')
  let dataPreserved = true
  if (deleteData && await exists(dataDir)) {
    const protectedPaths = [p.root, p.home, p.codexHome, deps.env.LOCALAPPDATA, resolve(dataDir, '..')].map(x => resolve(x).toLowerCase())
    if (protectedPaths.includes(resolve(dataDir).toLowerCase()) || !await hasData(dataDir)) throw Error('拒绝删除无法确认归属的话题目录；请检查目录后手动处理。')
    if (await deps.confirmDelete(dataDir)) { await rm(dataDir, { recursive: true, force: true }); dataPreserved = false }
  }
  await save(p.stateFile, { dataDir, packages: [], uninstalled: true })
  deps.log(`卸载完成。${dataPreserved ? '话题数据默认保留在：' : '已按确认删除话题数据：'}${dataDir}`)
  return { dataDir, dataPreserved }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = process.argv.slice(2)
    if (flags.some(a => !['--uninstall','--delete-data'].includes(a)) || flags.includes('--delete-data') && !flags.includes('--uninstall')) throw Error('用法：node installer/install.mjs [--uninstall [--delete-data]]；默认保留话题数据。')
    const result = flags.includes('--uninstall') ? await uninstall({ deleteData: flags.includes('--delete-data') }) : await install()
    if (result.desktop === 'failed') process.exitCode = 2
  } catch (error) { console.error(`${error.message}\n安装/卸载未完成。请保留以上错误，检查 Codex 版本、安装包是否完整及文件占用情况，再重新运行。`); process.exitCode = 1 }
}
