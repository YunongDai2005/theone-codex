// How shared facts move between topics: which are offered to routing, what a topic is told before
// its Worker answers, and how an extraction is checked and stored. The plugin and the benchmark both
// run these functions, so what is measured is what ships.
import type { ContextStore } from './store.ts'
import { LINK_SIGNAL, mayShare, relatedTopics, type LinkScope } from './linkage.ts'
import { FACT_KINDS, FACT_LIMITS, factKey, factLine, findQuote, rankCandidates, retracts, safe, verify, within,
  type EvidenceEvent, type FactCandidate, type FactKind, type FactView } from './facts.ts'

/** Confirmed facts this message might use, best first, within budget. Ranking only. */
export function factCandidates(store: ContextStore, scope: LinkScope, text: string, recent: string[], currentId?: string): FactCandidate[] {
  if (scope === 'off') return []
  // A topic whose conversations are gone or archived offers nothing (see HistoryCatalog.reconcile).
  const hidden = store.hiddenReasons()
  const titles = new Map(store.contexts().filter(context => !hidden.has(context.id)).map(context => [context.id, context.title]))
  const related = new Map(currentId ? relatedTopics(store, currentId, scope, 10).map(topic => [topic.id, topic.score]) : [])
  // The current topic's own facts are candidates too: the message may be moving elsewhere with them.
  // A first filter for the topic in view; delivery checks again against the topic finally chosen.
  const pool = store.sharedFacts().filter(fact => titles.has(fact.contextId) &&
    (currentId ? !mayShare(store, scope, fact.contextId, currentId) : !store.isPrivate(fact.contextId)))
    .map(fact => ({ ...fact, topicTitle: titles.get(fact.contextId)!, related: related.get(fact.contextId) ?? 0 }))
  return rankCandidates(pool, [...recent.slice(-2), text].join('\n'))
}

export interface FactDelivery {
  notices: string[]
  facts: string[]
  /** Record what was sent; call only once the briefing carrying these lines is actually sent. */
  commit(): void
}

/**
 * What a topic is told about facts before its Worker answers: changes to facts it used before
 * (also on a plain "go on") and the facts this request imports. Every fact is checked here, against
 * the topic finally chosen and the settings now; nothing is recorded until `commit`.
 */
export function factDelivery(store: ContextStore, scope: LinkScope, contextId: string, imports: string[], inputId?: string): FactDelivery {
  const hidden = store.hiddenReasons()
  const titles = new Map(store.contexts().filter(context => !hidden.has(context.id)).map(context => [context.id, context.title]))
  const allowed = (sourceId: string) => titles.has(sourceId) && !mayShare(store, scope, sourceId, contextId)
  const notices: { line: string; commit: () => void }[] = []
  const quiet: (() => void)[] = []
  const noticed = new Set<string>()
  for (const dependency of store.dependencies(contextId)) {
    const fact = store.fact(dependency.factId)
    const label = safe(fact?.label ?? '一个要点', 40)
    if (!fact || fact.deletedAt !== undefined || !allowed(fact.contextId)) {
      // Only the name: a topic that may no longer share must not leak its new value.
      notices.push({ line: `- 之前引用的「${label}」不再可用，不要再使用它之前的值。`, commit: () => store.forgetDependency(contextId, dependency.factId) })
    } else if (fact.version > dependency.versionSeen) {
      const title = safe(titles.get(fact.contextId)!, 40)
      const before = store.factVersion(fact.id, dependency.versionSeen)
      // The same value said again (a reaffirmation is a new version): nothing to tell; move the mark on.
      if (before && before.status === fact.status && before.value === fact.value) { quiet.push(() => store.recordDelivery(contextId, fact, 'notice', inputId)); continue }
      const line = fact.status !== 'confirmed' ? `- 【${title}】${label}：已撤回或目前没有确认的值，不要再使用之前的值。`
        : before?.status === 'confirmed' ? `- 【${title}】${label}：${safe(before.value ?? '', 80)} → ${safe(fact.value ?? '', 80)}（第 ${fact.version} 版）`
        : `- 【${title}】${label}：重新确认为 ${safe(fact.value ?? '', 80)}（第 ${fact.version} 版）`
      notices.push({ line, commit: () => store.recordDelivery(contextId, fact, 'notice', inputId) })
    } else continue
    noticed.add(dependency.factId)
  }
  const facts: { line: string; commit: () => void }[] = []
  for (const id of new Set(imports)) {
    const fact = store.fact(id)
    if (!fact || noticed.has(id) || fact.deletedAt !== undefined || fact.status !== 'confirmed' || fact.contextId === contextId || !allowed(fact.contextId)) continue
    facts.push({ line: factLine(fact, titles.get(fact.contextId)!), commit: () => {
      store.recordDelivery(contextId, fact, 'route', inputId)
      store.withLearning([...(inputId ? [store.learningJournal.source(inputId, contextId)] : []), ...store.factLearningSources(fact.id, fact.version)], () =>
        store.learnLink(contextId, fact.contextId, LINK_SIGNAL.mention))
    } })
  }
  const fit = (items: { line: string; commit: () => void }[], budget: number) => items.slice(0, within(items.map(item => item.line), budget).length)
  const sentNotices = fit(notices, FACT_LIMITS.noticeBudget), sentFacts = fit(facts, FACT_LIMITS.briefingBudget)
  return { notices: sentNotices.map(item => item.line), facts: sentFacts.map(item => item.line),
    commit: () => { for (const item of [...sentNotices, ...sentFacts]) item.commit(); for (const mark of quiet) mark() } }
}

