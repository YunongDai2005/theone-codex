import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
// @ts-expect-error JavaScript fixture has no declaration file.
import { installInProcessRouter } from './fixtures/in-process-router.mjs'
const options = { command: process.execPath, args: [resolve('tests/fixtures/catalog-app-server.mjs')] }
test('native source follows session and turn pagination without starting or resuming conversations', async () => {
  const { CodexHistorySource } = await import('../src/codex-history.ts')
  const source = new CodexHistorySource(options), signal = new AbortController().signal
  try {
    assert.deepEqual((await source.list(signal)).map(s => s.id), ['first', 'second'])
    assert.deepEqual((await source.read('first', signal)).turns.map(t => t.id), ['turn1', 'turn2'])
  } finally { await source.close() }
})
test('classifier uses ephemeral structured output with execution tools and integrations disabled', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel(options)
  try { assert.deepEqual(await model.classify({ turns: [] }, new AbortController().signal), { topics: [] }) }
  finally { await model.close() }
})
test('cancelling a classifier interrupts its isolated turn and settles promptly', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel(options), abort = new AbortController()
  try {
    const result = model.classify({ text: 'WAIT_FOR_ABORT' }, abort.signal)
    setTimeout(() => abort.abort(), 150)
    await assert.rejects(result, /ABORT|abort|interrupt/i)
  } finally { await model.close() }
})

test('history defaults to economical Luna at medium effort and standard speed despite global Astra/Fast config', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel({ ...options, env: { CATALOG_EXPECT_MODEL: 'gpt-6-luna', CATALOG_EXPECT_EFFORT: 'medium', CATALOG_EXPECT_TIER: 'default' } })
  try { assert.deepEqual(await model.classify({ turns: [] }, new AbortController().signal), { topics: [] }) }
  finally { await model.close() }
})

test('history model choices follow pagination and omit hidden models without starting a model turn', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel(options)
  try {
    assert.equal(typeof (model as any).models, 'function', 'classifier must expose available choices')
    const choices = await (model as any).models()
    assert.deepEqual(choices.map((m: any) => m.model), ['gpt-6-astra', 'gpt-6-luna', 'basic'])
    assert.deepEqual(choices[1].reasoningEfforts, ['low', 'medium'])
    assert.equal(choices[1].fastTier, 'priority'); assert.equal(choices[2].fastTier, null)
  } finally { await model.close() }
})

test('explicit model, effort and Fast are applied to the isolated classifier', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel({ ...options, env: { CATALOG_EXPECT_MODEL: 'gpt-6-astra', CATALOG_EXPECT_EFFORT: 'high', CATALOG_EXPECT_TIER: 'priority' } })
  try { assert.deepEqual(await (model as any).classify({ turns: [] }, new AbortController().signal, { model: 'gpt-6-astra', effort: 'high', fast: true }), { topics: [] }) }
  finally { await model.close() }
})

test('unavailable models, reasoning levels and Fast fail before classification instead of silently falling back', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel(options)
  try {
    for (const selection of [{ model: 'missing', effort: 'medium', fast: false }, { model: 'basic', effort: 'medium', fast: false }, { model: 'basic', effort: 'low', fast: true }])
      await assert.rejects((model as any).classify({ turns: [] }, new AbortController().signal, selection), /模型|思考|快速/)
  } finally { await model.close() }
})

test('concurrent proposal reconciliation uses the selected model and the same isolated execution contract', async () => {
  const { CodexCatalogModel } = await import('../src/codex-history.ts')
  const model = new CodexCatalogModel({ ...options, env: { CATALOG_EXPECT_MODEL: 'gpt-6-luna', CATALOG_EXPECT_EFFORT: 'medium', CATALOG_EXPECT_TIER: 'default' } })
  try { assert.deepEqual(await model.reconcile({ proposals: [], contexts: [] }, new AbortController().signal,
    { model: 'gpt-6-luna', effort: 'medium', fast: false }), { matches: [] }) }
  finally { await model.close() }
})

test('in-process JSON-RPC preserves history pagination, model choice, reconciliation and cancellation', async t => {
  installInProcessRouter(t)
  const keepAlive = setInterval(() => {}, 1000)
  const { CodexHistorySource, CodexCatalogModel } = await import('../src/codex-history.ts')
  const source = new CodexHistorySource(options)
  const model = new CodexCatalogModel({ ...options, env: { CATALOG_EXPECT_MODEL: 'gpt-6-luna', CATALOG_EXPECT_EFFORT: 'medium', CATALOG_EXPECT_TIER: 'default' } })
  try {
    const signal = new AbortController().signal
    assert.deepEqual((await source.list(signal)).map(s => s.id), ['first','second'])
    assert.equal((await source.read('first', signal)).turns.length, 2)
    assert.deepEqual((await model.models()).map(m => m.model), ['gpt-6-astra','gpt-6-luna','basic'])
    assert.deepEqual(await model.classify({}, signal), { topics: [] })
    assert.deepEqual(await model.reconcile({}, signal), { matches: [] })
    await assert.rejects(model.classify({}, signal, { model: 'missing', effort: 'low', fast: false }), /模型/)
    const abort = new AbortController(), pending = model.classify({ text: 'WAIT_FOR_ABORT' }, abort.signal)
    setTimeout(() => abort.abort(), 10)
    await assert.rejects(pending, /CATALOG_ABORTED/)
    assert.deepEqual(await model.classify({}, signal), { topics: [] })
  } finally { await source.close(); await model.close(); clearInterval(keepAlive) }
})
