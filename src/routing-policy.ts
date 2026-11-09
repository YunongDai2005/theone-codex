import { normalize, win32 } from 'node:path'
import type { ContextDescriptor, Decision } from './types.ts'

/** Keep credentials out of classifier payloads and automatically generated titles. */
export function redactRoutingText(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|密码|密钥)\s*[=:：]\s*)[^\s,;，；]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[REDACTED_IP]')
}

/** Routing needs old conversation state only for an actual backward reference.
 * Missing factual knowledge (including an unfamiliar name) is the Worker's job.
 */
export function referencesHistory(text: string): boolean {
  const input = text.trim()
  return /(?:上次|之前|此前|刚才|昨天|前天|上周|先前|原来|你说的|我们聊的).{0,16}(?:那个|那件|那份|那项|方案|链接|文件|配置|项目|会话|聊天|提到|说过|讨论|发的|资料|任务)/.test(input)
    || /(?:继续|接着|回到|恢复).{0,6}(?:上次|之前|此前|刚才|昨天|前天|上周)/.test(input)
    || /(?:之前|上次|刚才)(?:提到|说|聊|发|做|用|定|选|给)|你(?:还)?记得|我们(?:之前|上次)聊/.test(input)
    || /^(?:继续|接着|再来|那(?:个|件|份|项)|这个|它|还有你说的|你说的)(?:[，,。.!！?？\s]|$)/.test(input)
    || /^(?:那个|这个|它的)|不是这个|是另一个|说错.{0,8}话题/.test(input)
    || /\b(?:last time|previous (?:chat|conversation|session)|earlier (?:chat|conversation)|(?:link|file|plan|project|task) (?:from |we discussed )?(?:yesterday|before)|(?:you|we) (?:mentioned|discussed|said|sent)|(?:continue|resume) (?:the |our )?(?:previous|last|earlier)|remember when)\b/i.test(input)
    || /\b(?:previous|earlier|last|that) (?:link|file|plan|project|task|conversation|session)\b/i.test(input)
    || /^(?:continue|resume|go on|do that|that one|it)\s*[.!?]*$/i.test(input)
}

/**
 * TheOne does not ask the user where a message belongs. An unclear decision settles on the topic the
 * classifier leaned to (the current one when it is among the candidates), with the other candidates
 * along as reference; with no candidate it stays in the current topic, or starts a new one. Only a
 * missing model and an unclear "wrong topic" (a correction the user started) still ask.
 */
export function settleUnclear(decision: Decision, text: string, contexts: readonly ContextDescriptor[], currentId?: string): Decision {
  if (decision.action !== 'CLARIFY' || decision.reason === 'ROUTER_MODEL_MISSING' || decision.reason === 'correction-unclear') return decision
  const known = (id?: string): id is string => !!id && contexts.some(context => context.id === id)
  const candidates = [...new Set(decision.relatedIds ?? [])].filter(known)
  const chosen = currentId && candidates.includes(currentId) ? currentId : candidates[0] ?? (known(currentId) ? currentId : undefined)
  if (!chosen) return newIndependentTopic(text, [...contexts], 'unclear-new')
  const alternateIds = candidates.filter(id => id !== chosen).slice(0, 3)
  return { action: chosen === currentId ? 'KEEP' : currentId ? 'SWAP' : 'MOUNT', contextId: chosen, reason: 'unclear-settled', ...(alternateIds.length ? { alternateIds } : {}) }
}

export function newIndependentTopic(text: string, contexts: ContextDescriptor[], reason: string): Decision {
  const base = redactRoutingText(text).trim().replace(/\s+/g, ' ').slice(0, 80) || 'New topic'
  let title = base
  // A question can be new even if its text happens to equal a directory title.
  for (let index = 2; contexts.some(context => context.title.toLowerCase() === title.toLowerCase()); index++)
    title = `${base.slice(0, 68)} (${index})`
  return { action: 'CREATE', title, reason, historyIndependent: true }
}

/** Short text may use a fast route only after checking server-owned pending and foreground state. */
export function continuesCurrent(text: string): boolean {
  const input = text.trim()
  return input.length <= 16 && /^(?:继续(?:说|写|做)?|接着(?:说|写|做|来)?|然后呢?|还有呢|好的?|好吧|可以|行|嗯+|对的?|是的|没问题|收到|谢谢|多谢|辛苦了|为什么|为啥|怎么说|详细(?:点|些|一点|说说)|展开(?:说说|讲讲)?|再详细(?:点|些|一点)?|ok(?:ay)?|yes|thanks?|thank you|go on|continue|why|more)[\s!！。.,，?？~～…]*$/i.test(input)
}

/** Resume work after an aside; questions about the aside (why/more) are intentionally excluded. */
export function resumesWork(text: string): boolean {
  return /^(?:继续(?:说|写|做)?|接着(?:说|写|做|来)?|好的?|好吧|可以|行|嗯+|对的?|是的|没问题|收到|谢谢|多谢|辛苦了|下一步|ok(?:ay)?|yes|thanks?|thank you|go on|continue|next step)[\s!！。.,，?？~～…]*$/i.test(text.trim())
}

