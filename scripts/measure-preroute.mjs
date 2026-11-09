// MANUAL ONLY: consumes Codex routing quota. Does not execute worker tasks.
// node --experimental-transform-types scripts/measure-preroute.mjs [--delays 3,5] [--rounds 1]
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { TheOneService } from '../src/service.ts'
import { CodexRouter } from '../src/codex-router.ts'

const { values } = parseArgs({ options: {
  delays: { type: 'string', default: '3,5' }, rounds: { type: 'string', default: '1' },
  model: { type: 'string' }, effort: { type: 'string', default: 'low' }, fast: { type: 'boolean', default: false },
  'timeout-ms': { type: 'string', default: '15000' }, output: { type: 'string' },
} })
const delays = values.delays.split(',').map(Number), rounds = Number(values.rounds), timeoutMs = Number(values['timeout-ms'])
if (!delays.length || delays.some(n => !Number.isFinite(n) || n < 0 || n > 60) || !Number.isInteger(rounds) || rounds < 1 || rounds > 100 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Invalid delays, rounds or timeout')
if (!values.model && (values.fast || values.effort !== 'low')) throw Error('--model is required when overriding effort or speed')
const settings = values.model ? { model: values.model, effort: values.effort, fast: values.fast } : undefined
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/router-messages.json', import.meta.url), 'utf8'))
const dataDir = await mkdtemp(join(tmpdir(), 'theone-preroute-measure-'))
const router = new CodexRouter({ settings, timeoutMs }), runs = []
// Each scenario has fresh stores and identical topics; only the model connection is reused.
// The dispatch path is real, but its worker completes locally without a model/tool call.
try {
  for (let round = 0; round < rounds; round++) for (const delaySeconds of delays) for (const sample of fixture.samples) {
    const directory = join(dataDir, String(runs.length)), service = new TheOneService({ dataDir: directory,
      router: { source: 'codex', decide: (...args) => router.decide(...args) },
      backend: { execute: async () => ({ status: 'completed' }), respond: async () => {}, close: async () => {} } })
    try {
      service.configure('measure', { workspace: directory, routerMode: 'auto' }); service.store.seed(structuredClone(fixture.contexts))
      if (sample.currentId) service.selectTopic('measure', sample.currentId)
      for (const [i, message] of (sample.recent ?? []).entries()) service.runtime.put('message', `recent-${i}`, { ...message, id: `recent-${i}`, topicId: sample.currentId, at: i, source: 'import' })
      const input = { gatewayId: 'measure', inputId: 'sample', text: sample.text }
      service.preroute(input)
      await sleep(delaySeconds * 1000)
      const start = performance.now(), result = await service.dispatch(input)
      runs.push({ name: sample.name, round: round + 1, delaySeconds, connection: runs.length ? 'reused-or-reconnected' : 'cold',
        ok: !result.routingError, source: result.receipt.source, waitMs: result.receipt.waitMs ?? 0,
        dispatchMs: Math.round(performance.now() - start), modelCalls: result.receipt.calls ?? 0,
        model: result.receipt.model ?? null, error: result.routingError, decision: result.decision ?? service.store.route(result.id)?.decision })
    } catch (error) { runs.push({ name: sample.name, round: round + 1, delaySeconds, ok: false, waitMs: null, error: error.code ?? error.message }) }
    finally { await service.close() }
    console.log(JSON.stringify(runs.at(-1)))
  }
} finally { await router.close(); await rm(dataDir, { recursive: true, force: true }) }
const stats = rows => {
  const values = rows.map(r => r.waitMs).filter(n => typeof n === 'number').sort((a,b) => a-b)
  const percentile = p => values.length ? values[Math.ceil(p * values.length)-1] : null
  return { count: rows.length, measured: values.length, failures: rows.filter(r => !r.ok).length, p50: percentile(.5), p90: percentile(.9) }
}
const report = { measuredAt: new Date().toISOString(), settings: settings ?? { preference: 'Luna', effort: 'low', fast: false }, timeoutMs,
  method: 'nearest-rank waitMs in milliseconds; rules and completed caches may be zero; failures reported separately; worker stub only',
  groups: delays.map(delaySeconds => { const rows = runs.filter(r => r.delaySeconds === delaySeconds); return { delaySeconds,
    all: stats(rows), successfulModelRoutes: stats(rows.filter(r => r.ok && r.modelCalls > 0)), sources: Object.fromEntries([...new Set(rows.map(r => r.source ?? 'error'))].map(source => [source, rows.filter(r => (r.source ?? 'error') === source).length])) } }), runs }
const output = values.output ? resolve(values.output) : fileURLToPath(new URL('../evidence/preroute-latency.json', import.meta.url))
await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ groups: report.groups, path: output }))
if (runs.some(r => !r.ok)) process.exitCode = 1
