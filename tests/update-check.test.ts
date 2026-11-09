import test from 'node:test'
import assert from 'node:assert/strict'

test('release checks use only the public repository, omit credentials, and return an inert update command', async () => {
  const mod = await import('../src/update-check.ts').catch(() => ({} as any))
  assert.equal(typeof mod.ReleaseChecker, 'function')
  const requests: any[] = [], checker = new mod.ReleaseChecker('0.1.0-alpha.9', async (url: string, init: RequestInit) => {
    requests.push({ url, init }); return new Response(JSON.stringify({ tag_name: 'v0.1.0', draft: false }))
  })
  const update = await checker.check()
  assert.equal(update.version, '0.1.0'); assert.match(update.command, /重新运行安装程序/)
  assert.equal(requests[0].url, 'https://api.github.com/repos/YunongDai2005/theone-codex/releases/latest')
  assert.equal(requests[0].init.credentials, 'omit'); assert.equal(requests[0].init.redirect, 'error')
  assert.equal(new Headers(requests[0].init.headers).has('authorization'), false)
  assert.match(update.url, /^https:\/\/github.com\/YunongDai2005\/theone-codex\/releases\/tag\//)
  await checker.check(); assert.equal(requests.length, 1)
  await checker.check(true); assert.equal(requests.length, 2)
})

test('the public release baseline does not offer 0.1.0 as a new update', async () => {
  const { ReleaseChecker } = await import('../src/update-check.ts')
  const checker = new ReleaseChecker(undefined, async () => new Response(JSON.stringify({ tag_name: 'v0.1.0' })))
  assert.equal(await checker.check(), null)
  const newer = new ReleaseChecker(undefined, async () => new Response(JSON.stringify({ tag_name: 'v0.1.1' })))
  assert.equal((await newer.check())?.version, '0.1.1')
})

test('old versions, malformed tags, drafts, rate limits and network errors are silent', async () => {
  const mod = await import('../src/update-check.ts').catch(() => ({} as any))
  assert.equal(typeof mod.ReleaseChecker, 'function')
  for (const payload of [{ tag_name: 'v0.1.0-alpha.8' }, { tag_name: 'v0.1.0-alpha.9' }, { tag_name: 'v9.0.0; bad' }, { tag_name: 'v9.0.0', draft: true }]) {
    const checker = new mod.ReleaseChecker('0.1.0-alpha.9', async () => new Response(JSON.stringify(payload)))
    assert.equal(await checker.check(), null)
  }
  assert.equal(await new mod.ReleaseChecker('1.0.0', async () => new Response('', { status: 403 })).check(), null)
  assert.equal(await new mod.ReleaseChecker('1.0.0', async () => { throw Error('offline') }).check(), null)
  assert.equal((await new mod.ReleaseChecker('0.1.0-alpha.9', async () => new Response(JSON.stringify({ tag_name: 'v0.1.0-alpha.10' }))).check()).version, '0.1.0-alpha.10')
})
