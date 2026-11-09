import { build } from 'esbuild'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const built = await build({ entryPoints: ['ui/app.ts'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, minify: true, metafile: true, legalComments: 'inline' })
const template = await readFile('ui/index.html', 'utf8')
const css = await readFile('ui/style.css', 'utf8')
const script = built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
await writeFile('ui/theone.html', template.replace('/* THEONE_STYLE */', () => css).replace('/* THEONE_SCRIPT */', () => script))
await mkdir('.theone', { recursive: true })
await writeFile('.theone/ui-metafile.json', JSON.stringify(built.metafile))
console.log(`TheOne UI built (${Buffer.byteLength(script)} script bytes)`)
