// Facts a topic has settled (a figure, a decision, where an artifact lives), kept with the evidence
// that settled them, so other topics can use exactly that item instead of a whole summary.
// Only facts the user confirmed leave their topic; this module holds the rules that decide that.
import type { SessionEvent } from './host-types.ts'
import { redactRoutingText, textFeatures } from './routing-policy.ts'

export type FactKind = 'fact' | 'decision' | 'artifact'
export type FactStatus = 'confirmed' | 'proposed' | 'retracted'
export type Speaker = 'user' | 'assistant' | 'tool'
export const FACT_KINDS: readonly FactKind[] = ['fact', 'decision', 'artifact']

/** Where a version came from. `seq` is null when the quoted words were not found in the session. */
export interface FactEvidence {
  sessionId: string
  seq: number | null
  speaker: Speaker | 'unverified'
  quote: string
  /** For a confirmation such as "ok, go with that": the assistant's proposal it accepted. */
  accepts?: { seq: number; quote: string }
}

/** A fact as it stands now: its identity and its current version. */
export interface FactView {
  id: string
  contextId: string
  key: string
  label: string
  aliases: string[]
  kind: FactKind
  version: number
  status: FactStatus
  value: string | null
  evidence: FactEvidence
  origin: 'worker' | 'extractor'
  createdAt: number
  deletedAt?: number
  mergedFrom?: string
}

/** Every size limit of the feature in one place; each is a hard cap on characters or items. */
export const FACT_LIMITS = {
  label: 60, value: 300, quote: 200, aliases: 6, alias: 60, recordItems: 8,
  routerBudget: 1200, routerLabel: 40, routerValue: 80, routerItems: 12, imports: 5,
  briefingBudget: 1200, noticeBudget: 600, ownBudget: 1500, ownItems: 20, lookupItems: 10,
  extractionBudget: 6000, extractionFacts: 1500,
} as const

const clip = (text: string, max: number) => text.length > max ? text.slice(0, Math.max(0, max - 1)) + '…' : text

/** Text that may be stored or shown: credentials and personal addresses removed, then shortened. */
export const safe = (text: string, max: number) => clip(redactRoutingText(text).trim(), max)

/**
 * The name two writes must share to be the same fact. Case, width and spacing are folded, and only
 * wrapping quotes and punctuation are dropped, so `C++`, `C#` and `.NET` stay distinct.
 */
