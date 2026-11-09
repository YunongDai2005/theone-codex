// A second look at quick routing decisions. The numbers, codes and names a message mentions are looked
// up in every topic's own messages and card; a detail only one topic has ever mentioned is a clue to
// where the message belongs. A quick decision that goes against such a clue, opens a new topic or
// asks the user is asked again with thinking on. (Offering the clues to the quick decision itself,
// or counting ordinary words as clues, did not help in the benchmark; see docs/routing-eval.md.)

import type { Decision } from './types.ts'
import { redactRoutingText } from './routing-policy.ts'

/** What a topic has said: its messages, and what its card and catalog entry know. */
export interface TopicMemory { id: string; texts: readonly string[] }

/** Numbers, codes and names of the message that only this topic has mentioned. */
export interface Evidence { contextId: string; terms: string[] }

export const EVIDENCE_LIMITS = { topics: 3, terms: 4 } as const

const normalize = (text: string) => redactRoutingText(text).toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1')

/** The details of a message worth looking up: numbers of three or more digits, codes, and names. */
export function evidenceTerms(text: string): string[] {
  const source = redactRoutingText(text)
  const found = new Set<string>()
  for (const match of source.matchAll(/[A-Za-z]+[-_]?\d[\w-]*|\d[\d,]*(?:\.\d+)?/g)) {
    const term = match[0].toLowerCase().replace(/,/g, '').replace(/[-_]+$/, '')
    if (/[a-z]/.test(term) || term.replace(/\D/g, '').length >= 3 || /\d\.\d/.test(term)) found.add(term)
  }
  // A capitalized word inside a sentence is usually a name.
  for (const match of source.matchAll(/[A-Z][a-z][A-Za-z'-]{2,}/g)) {
    const before = source.slice(0, match.index)
    if (match.index > 0 && (!/[.!?。！？]\s*$/.test(before) || /\b(?:Mr|Mrs|Ms|Dr|St)\.\s*$/.test(before)))
      found.add(match[0].replace(/'s$/i, '').toLowerCase())
  }
  return [...found].filter(term => !term.startsWith('redacted'))
}

/** Topics holding details of `text` that no other topic holds, the most telling first. */
export function routingEvidence(text: string, topics: readonly TopicMemory[]): Evidence[] {
  if (topics.length < 2) return []
  const memory = topics.map(topic => ({ id: topic.id, text: normalize(topic.texts.join('\n')) }))
  const byTopic = new Map<string, string[]>()
  for (const term of evidenceTerms(text)) {
    const holders = memory.filter(topic => topic.text.includes(term))
    if (holders.length === 1) byTopic.set(holders[0].id, [...byTopic.get(holders[0].id) ?? [], term])
  }
  return [...byTopic].map(([contextId, terms]) => ({ contextId,
    // A longer detail says it all: drop the pieces of it.
    terms: terms.filter(term => !terms.some(other => other !== term && other.includes(term))).sort((a, b) => b.length - a.length).slice(0, EVIDENCE_LIMITS.terms) }))
    .sort((a, b) => b.terms.join('').length - a.terms.join('').length).slice(0, EVIDENCE_LIMITS.topics)
}

/**
 * The topic a clue points to when the decision went elsewhere (another topic, a new topic, or a
 * question), or undefined. Only one topic may hold clues; several cancel out.
 */
export function evidenceConflict(decision: Decision, evidence: readonly Evidence[]): string | undefined {
  if (evidence.length !== 1) return undefined
  return decision.contextId === evidence[0].contextId ? undefined : evidence[0].contextId
}

/** Why a decision is asked again: what it was, and the clue it went against, if any. */
export interface Recheck { previous: string; contextId?: string; terms?: string[] }

/**
 * Whether a quick decision deserves a second, thinking look: it goes against a clue, or it opens a
 * new topic or asks the user, the decisions a quick look gets wrong most and that cost the most when
 * wrong (a split topic, a needless question). Picking an existing topic in line with the clues stands.
 */
export function secondLook(decision: Decision, evidence: readonly Evidence[]): Recheck | undefined {
  const previous = decision.contextId ?? decision.action
  const conflict = evidenceConflict(decision, evidence)
  if (conflict) return { previous, contextId: conflict, terms: evidence[0].terms }
  return decision.action === 'CREATE' || decision.action === 'CLARIFY' ? { previous } : undefined
}

/** Fixed instructions for an optional second look, with thinking on. */
export const RECHECK_PROMPT = `
recheck（可能没有）表示这是第二次判断：上一次快速判断的结论是 recheck.previous（已有话题的 ID，或 CREATE / CLARIFY）。如果有 recheck.contextId，是因为 text 里的 recheck.terms 只在话题 recheck.contextId 里出现过，和上次的结论不一致。这次逐个比较目录里的话题再下结论：同一件事的后续步骤、子任务和细节问题属于原来的话题；确实是另一件事才新建；只有规则允许时才澄清。结论可以和上次相同。没有 recheck 时按常规判断。`
