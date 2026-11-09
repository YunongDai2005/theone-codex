import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readArchiveFile } from '../client-adapter/archive.mjs'

// Legacy scripts perform real installation on import; never import them until
// they expose the side-effect-free API that this test needs.
const safeImport = async (name, api) => (await readFile(new URL(name, import.meta.url), 'utf8')).includes(`export async function ${api}`) ? import(name) : {}
const builder = await safeImport('../client-adapter/build.mjs', 'buildClient')
const launcher = await safeImport('../client-adapter/install-launcher.mjs', 'installLauncher')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'theone-client-')); t.after(() => rm(root, { recursive: true, force: true }))
  const installed = join(root, 'original'), workspace = join(root, 'managed')
  await mkdir(join(installed, 'resources'), { recursive: true })
  const data = Buffer.from('navsend'), json = Buffer.from(JSON.stringify({ files: { 'nav.js': { size: 3, offset: '0' }, 'send.js': { size: 4, offset: '3' } } }))
  const aligned = Math.ceil(json.length / 4) * 4, header = Buffer.alloc(aligned + 16)
  header.writeUInt32LE(4, 0); header.writeUInt32LE(aligned + 8, 4); header.writeUInt32LE(aligned + 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16)
  const archive = Buffer.concat([header, data]); await writeFile(join(installed, 'resources/app.asar'), archive)
  const hash = createHash('sha256').update(json).digest('hex')
  const exe = Buffer.from('MZ' + JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }]))
  await writeFile(join(installed, 'ChatGPT.exe'), exe)
  const patches = { RENDERER_PATH: 'nav.js', SEND_RENDERER_PATH: 'send.js', ADAPTER_VERSION: 'test', patchRenderer: text => text + '-patched', patchSendRenderer: text => text + '-patched' }
  return { installed, workspace, archive, exe, patches }
}
test('packaged adapter creates an isolated client, preserves originals and verifies rewritten archive', async t => {
  assert.equal(typeof builder.buildClient, 'function')
  const f = await fixture(t), report = await builder.buildClient(f)
  assert.deepEqual(await readFile(join(f.installed, 'ChatGPT.exe')), f.exe)
  assert.deepEqual(await readFile(join(f.installed, 'resources/app.asar')), f.archive)
  assert.equal(readArchiveFile(join(report.clientApp, 'resources/app.asar'), 'nav.js').toString(), 'nav-patched')
  assert.equal(report.runtimeLaunchVerified, false)
  await assert.rejects(builder.buildClient(f), /already exists/)
})
test('renderer mismatch fails before a desktop copy is created', async t => {
  assert.equal(typeof builder.buildClient, 'function')
  const f = await fixture(t); f.patches.patchRenderer = () => { throw Error('SHA-256 mismatch') }
  await assert.rejects(builder.buildClient(f), /mismatch/)
  await assert.rejects(access(f.workspace))
})
test('installer launcher mode skips development proof file, records no live acceptance and preserves quoted paths', async t => {
  assert.equal(typeof launcher.installLauncher, 'function')
  const f = await fixture(t); await builder.buildClient(f)
  const calls = []
  const result = await launcher.installLauncher({ workspace: f.workspace, requireRuntimeProof: false, run: (_command, args) => { calls.push(args); return JSON.stringify({ shortcut: join(f.workspace, 'desktop/Codex TheOne.lnk') }) } })
  assert.equal(result.launched, false)
  assert.equal(calls.length, 1)
  const vbs = await readFile(result.launcher)
  assert.equal(vbs.readUInt16LE(0), 0xfeff)
  assert.match(vbs.toString('utf16le'), /ChatGPT.exe/)
  await assert.rejects(launcher.installLauncher({ workspace: f.workspace }), /ENOENT/)
})
