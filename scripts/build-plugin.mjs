import { build } from 'esbuild'
import { cp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve('release'), destination = join(root, 'gpt-theone')
await mkdir(destination, { recursive: true })
await cp('plugin', destination, { recursive: true })
await mkdir(join(destination, 'server'), { recursive: true })
await mkdir(join(destination, 'ui'), { recursive: true })
await copyFile('ui/theone.html', join(destination, 'ui/theone.html'))
const built = await build({ entryPoints: ['src/main.ts'], outfile: join(destination, 'server/main.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }, legalComments: 'external' })
await copyFile('plugin/mcp.json', join(destination, '.mcp.json'))
await copyFile('LICENSE', join(destination, 'LICENSE'))
await copyFile('UPSTREAM.md', join(destination, 'UPSTREAM.md'))
const dependencies = new Map()
const uiMetafile = JSON.parse(await readFile('.theone/ui-metafile.json', 'utf8'))
for (const file of Object.keys({ ...built.metafile.inputs, ...uiMetafile.inputs }).filter(p => p.startsWith('node_modules/'))) {
  let folder = dirname(resolve(file))
  while (folder !== dirname(folder)) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) } catch {}
    if (manifest?.name) { dependencies.set(`${manifest.name}@${manifest.version}`, { folder, manifest }); break }
    folder = dirname(folder)
  }
}
const notices = ['Bundled third-party dependencies. TheOne upstream attribution is in UPSTREAM.md and LICENSE.']
for (const [name, { folder, manifest }] of [...dependencies].sort()) {
  let license = ''
  for (const filename of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','LICENCE','COPYING']) {
    try { license = await readFile(join(folder, filename), 'utf8'); break } catch {}
  }
  if (!license) throw new Error(`Missing bundled dependency license: ${name}`)
  notices.push(`\n${name} (${manifest.license ?? 'see below'})\n${license.trim()}\n`)
}
await writeFile(join(destination, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'))
await mkdir(join(root, '.agents/plugins'), { recursive: true })
await writeFile(join(root, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'theone-local', interface: { displayName: 'TheOne Local' }, plugins: [{ name: 'gpt-theone', source: { source: 'local', path: './gpt-theone' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2) + '\n')
const main = await readFile(join(destination, 'server/main.mjs'))
console.log(JSON.stringify({ package: destination, serverBytes: main.length, sha256: createHash('sha256').update(main).digest('hex') }))
