// Synthetic input only. Print timings, never config values or historical contents.
import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { AppServer } from '../src/app-server.ts'
import { CodexCatalogModel } from '../src/codex-history.ts'
import { validateCatalog } from '../src/history-classification.ts'
const request = AppServer.prototype.request, calls = []
AppServer.prototype.request = async function(method, params) {
  const start = performance.now()
  try { return await request.call(this, method, params) }
  finally { calls.push({ method, milliseconds: Math.round(performance.now() - start) }) }
}
const model = new CodexCatalogModel(), runs = [], selection = { model: 'gpt-6-luna', effort: 'medium', fast: false }
const batchSize = Number(process.env.THEONE_PROFILE_BATCH_SIZE ?? 8), batches = Number(process.env.THEONE_PROFILE_BATCHES ?? 2)
if (![8,16].includes(batchSize) || ![1,2].includes(batches)) throw Error('Only bounded profiling samples are allowed')
try {
  for (let batch = 0; batch < batches; batch++) {
    const texts = ['规划云南旅行路线', '小说第一章大纲', '云南旅行酒店预算', '小说第二章人物关系', '云南旅行交通安排', '小说第三章转折', '云南旅行行李清单', '小说第四章结尾']
    const turns = Array.from({ length: batchSize }, (_,i) => ({ seq: batch * batchSize + i + 1, text: texts[i % texts.length], contextId: null }))
    const offset = calls.length, start = performance.now()
    const result = await model.classify({ title: '合成性能样例', ownedContextId: null, compactionSummaries: [], contexts: [], groups: [], turns }, new AbortController().signal, selection)
    const topics = validateCatalog(result, turns.map(t => ({ ...t, endSeq: t.seq, fingerprint: 'fixture' })), [], [])
    const run = { batch: batch + 1, turns: turns.length, topics: topics.length, totalMs: Math.round(performance.now() - start), requests: calls.slice(offset) }
    runs.push(run); console.log(JSON.stringify(run))
  }
} finally {
  await model.close(); AppServer.prototype.request = request
  writeFileSync(process.env.THEONE_PROFILE_OUTPUT ?? 'evidence/history-performance-before.json', JSON.stringify({ at: new Date().toISOString(), syntheticInput: true, selection, runs }, null, 2) + '\n')
}
