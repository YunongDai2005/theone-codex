import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const DESKTOP_RUNTIME = buildSync({
  entryPoints: [fileURLToPath(new URL('./desktop-ui.mjs', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'TheOneDesktop',
  platform: 'browser', target: 'es2022', legalComments: 'none',
}).outputFiles[0].text
export const DESKTOP_CSS = readFileSync(new URL('./desktop-ui.css', import.meta.url), 'utf8')
