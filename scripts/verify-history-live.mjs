import { CodexCatalogModel, CodexHistorySource } from '../src/codex-history.ts'
import { validateCatalog } from '../src/history-classification.ts'
import { recommendedHistoryModel } from '../src/history-model-settings.ts'
import { writeFileSync } from 'node:fs'
const source = new CodexHistorySource(), model = new CodexCatalogModel()
const report = { at: new Date().toISOString(), syntheticModelInput: true, realModel: false }
try {
  const signal = new AbortController().signal
  const choices = await model.models(), selection = recommendedHistoryModel(choices)
  if (!selection || selection.model !== 'gpt-6-luna' || selection.effort !== 'medium' || selection.fast) throw Error('Expected economical Luna / medium / standard defaults on this account')
  report.modelSelection = selection; report.availableModels = choices.map(m => m.model)
  const sessions = await source.list(signal)
  report.nativeMetadataCount = sessions.length
  // Verify the history shape on this project's chat; do not print or classify its content.
  const own = sessions.find(s => s.cwd?.toLowerCase() === process.cwd().toLowerCase() && !s.busy)
  if (own) { const chat = await source.read(own.id, signal); report.nativeReadTurnCount = chat.turns.length }
  console.log(JSON.stringify({ nativeMetadataCount: report.nativeMetadataCount, nativeReadTurnCount: report.nativeReadTurnCount }))
  const turns = [{ seq: 1, text: '安排云南旅行路线和酒店', contextId: null }, { seq: 2, text: '为小说写章节大纲', contextId: null }]
  const result = await model.classify({ title: '功能验证', ownedContextId: null, compactionSummaries: [], contexts: [], groups: [], turns }, signal, selection)
  const topics = validateCatalog(result, turns.map(t => ({ ...t, endSeq: t.seq, fingerprint: 'fixture' })), [], [])
  if (topics.length !== 2) throw Error('Expected two independent topics')
  report.realModel = true; report.topicTitles = topics.map(t => t.title)
  console.log(JSON.stringify(report))
} finally {
  await source.close(); await model.close()
  writeFileSync('evidence/history-real-model.json', JSON.stringify(report, null, 2) + '\n')
}
