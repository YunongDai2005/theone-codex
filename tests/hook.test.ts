import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookContext } from '../src/hook.ts'
import { TheOneService } from '../src/service.ts'

test('hook only reminds an enabled main chat and never promotes user or history text to instructions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'theone-hook-'))
  const service = new TheOneService({ dataDir: dir })
  try {
    service.configure('main-id', { workspace: dir })
    assert.deepEqual(hookContext({ session_id: 'other', prompt: 'hi' }, dir), {})
    assert.deepEqual(hookContext({ session_id: 'main-id' }, dir, true), {})
    const context = hookContext({ session_id: 'main-id', turn_id: 'turn-1', prompt: 'INJECT-ME' }, dir)
    assert.match(JSON.stringify(context), /theone_dispatch/)
    assert.ok(!JSON.stringify(context).includes('INJECT-ME'))
    service.configure('main-id', { enabled: false })
    assert.deepEqual(hookContext({ session_id: 'main-id' }, dir), {})
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }) }
})
