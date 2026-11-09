import test from 'node:test'
import assert from 'node:assert/strict'
const mod = await import('../scripts/release-metadata.mjs').catch(() => ({}))

test('release output reports the package version in status, doctor, MCP and update baseline', async () => {
  assert.equal(typeof mod.releaseSource, 'function')
  const source = `class ReleaseChecker { constructor(version) { this.version = version } }
    export const status = () => ({ version: '0.1.0-alpha.9' });
    export const checker = new ReleaseChecker('0.1.0-alpha.9');
    export const info = { name: 'gpt-theone', version: '0.1.0-alpha.9' };
    export const protocol = { version: 1, source: 'gpt-theone' };`
  const result = await import('data:text/javascript,' + encodeURIComponent(mod.releaseSource(source, '0.1.0')))
  assert.equal(result.status().version, '0.1.0')
  assert.equal(result.checker.version, '0.1.0')
  assert.equal(result.info.name, 'theone')
  assert.equal(result.protocol.version, 1)
  assert.equal(result.protocol.source, 'gpt-theone')
})

test('license collection includes dependencies resolved through a worktree node_modules junction', () => {
  assert.equal(typeof mod.dependencyInputs, 'function')
  assert.deepEqual(mod.dependencyInputs({ 'src/main.ts': {}, 'node_modules/zod/index.js': {}, '../gpt-theone/node_modules/zod/v3/types.js': {}, 'C:\\shared\\node_modules\\sdk\\index.js': {} }), ['node_modules/zod/index.js', '../gpt-theone/node_modules/zod/v3/types.js', 'C:\\shared\\node_modules\\sdk\\index.js'])
})
