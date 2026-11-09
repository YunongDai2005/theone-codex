import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readArchiveFile, rewriteArchive, updateIntegrityResource } from './archive.mjs'
import { patchRenderer, RENDERER_PATH, ADAPTER_VERSION } from './renderer-patch.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installed = 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0/app'
const destination = join(workspace, '.theone', 'desktop-client', `26.1103.4239.0-theone-${ADAPTER_VERSION}`, 'app')
const sourceArchive = join(installed, 'resources', 'app.asar')
const sourceExe = join(installed, 'ChatGPT.exe')
const sha = data => createHash('sha256').update(data).digest('hex')

// Fail before copying anything when the installed renderer does not match this adapter.
const originalRenderer = readArchiveFile(sourceArchive, RENDERER_PATH)
const patchedRenderer = Buffer.from(patchRenderer(originalRenderer.toString()))
const executable = await readFile(sourceExe)
const originalExecutableHash = sha(executable)
try { await access(destination); throw new Error('Destination already exists; refusing to overwrite a client') }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (!destination.startsWith(join(workspace, '.theone', 'desktop-client') + '\\')) throw new Error('Client destination escaped workspace')
await mkdir(dirname(destination), { recursive: true })
console.log('Copying the installed runtime into an isolated local client…')
await cp(installed, destination, {
  recursive: true, errorOnExist: true, force: false,
  filter: path => relative(installed, path).replaceAll('\\', '/') !== 'resources/app.asar',
})
console.log('Building the adapted archive and preserving ASAR integrity checks…')
const archive = rewriteArchive(sourceArchive, join(destination, 'resources', 'app.asar'), new Map([[RENDERER_PATH, patchedRenderer]]))
const patchedExe = updateIntegrityResource(executable, archive.originalHeaderHash, archive.headerHash)
await writeFile(join(destination, 'ChatGPT.exe'), patchedExe)
if (sha(await readFile(sourceExe)) !== originalExecutableHash) throw new Error('Original executable changed during build')
if (!readArchiveFile(sourceArchive, RENDERER_PATH).equals(originalRenderer)) throw new Error('Original renderer changed during build')
if (!readArchiveFile(join(destination, 'resources', 'app.asar'), RENDERER_PATH).equals(patchedRenderer)) throw new Error('Adapted renderer readback failed')
const report = {
  builtAt: new Date().toISOString(), adapterVersion: ADAPTER_VERSION,
  sourceApp: installed, clientApp: destination, originalClientPreserved: true,
  executable: { sourceSha256: originalExecutableHash, adaptedSha256: sha(patchedExe), changedResource: 'ASAR integrity root hash', localModifiedBuild: true },
  archive, rendererSha256: sha(patchedRenderer), runtimeSecurityFlagsChanged: false,
  uiPlacement: 'TheOne immediately after the native New chat row, Codex sidebar only',
  action: 'persistent native main draft/chat; unchanged DSH 0.4.6 topic cells and gestures; native MCP topic controls; no automatic send',
  runtimeLaunchVerified: false, desktopVisualVerified: false,
}
await writeFile(join(dirname(destination), 'build.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(join(workspace, 'evidence', 'client-adapter-build.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(join(dirname(destination), 'renderer-check.mjs'), patchedRenderer)
console.log(JSON.stringify({ clientApp: destination, archiveHeaderHash: archive.headerHash, originalClientPreserved: true }))
