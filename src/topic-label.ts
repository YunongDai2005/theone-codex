import type { ContextDescriptor } from './types.ts'

/** Invalid display metadata is ignored, never a reason to retry classification. */
export function normalizeTopicLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const label = value.normalize('NFKC').trim().replace(/ +/g, ' ')
  if (/^\p{Script=Han}{2,4}$/u.test(label)) return label
  // Bound long English words as well as the word count so the label fits a bubble.
  if ([...label].length <= 24 && /^\p{Script=Latin}+(?: \p{Script=Latin}+)?$/u.test(label)) return label
  return undefined
}

/** Prefer the classifier's short name; otherwise use existing terms without truncation. */
export function bubbleLabel(topic: Pick<ContextDescriptor, 'label' | 'title' | 'entities' | 'keywords'>): string | null {
  const stored = normalizeTopicLabel(topic.label)
  if (stored) return stored
  // A title already short enough is its own name; a term from elsewhere ("日本" for "旅游") would only confuse.
  const own = normalizeTopicLabel(topic.title)
  if (own) return own
  const title = topic.title.normalize('NFKC').toLowerCase()
  const candidates = [...topic.entities, ...topic.keywords].map((term, order) => {
    const label = term.normalize('NFKC').trim().replace(/ +/g, ' ')
    const size = [...label].length, han = [...label.matchAll(/\p{Script=Han}/gu)].length
    const valid = /^[\p{Script=Han}\p{Script=Latin}0-9 .+#_-]+$/u.test(label) &&
      (han === size ? han >= 2 && han <= 6 : /\p{Script=Latin}/u.test(label) && han <= 6 && size + han <= 14)
    const at = title.indexOf(label.toLowerCase())
    return { label, valid, rank: at < 0 ? Infinity : at, order }
  }).filter(item => item.valid && item.rank !== Infinity)
  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return candidates[0]?.label ?? null
}