export function factKey(label: string): string {
  return label.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
    .replace(/^[\s"'“”‘’「」『』《》〈〉()（）[\]【】,;:!?，。；：！？、]+/, '')
    .replace(/[\s"'“”‘’「」『』《》〈〉()（）[\]【】.,;:!?，。；：！？、]+$/, '')
}

/** Folded text for finding a quote inside a message: width, case, spacing and thousands separators. */
export function matchText(text: string): string {
  return redactRoutingText(text).normalize('NFKC').toLowerCase().replace(/(\d)[,，](?=\d{3}\b)/g, '$1').replace(/\s+/g, '')
}

/** Literal evidence, with complete numeric tokens and units; similarity is for ranking, not proof. */
export function states(source: string, value: string): boolean {
  const s = matchText(source), v = matchText(value)
  if (!v || !s) return false
  const present = new Set(numberTokens(source))
  if (numberTokens(value).some(number => !present.has(number))) return false
  return s.includes(v)
}

/**
 * Whole numbers as written, read before spaces are folded away (so "12 3pm" is 12 and 3, not 123).
 * A sign only where no digit precedes it, so "2026-10-05" holds 10 and 05, not -10 and -05.
 */
function numberTokens(text: string): string[] {
  return redactRoutingText(text).normalize('NFKC').replace(/(\d)[,，](?=\d{3}\b)/g, '$1').match(/(?<![\d.])[+-]?\d+(?:\.\d+)?/g) ?? []
}

const NEGATION = /(不行|不可以|不好|不要|不用|不能|不是|不再|不同意|不采用|不选|别这样|算了|再想想|\bno\b|\bnot\b|\bdon'?t\b|\bnope\b|rather than|instead of)/i
const UNCERTAIN = /(未定|没定|没(?:有)?确定|未确认|未确定|不确定|暂定|待定|建议|假设|如果|或许|可能|\b(might|maybe|perhaps|suggest|suppose|if|undecided)\b)/i
const QUESTION = /[?？]|(吗|呢)\s*[。！!]?\s*$/
const ACCEPTANCE = /((?:^|[\s，,。.!！;；])(?:好的?|行|可以|确定|定了)(?=$|[\s，,。.!！;；]|就|按)|就按|就这样|就用|就它|同意|就这么定|没问题|按你说的|\bok(ay)?\b|\byes\b|\bsure\b|sounds good|go with|let'?s (do|go|use)|\bagreed?\b|\bdeal\b|works for me|that works)/i

/** Naming the assistant's suggestion ("就按你的建议", "your suggestion") is how an acceptance points at it. */
const THEIR_SUGGESTION = /((?:你|您)(?:的|刚才的|说的)?(?:建议|提议|方案))|\byour (?:suggestion|proposal|idea)\b/gi

/** "ok, go with that": an explicit acceptance, without a refusal and not itself a question. */
export function accepts(text: string): boolean {
  return ACCEPTANCE.test(text) && !NEGATION.test(text) && !UNCERTAIN.test(text.replace(THEIR_SUGGESTION, '')) && !QUESTION.test(text.trim())
}

/** A retraction needs words withdrawing or reopening a value, not merely any user quote. */
export function retracts(text: string): boolean {
  return !QUESTION.test(text.trim()) && /(撤回|取消|不再|不要|不用|未定|没定|没(?:有)?确定|未确认|未确定|不确定|先不定|待定|\b(withdraw|withdrawn|cancel|cancelled|canceled|undecided)\b|no longer|is off|not (yet )?(settled|decided))/i.test(text)
}

/** Check the actual sentence, including words a shortened model quote might have omitted. */
function assertsValue(text: string, value: string, quote: string): boolean {
  const needle = matchText(quote)
  const clauses = text.replace(/(\d)[,，](?=\d{3}\b)/g, '$1').split(/(?<=[。！？!?;；\n])/).flatMap(sentence =>
    sentence.split(/[,，]/).filter(clause => states(clause, value) &&
      (matchText(clause).includes(needle) || needle.includes(matchText(clause))))
      .map(clause => ({ text: clause, question: QUESTION.test(sentence.trim()) })))
  return clauses.length > 0 && clauses.every(clause => !clause.question && !NEGATION.test(clause.text) && !UNCERTAIN.test(clause.text))
}

export interface EvidenceEvent { seq: number; speaker: Speaker; text: string; toolResult?: boolean; isError?: boolean }

/**
 * The messages of a topic session that can serve as evidence, newest last: the user's own messages,
 * the assistant's answers and tool activity. TheOne's reference material for the session (its
 * descriptor, cross-topic briefings) is not the user speaking and never counts.
 */
export function evidenceEvents(events: readonly SessionEvent[], limit = 200): EvidenceEvent[] {
  const text = (blocks: readonly { type: string; text?: string }[]) => blocks.flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')
  // TheOne's own tools repeat the quotes they are given; a call citing itself proves nothing.
  const own = new Set(events.flatMap(event => event.type === 'tool/call' && event.data.name.startsWith('theone_') ? [String(event.data.callId)] : []))
  const result: EvidenceEvent[] = []
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') result.push({ seq: event.seq, speaker: 'user', text: text(event.data.content) })
    else if (event.type === 'assistant/message') result.push({ seq: event.seq, speaker: 'assistant', text: text(event.data.message.content) })
    else if (event.type === 'tool/result' && !own.has(String(event.data.message.source.callId)))
      result.push({ seq: event.seq, speaker: 'tool', text: text(event.data.message.content as { type: string; text?: string }[]), toolResult: true, isError: event.data.message.isError === true })
  }
  return result.filter(item => item.text.trim()).slice(-limit)
}

/** The newest event containing `quote` (folded), optionally only from one speaker or before a point. */
export function findQuote(events: readonly EvidenceEvent[], quote: string, options: { speaker?: Speaker; before?: number } = {}): EvidenceEvent | undefined {
  const needle = matchText(quote)
  if (needle.length < 2) return undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (options.before !== undefined && event.seq >= options.before) continue
    if (options.speaker && event.speaker !== options.speaker) continue
    if (matchText(event.text).includes(needle)) return event
  }
  return undefined
}

export interface Verdict { status: 'confirmed' | 'proposed'; evidence: FactEvidence; reason?: string }

/**
 * Decide from the session itself whether a value was confirmed. The model only points at words; the
 * speaker and the position come from the session. Confirmed means: the user stated the value; or the
 * user explicitly accepted an earlier assistant proposal that stated it; or, for an artifact, a tool
 * produced it. Anything else is a proposal and stays inside its topic.
 */
export function verify(input: { sessionId: string; events: readonly EvidenceEvent[]; kind: FactKind; value: string; quote: string; acceptsQuote?: string }): Verdict {
  const quote = safe(input.quote, FACT_LIMITS.quote)
  // The user's own message wins over an echo of it (the assistant repeating what the user said).
  const hit = findQuote(input.events, input.quote, { speaker: 'user' }) ?? findQuote(input.events, input.quote)
  if (!hit) return { status: 'proposed', reason: 'quote-not-found', evidence: { sessionId: input.sessionId, seq: null, speaker: 'unverified', quote } }
  const evidence: FactEvidence = { sessionId: input.sessionId, seq: hit.seq, speaker: hit.speaker, quote }
  if (hit.speaker === 'user' && states(input.quote, input.value) && assertsValue(hit.text, input.value, input.quote)) return { status: 'confirmed', evidence }
  if (hit.speaker === 'user' && input.acceptsQuote && accepts(input.quote) && accepts(hit.text)) {
    const proposal = findQuote(input.events, input.acceptsQuote, { speaker: 'assistant', before: hit.seq })
    const latest = input.events.findLast(event => event.speaker === 'assistant' && event.seq < hit.seq)
    if (proposal && proposal.seq === latest?.seq && states(input.acceptsQuote, input.value))
      return { status: 'confirmed', evidence: { ...evidence, accepts: { seq: proposal.seq, quote: safe(input.acceptsQuote, FACT_LIMITS.quote) } } }
    return { status: 'proposed', reason: 'proposal-not-found', evidence }
  }
  if (input.kind === 'artifact' && hit.speaker === 'tool' && hit.toolResult && !hit.isError && states(hit.text, input.value)) return { status: 'confirmed', evidence }
  return { status: 'proposed', reason: hit.speaker === 'user' ? 'value-not-in-quote' : `said-by-${hit.speaker}`, evidence }
}

/** One fact as other topics are shown it: `【topic】label = value (version n, confirmed at …)`. */
export function factLine(fact: FactView, topicTitle: string): string {
  const at = new Date(fact.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const confirmedBy = fact.evidence.speaker === 'tool' ? '工具验证于' : '用户确认于'
  return `- 【${safe(topicTitle, 40)}】${safe(fact.label, FACT_LIMITS.label)} = ${safe(fact.value ?? '', FACT_LIMITS.value)}（第 ${fact.version} 版，${confirmedBy} ${at}）`
}

/** Lines up to a character budget, whole lines only. */
export function within(lines: string[], budget: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > budget) break
    kept.push(line); used += line.length + 1
  }
  return kept
}

export interface FactCandidate { id: string; topic: string; label: string; kind: FactKind; value: string }

/**
 * Facts from other topics that the message may draw on, best first. Ranking only: whether a fact may
 * actually be delivered is decided again at delivery, against the final topic and current settings.
 */
export function rankCandidates(facts: readonly (FactView & { topicTitle: string; related: number; lastUsedAt?: number })[], text: string, now = Date.now()): FactCandidate[] {
  const query = textFeatures(text)
  const lower = text.toLowerCase()
  const scored = facts.flatMap(fact => {
    const words = textFeatures([fact.label, ...fact.aliases, fact.value ?? ''].join(' '))
    let shared = 0
    for (const feature of words) if (query.has(feature)) shared++
    const lexical = words.size ? shared / Math.sqrt(words.size * Math.max(1, query.size)) : 0
    const named = fact.topicTitle && lower.includes(fact.topicTitle.toLowerCase()) ? 0.3 : 0
    const fresh = 0.1 * 0.5 ** ((now - (fact.lastUsedAt ?? fact.createdAt)) / (14 * 86400000))
    const score = lexical + named + Math.min(0.3, fact.related * 0.1) + fresh
    return lexical > 0 || named > 0 ? [{ fact, score }] : []
  }).sort((a, b) => b.score - a.score)
  const result: FactCandidate[] = []
  let used = 2 // The serialized array's brackets and commas count towards the router budget too.
  for (const { fact } of scored) {
    if (result.length >= FACT_LIMITS.routerItems) break
    const item = { id: fact.id, topic: clip(fact.topicTitle, 40), label: clip(fact.label, FACT_LIMITS.routerLabel), kind: fact.kind, value: safe(fact.value ?? '', FACT_LIMITS.routerValue) }
    const size = JSON.stringify(item).length + (result.length ? 1 : 0)
    if (used + size > FACT_LIMITS.routerBudget) break
    result.push(item); used += size
  }
  return result
}