/** The topic's own recorded facts, with ids and versions, for its Worker's descriptor. */
export function ownFactsText(store: ContextStore, contextId: string): string {
  const lines = store.facts(contextId, true).slice(0, FACT_LIMITS.ownItems).map(fact =>
    `- [${fact.id} v${fact.version}] ${safe(fact.label, FACT_LIMITS.label)} = ${safe(fact.value ?? '', 120)}${fact.status === 'proposed' ? '（建议，用户未确认）' : fact.status === 'retracted' ? '（已撤回）' : ''}`)
  const kept = within(lines, FACT_LIMITS.ownBudget)
  return kept.length ? `\n本话题已记录的要点（更新或撤回时用 theone_record，带上 factId 和 expectedVersion）：\n${kept.join('\n')}` : ''
}

/** Optional extraction after a turn; every item it returns is checked like a Worker's own record. */
export const EXTRACT_PROMPT = `你在帮一个话题记录已经确定下来的要点：数字、日期、决定、文件或链接的位置。输入是本轮的用户消息 user、助手回答 assistant，以及本话题已记录的要点 facts（含 factId 和版本）。
只记录用户亲口说出的值，或用户明确接受了助手提议的值（此时 acceptsQuote 填助手提议的原话）；助手自己的建议、推测、未定的事不要记录。
每条都必须给出 evidenceQuote：本轮对话里能证明它的原话，逐字复制。已记录过的同一件事用它的 factId 更新；用户说某个值不再成立或还没定时，输出 op 为 "retract" 并给出用户原话。没有就输出空数组。
只输出 JSON 数组，例如 [{"op":"set","factId":null,"label":"预算","kind":"fact","value":"800","evidenceQuote":"预算定为 800 元"}]。kind 只能是 fact、decision、artifact。`

/** The extraction request for the turn that just ended: cleaned, and within its size budget. */
export function extractionPayload(events: readonly EvidenceEvent[], base: readonly FactView[]) {
  const lastUser = events.findLastIndex(event => event.speaker === 'user')
  if (lastUser < 0) return undefined
  // An accepted proposal is quoted from the reply before the user's words, so that reply is included.
  const previous = events.slice(0, lastUser).findLast(event => event.speaker === 'assistant')
  const user = events[lastUser].text, assistant = [previous?.text, ...events.slice(lastUser + 1).filter(event => event.speaker === 'assistant').map(event => event.text)].filter(Boolean).join('\n')
  const known = within(base.map(fact => JSON.stringify({ factId: fact.id, version: fact.version, status: fact.status, label: safe(fact.label, FACT_LIMITS.label), value: safe(fact.value ?? '', 120) })), FACT_LIMITS.extractionFacts)
  const room = FACT_LIMITS.extractionBudget - known.join('').length
  const payload = { user: safe(user, Math.floor(room / 3)), assistant: safe(assistant, room - Math.floor(room / 3) - 200), facts: known.map(line => JSON.parse(line) as object) }
  // Escaping quotes, newlines and backslashes can double the serialized request size.
  while (JSON.stringify(payload).length > FACT_LIMITS.extractionBudget && (payload.user || payload.assistant)) {
    const field = payload.assistant.length >= payload.user.length ? 'assistant' : 'user'
    const excess = JSON.stringify(payload).length - FACT_LIMITS.extractionBudget
    payload[field] = payload[field].slice(0, Math.max(0, payload[field].length - Math.ceil(excess / 2)))
  }
  return payload
}

/**
 * Store what an extraction returned, by the same rules as a Worker's record: evidence is checked in
 * the session, and every write expects the version the topic had when the turn ended, so a late
 * extraction cannot overwrite a newer value. Returns how many items were stored.
 */
export function applyExtraction(store: ContextStore, input: { sessionId: string; contextId: string; events: readonly EvidenceEvent[]; base: readonly FactView[]; items: unknown }): number {
  if (!Array.isArray(input.items)) return 0
  const byId = new Map(input.base.map(fact => [fact.id, fact.version]))
  const byName = new Map(input.base.flatMap(fact => [fact.key, ...fact.aliases].map(key => [key, fact.version] as const)))
  let stored = 0
  for (const item of input.items.slice(0, FACT_LIMITS.recordItems) as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue
    const text = (key: string) => typeof item[key] === 'string' ? item[key] as string : undefined
    const quote = text('evidenceQuote') ?? '', factId = text('factId'), label = text('label') ?? input.base.find(fact => fact.id === factId)?.label ?? ''
    // A name that did not exist when the turn ended must still not exist: expected version 0.
    const expectedVersion = factId ? byId.get(factId) : byName.get(factKey(label)) ?? 0
    if (factId && expectedVersion === undefined) continue
    if (item.op === 'retract') {
      const said = factId ? findQuote(input.events, quote, { speaker: 'user' }) : undefined
      if (said && retracts(quote) && retracts(said.text) && store.retractFact(input.contextId, factId!, { sessionId: input.sessionId, seq: said.seq, speaker: 'user', quote }, 'extractor', expectedVersion).outcome === 'retracted') stored++
      continue
    }
    const kind = (FACT_KINDS.includes(item.kind as FactKind) ? item.kind : 'fact') as FactKind
    const verdict = verify({ sessionId: input.sessionId, events: input.events, kind, value: text('value') ?? '', quote, acceptsQuote: text('acceptsQuote') })
    const result = store.recordFact(input.contextId, { ...(factId ? { factId } : {}), label, kind, value: text('value') ?? '', status: verdict.status,
      evidence: verdict.evidence, origin: 'extractor', expectedVersion })
    if (result.outcome === 'created' || result.outcome === 'updated') stored++
  }
  return stored
}