/**
 * "Wrong topic" said right after a reply: the previous message belonged elsewhere. Returns what
 * follows the phrase (often the right topic, e.g. "分错了，是论文的"), or undefined.
 */
export function spokenCorrection(text: string): string | undefined {
  const match = /^\s*(?:不对[，,。！!\s]*)?(?:你)?(?:分错(?:话题)?了?|放错(?:话题|地方)了?|不是(?:这个|这件事的?)话题|不属于这个话题|话题(?:不对|错了)|(?:that|this)(?:'s| is| was) (?:the )?wrong topic|wrong topic)(?=$|[，,。.!！:：\s])[，,。.!！:：\s]*/i.exec(text)
  return match ? text.slice(match[0].length).trim() : undefined
}

const FILLER = new Set(['这个', '那个', '一下', '帮我', '可以', '什么', '怎么', '我们', '你们', '现在', '然后', '还有', '这是', '那是', '是不是', 'the', 'and', 'for', 'with', 'this', 'that'])

/** Scripts written without spaces between words (Chinese, Japanese): split into runs and pairs, not words. */
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu
/** Words of the other scripts (Latin with accents, Cyrillic, Korean, …), and digits. */
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_.+#-]+/gu  // applied after dense runs are blanked out

/** Runs of dense-script text and the words of every other script. */
function scriptTerms(text: string): { dense: string[]; words: string[] } {
  return { dense: text.match(DENSE) ?? [], words: text.replace(DENSE, ' ').match(WORD) ?? [] }
}

/** Search terms in the order they appear: dense-script runs of 2–8 characters, and words starting with a letter. */
export const SEARCH_TERM = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,8}|(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\p{L}(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{M}\p{N}_.+#-]){1,40}/gu

/** A few distinctive terms of a message, used to teach a topic what belongs to it. */
export function topicTerms(text: string, limit = 6): string[] {
  // Common particles split Chinese runs into the words around them.
  const words = redactRoutingText(text).replace(/[的了和与及把在是吗呢吧也就都还要给让被]/g, ' ')
  // Short ASCII words are mostly noise ("to", "an"); two letters of another script often make a word.
  const terms = (words.match(SEARCH_TERM) ?? []).filter(term => term.length >= 3 || /[^\x00-\x7f]/.test(term))
  return [...new Set(terms.filter(term => !FILLER.has(term.toLowerCase()) && !term.startsWith('REDACTED')))].slice(0, limit)
}

/** Word and character-pair features of a short message, for cheap similarity without a model call. */
export function textFeatures(text: string): Set<string> {
  const { dense, words } = scriptTerms(redactRoutingText(text).toLowerCase())
  const features = new Set<string>()
  for (const word of words) features.add(word)
  for (const run of dense) {
    if (run.length === 1) features.add(run)
    for (let index = 0; index + 1 < run.length; index++) features.add(run.slice(index, index + 2))
  }
  return features
}

/** Overlap of two feature sets, 0 (nothing shared) to 1 (identical). */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const feature of a) if (b.has(feature)) shared++
  return shared / Math.sqrt(a.size * b.size)
}

export const MERGE_SHARED_NAMES = 2
export const MERGE_TITLE_SIMILARITY = 0.6
export const MERGE_NAME_MIN_LENGTH = 2
export const MERGE_ENGLISH_NAME_MIN_LETTERS = 3

export interface MergeTopic { title: string; names?: readonly string[]; entities?: readonly string[]; cwd?: string }

/** Only whole names count; a shared generic word inside a longer name is not another entity. */
export function mergeSimilarity(a: MergeTopic, b: MergeTopic): { sharedNames: number; titleSimilarity: number } | undefined {
  const folder = (cwd?: string) => {
    if (!cwd) return ''
    const windows = /^[a-z]:[\\/]|^[\\/]{2}/i.test(cwd)
    const normalized = windows ? win32.normalize(cwd) : normalize(cwd)
    const path = normalized.replace(/[\\/]+$/, '') || normalized
    return windows || process.platform === 'win32' ? path.toLowerCase() : path
  }
  if (folder(a.cwd) !== folder(b.cwd)) return undefined
  const names = (topic: MergeTopic) => new Set([topic.title, ...topic.names ?? [], ...topic.entities ?? []]
    .map(name => name.toLowerCase().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, ''))
    .filter(name => [...name].length >= MERGE_NAME_MIN_LENGTH && (!/^[a-z\s-]+$/.test(name) || (name.match(/[a-z]/g)?.length ?? 0) >= MERGE_ENGLISH_NAME_MIN_LETTERS)))
  const left = names(a), right = names(b)
  const sharedNames = [...left].filter(name => right.has(name)).length
  const titleSimilarity = similarity(textFeatures(a.title), textFeatures(b.title))
  return sharedNames >= MERGE_SHARED_NAMES || titleSimilarity >= MERGE_TITLE_SIMILARITY ? { sharedNames, titleSimilarity } : undefined
}
