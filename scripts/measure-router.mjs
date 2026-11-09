// Run manually: node --experimental-transform-types scripts/measure-router.mjs
// Uses the existing Codex login and consumes model quota. No worker tasks are executed.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CodexRouter } from '../src/codex-router.ts'

const { values } = parseArgs({ options: {
  model: { type: 'string' }, effort: { type: 'string', default: 'low' }, fast: { type: 'boolean', default: false },
  'timeout-ms': { type: 'string', default: '15000' },
} })
if (!values.model && (values.fast || values.effort !== 'low')) throw Error('--model is required when overriding effort or speed')
const settings = values.model ? { model: values.model, effort: values.effort, fast: values.fast } : undefined
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/router-messages.json', import.meta.url), 'utf8'))
const router = new CodexRouter({ settings, timeoutMs: Number(values['timeout-ms']) })
const runs = []
try {
  for (const [index, sample] of fixture.samples.entries()) {
    const started = performance.now()
    try {
      const result = await router.decide({ ...sample, contexts: fixture.contexts })
      runs.push({ name: sample.name, connection: index === 0 ? 'cold' : 'reused-or-reconnected', ok: true,
        elapsedMs: Math.round(performance.now() - started), routerElapsedMs: result.elapsedMs, model: result.model, decision: result.decision })
    } catch (error) {
      runs.push({ name: sample.name, ok: false, elapsedMs: Math.round(performance.now() - started), error: error.code ?? 'ROUTER_UNAVAILABLE', model: error.meta?.attempts?.at(-1)?.model ?? settings?.model ?? null })
    }
    console.log(JSON.stringify(runs.at(-1)))
  }
} finally { await router.close() }
const durations = runs.map(r => r.elapsedMs).sort((a, b) => a - b)
const percentile = p => durations.length ? durations[Math.max(0, Math.ceil(p * durations.length) - 1)] : null
const report = { measuredAt: new Date().toISOString(), settings: settings ?? { preference: 'Luna', effort: 'low', fast: false },
  timeoutMs: Number(values['timeout-ms']), count: runs.length, succeeded: runs.filter(r => r.ok).length,
  percentiles: { method: 'nearest-rank, all attempts including failures; milliseconds', p50: percentile(0.5), p90: percentile(0.9) }, runs }
const destination = new URL('../evidence/router-latency.json', import.meta.url)
await mkdir(new URL('../evidence/', import.meta.url), { recursive: true })
await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report.percentiles, succeeded: report.succeeded, count: report.count, path: fileURLToPath(destination) }))
if (report.succeeded !== report.count) process.exitCode = 1
