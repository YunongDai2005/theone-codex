import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export function buildSync(options) {
  assert.deepEqual(options, { entryPoints: [fileURLToPath(new URL('../../client-adapter/desktop-ui.mjs', import.meta.url))],
    bundle: true, write: false, format: 'iife', globalName: 'TheOneDesktop', platform: 'browser', target: 'es2022', legalComments: 'none' })
  return { outputFiles: [{ text: readFileSync(process.env.THEONE_TEST_DESKTOP_BUNDLE, 'utf8') }] }
}
export function transformSync(source, options) {
  assert.equal(source, readFileSync(new URL('../../client-adapter/dsh-cell.ts', import.meta.url), 'utf8'))
  assert.deepEqual(options, { loader: 'ts', target: 'es2022' })
  return { code: readFileSync(process.env.THEONE_TEST_CELL_BUNDLE, 'utf8') }
}
