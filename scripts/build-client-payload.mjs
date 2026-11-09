import { build } from 'esbuild'
import { mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { BRAND_CSS, CELL_COMPONENT } from '../client-adapter/brand.mjs'
import { DESKTOP_RUNTIME, DESKTOP_CSS } from '../client-adapter/desktop-runtime.mjs'

// Compile JS/CSS on the build machine. The installer needs only portable Node,
// archive.mjs and this bundle; no npm/esbuild or Codex desktop is needed in CI.
const destination = resolve('release/client-adapter')
await mkdir(destination, { recursive: true })
await build({ stdin: { contents: "export { patchRenderer, RENDERER_PATH, ADAPTER_VERSION } from './client-adapter/renderer-patch.mjs'; export { patchSendRenderer, SEND_RENDERER_PATH } from './client-adapter/send-patch.mjs'", resolveDir: resolve('.') },
  outfile: join(destination, 'patches.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm',
  plugins: [{ name: 'precompiled-desktop-assets', setup(builder) {
    builder.onLoad({ filter: /[\\/]client-adapter[\\/](brand|desktop-runtime)\.mjs$/ }, ({ path }) => {
      const values = path.endsWith('brand.mjs') ? { BRAND_CSS, CELL_COMPONENT } : { DESKTOP_RUNTIME, DESKTOP_CSS }
      return { contents: Object.entries(values).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`).join('\n'), loader: 'js' }
    })
  } }], legalComments: 'external' })
for (const file of ['build.mjs', 'install-launcher.mjs', 'archive.mjs']) await copyFile(join('client-adapter', file), join(destination, file))
await writeFile(join(destination, 'compatibility.json'), JSON.stringify({ desktopVersion: '26.1103.4239.0', runtimeLaunchVerified: false }, null, 2) + '\n')
console.log('Client adapter payload built; desktop copy will be generated at install time.')
