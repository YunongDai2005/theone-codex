/**
 * The topic cluster under TheOne's main-chat card: every topic is a round cell like the One mark, the cells
 * cling together like a raft of soap bubbles, and routing plays out on them (a message travels as a vesicle
 * into the topic it went to, new topics bud off the mark, answers travel back). Plain DOM and SVG; the host
 * feeds a model and routing events and receives the user's gestures as actions.
 */

/** idle, answering, waiting for a free slot, answered and not yet shown in main chat, waiting on the user (a question or approval), or failed/interrupted. */
export type FoamPhase = 'idle' | 'running' | 'queued' | 'answered' | 'waiting' | 'failed'
/**
 * What a topic is doing, as precisely as TheOne's state says, for its details and the all-topics list (the cell draws
 * only the phase): routing, starting, answering or recovering are all "running"; a question and an approval are both "waiting".
 */
export type FoamStatus = FoamPhase | 'routing' | 'starting' | 'recovering' | 'question' | 'approval'
/** Why a queued topic waits, when TheOne says. */
export type FoamQueueReason = 'host_queue' | 'capacity' | 'topic_busy' | 'project_busy' | 'handoff'

export interface FoamTopic {
  id: string
  title: string
  /** A short name for the cell when the title is too long (e.g. the topic's main keyword); the full title shows on hover. */
  label?: string
  /** 0..1, how recently and often the topic was used; bigger and higher up when recent. */
  weight: number
  phase: FoamPhase
  /** Main chat is attached to this topic. */
  current?: boolean
  /** A clarifying question in main chat names this topic as one of the candidates. */
  asking?: boolean
  /** The user set it aside (TheOne's "done"); it waits in the fold until a message reaches it again. */
  aside?: boolean
  /** A one-off aside question: small, and folds away once answered. */
  oneOff?: boolean
  /** Topic workspace id; topics of one workspace stick together. */
  group?: string
  /** When the current run started (ms since epoch), for the running hint. */
  startedAt?: number
  /** The finer status for the topic's details; without it the phase stands in. */
  status?: FoamStatus
  queueReason?: FoamQueueReason
  /** Last activity (ms since epoch), for the order of the all-topics list. */
  lastActive?: number
}

export interface FoamModel {
  topics: FoamTopic[]
  /** Learned or manual relatedness between topics, 0..1 (negative: the user kept them apart). */
  links?: { a: string; b: string; weight: number }[]
  /** Merges waiting for the topics to go quiet. */
  pendingMerges?: { id: string; into: string; state?: 'queued' | 'executing'; operationId?: string }[]
  /** Finished merges that can still be taken apart, newest first: the target cell's menu offers to undo them. */
  merges?: { sourceId: string; targetId: string; title: string }[]
  /** Possible duplicates TheOne keeps for the user to decide: a quiet dotted relation between the two cells. */
  suggestions?: FoamSuggestion[]
}

/** One possible duplicate: the pair, and both ways of merging it (source goes into target), TheOne's default first. */
export interface FoamSuggestion { id: string; a: string; b: string; directions: { sourceId: string; targetId: string }[] }

export type FoamEvent =
  /** A message settled on a topic; `alternates` were the other close candidates, they only flicker. */
  | { kind: 'route'; to: string; related?: string[]; alternates?: string[]; messageId?: string }
  /** More input for a topic that is already answering (steering). */
  | { kind: 'supplement'; to: string }
  | { kind: 'create'; to: string }
  /** Routing is truly blocked and needs the user: the vesicle waits between the candidates. */
  | { kind: 'clarify'; candidates: string[] }
  | { kind: 'resolve'; to?: string }
  | { kind: 'correct'; from: string; to: string; messageId?: string }
  /** Two topics became one. `undo`: offer the undo chip (a queued merge that just finished). */
  | { kind: 'merged'; id: string; into: string; undo?: boolean }
  /** A merge was taken apart: the source is a topic of its own again. */
  | { kind: 'unmerged'; id: string; into: string }
  /** A queued merge ended without merging (cancelled, expired or failed); `error` is TheOne's code when it gave one. */
  | { kind: 'mergeEnded'; id: string; into: string; failed: boolean; error?: string }

export type FoamTextKey =
  | 'more' | 'running' | 'queued' | 'answered' | 'asking' | 'bond' | 'waiting' | 'failed' | 'menuAnswer' | 'offer' | 'rerouteBusy' | 'rerouteFailed' | 'actionFailed' | 'mergeFailed' | 'mergeConflict' | 'mergeBusy' | 'mergeExpired' | 'pickMerging' | 'mergeHold' | 'undo' | 'menuCancelMerge' | 'menuUnmerge'
  | 'dropMain' | 'dropMerge' | 'dropMergeLater' | 'dropSession' | 'busyFling' | 'currentFling'
  | 'menuContinue' | 'menuOpen' | 'menuAside' | 'menuDelete' | 'menuStop' | 'menuCancel' | 'menuShowNow' | 'menuWorkspace' | 'menuReroute' | 'menuMergeInto' | 'mergeIntoPick'
  | 'allTopics' | 'allWaiting' | 'filter' | 'noMatch'
  | 'statusCurrent' | 'statusAside' | 'statusRouting' | 'statusStarting' | 'statusRunning' | 'statusRecovering' | 'statusQueued' | 'queueCapacity' | 'queueTopic' | 'queueProject'
  | 'statusAnswered' | 'statusQuestion' | 'statusApproval' | 'statusWaiting' | 'statusFailed'
  | 'dupMenu' | 'dupTip' | 'dupTitle' | 'dupInto' | 'dupNo' | 'dupLater'

export interface FoamActions {
  mount(id: string): void
  /** Merge `id` into `into`: merged now, queued until TheOne is free, or refused. */
  merge(id: string, into: string): Promise<'merged' | 'queued' | 'failed'>
  /** Cancel a queued merge of `id`. */
  /** Cancel a queued merge of `id`; resolves to whether TheOne cancelled it. */
  cancelMerge(operationId: string): Promise<boolean>
  /** Take a finished merge apart; resolves to whether TheOne did it. */
  unmerge(sourceId: string): Promise<boolean>
  /**
   * Answer a possible duplicate: accept merges in the chosen direction (merged now, queued, or refused),
   * decline says they are not the same thing, later leaves it pending. Resolves to the outcome.
   */
  answerSuggestion(id: string, response: 'accept' | 'decline' | 'later', direction?: { sourceId: string; targetId: string }): Promise<'merged' | 'queued' | 'done' | 'failed'>
  attach(id: string, sessionId: string): Promise<boolean>
  /** Declare the topic done for now; resolves to whether TheOne accepted it. */
  putAside(id: string): Promise<boolean>
  open(id: string): void
  stop(id: string): void
  cancelQueued(id: string): void
  remove(id: string): void
  showAnswer(id: string): void
  /** Move a message routing hesitated over into the topic the user picked; resolves to the HTTP status. */
  reroute(messageId: string, to: string): Promise<number>
  /** Go to where the topic waits on the user (its question or approval in main chat). */
  answer(id: string): void
  openWorkspace(): void
  text(key: FoamTextKey, vars?: Record<string, string | number>): string
}

export interface FoamOptions {
  /** Box right under the main card; resting cells keep clear of it, while messages and intentional drags can cross it. */
  host: HTMLElement
  /** The One mark in the main card: messages leave from it and answers return to it. */
  mark: () => Element | null
  /** The sidebar: a cell thrown past its edge is set aside. */
  side: () => Element | null
  actions: FoamActions
  /** The cluster's height changed; the host makes room for it. */
  onHeight(height: number): void
  /** Called at the start of every frame, so the host can keep the box aligned under the card. */
  place?(): void
  /** How much the mark should swell right now (0..1): a message left, or an answer arrived. */
  onPulse?(amount: number): void
  /** The sidebar starts collapsed: begin with the small cells instead of shrinking into them. */
  rail?: boolean
}

export interface Foam {
  update(model: FoamModel): void
  event(event: FoamEvent): void
  setRail(on: boolean): void
  destroy(): void
}

const NS = 'http://www.w3.org/2000/svg'
const MAX_VISIBLE = 14, N = 48, GAP = 2, SOFT = 2.2, MINI = .32, MARK_R = 7.4, STRIP = 18, TOP_GAP = 8
const fx = (v: number) => v.toFixed(2)
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const ease = (v: number, target: number, rate: number, dt: number) => v + (target - v) * Math.min(1, dt * rate)
const now = () => performance.now()
interface Pt { x: number; y: number }

/** A closed smooth outline, translated as a whole to keep its Bezier control hull below `minY`. */
export function foamContour(p: number[][], minY = -Infinity): { path: string; points: number[][]; offsetY: number } {
  const n = p.length
  let low = Infinity
  if (Number.isFinite(minY)) for (let i = 0; i < n; i++) {
    const y0 = p[(i + n - 1) % n][1], y1 = p[i][1], y2 = p[(i + 1) % n][1], y3 = p[(i + 2) % n][1]
    low = Math.min(low, y1, y1 + (y2 - y0) / 6, y2 - (y3 - y1) / 6)
  }
  // Round upward to the SVG coordinate precision, so rounding cannot put a control back above the boundary.
  const offsetY = Math.ceil(Math.max(0, minY - low) * 100) / 100
  if (offsetY) p = p.map(([x, y]) => [x, y + offsetY])
  let d = `M${fx(p[0][0])} ${fx(p[0][1])}`
  for (let i = 0; i < n; i++) {
    const p0 = p[(i + n - 1) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n]
    d += `C${fx(p1[0] + (p2[0] - p0[0]) / 6)} ${fx(p1[1] + (p2[1] - p0[1]) / 6)} ${fx(p2[0] - (p3[0] - p1[0]) / 6)} ${fx(p2[1] - (p3[1] - p1[1]) / 6)} ${fx(p2[0])} ${fx(p2[1])}`
  }
  return { path: d + 'Z', points: p, offsetY }
}
/** Smooth minimum: where two cells meet, the contact face bends into rounded corners like a bubble wall. */
const smin = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k / 4 }
function polygonArea(p: number[][]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; s += x1 * y2 - x2 * y1 }
  return Math.abs(s) / 2
}

/** A membrane neck between two round bodies: budding off the mark, two topics fusing, or a pending merge. */
function bridge(c1: Pt, r1: number, c2: Pt, r2: number, reach = r2 * 2.5, v = .5, hs = 2.4): { edge: string; fill: string } | null {
  const d = Math.hypot(c2.x - c1.x, c2.y - c1.y), maxD = r1 + reach
  if (r1 <= 0 || r2 <= 0 || d > maxD || d <= Math.abs(r1 - r2)) return null
  let u1 = 0, u2 = 0
  if (d < r1 + r2) {
    u1 = Math.acos(clamp((r1 * r1 + d * d - r2 * r2) / (2 * r1 * d), -1, 1))
    u2 = Math.acos(clamp((r2 * r2 + d * d - r1 * r1) / (2 * r2 * d), -1, 1))
  }
  const ab = Math.atan2(c2.y - c1.y, c2.x - c1.x), spread = Math.acos(clamp((r1 - r2) / d, -1, 1))
  const a1 = ab + u1 + (spread - u1) * v, a2 = ab - u1 - (spread - u1) * v
  const a3 = ab + Math.PI - u2 - (Math.PI - u2 - spread) * v, a4 = ab - Math.PI + u2 + (Math.PI - u2 - spread) * v
  const P = (c: Pt, a: number, r: number) => [c.x + r * Math.cos(a), c.y + r * Math.sin(a)]
  const p1 = P(c1, a1, r1), p2 = P(c1, a2, r1), p3 = P(c2, a3, r2), p4 = P(c2, a4, r2)
  const tot = r1 + r2, k = Math.min(v * hs, Math.hypot(p1[0] - p3[0], p1[1] - p3[1]) / tot) * Math.min(1, d * 2 / tot)
  const H = (p: number[], a: number, r: number) => [p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)]
  const h1 = H(p1, a1 - Math.PI / 2, r1 * k), h2 = H(p2, a2 + Math.PI / 2, r1 * k), h3 = H(p3, a3 + Math.PI / 2, r2 * k), h4 = H(p4, a4 - Math.PI / 2, r2 * k)
  const s = (p: number[]) => fx(p[0]) + ' ' + fx(p[1])
  return { edge: `M${s(p1)}C${s(h1)} ${s(h3)} ${s(p3)}M${s(p4)}C${s(h4)} ${s(h2)} ${s(p2)}`,
    fill: `M${s(p1)}C${s(h1)} ${s(h3)} ${s(p3)}L${s(p4)}C${s(h4)} ${s(h2)} ${s(p2)}Z` }
}

/**
 * The name a cell can carry: the topic's own short label when it has one, else the title up to its first
 * punctuation ("想去日本旅游，帮我看看行程" → "想去日本旅游"). Always a whole phrase, never cut mid-word.
 */
export function foamShortName(title: string, label?: string): string {
  if (label?.trim()) return label.trim()
  const head = title.split(/[，,。.？?！!：:；;、（）()【】[\]—\-|/]/).map(part => part.trim()).find(Boolean)
  return head ?? title.trim()
}

/**
 * How a name sits in a cell: one line if it fits, else two (big cells: three) balanced lines, else no text. Never a clipped name.
 * A CJK name breaks between any two characters, as evenly as it can with the first line the longer (so 显卡选购 is 显卡 /
 * 选购); a Latin word is never split, so Latin words break only between words or where they meet CJK, and one word that does
 * not fit on a line leaves the cell without text. Punctuation stays with its neighbour: no line starts with a comma or a
 * closing bracket, none ends with an opening one, and none holds punctuation alone.
 */
export function foamLabel(name: string, radius: number): { lines: string[]; font: number; lh: number } {
  const chars = [...name.trim()], big = radius >= 25 ? 10.5 : 9.5, small = radius >= 25 ? 9.5 : 8.8
  // A Latin letter takes about 0.6 of a CJK character's width.
  const width = (s: string[]) => s.reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? 1 : .6), 0)
  // Unbreakable pieces: a Latin word (accented letters and digits included, with its inner marks) or one other character,
  // with any opening punctuation before it and closing punctuation after it; opening punctuation with nothing after it on
  // its side of a space is a piece of its own, so every character of the name lands in some piece. `gap`: a space came before.
  const open = `(\\[{<"'“‘「『（《〈【〔［｛`, close = `,.;:!?)\\]}>"'”’」』，。、；：！？）》〉】〕］｝…`
  const piece = new RegExp(`(\\s*)([${open}]*(?:[\\p{Script=Latin}\\p{Nd}][\\p{Script=Latin}\\p{M}\\p{Nd}'’.\\-+&_]*|[^\\s${open}])[${close}]*|[${open}]+)`, 'gu')
  const raw = [...name.trim().matchAll(piece)].map(m => ({ text: m[2], gap: m[1].length > 0 }))
  // A piece of punctuation alone (spaces around it, as in "Hello , world" or "( beta )") never stands on a line by itself:
  // opening marks go with the piece after them, everything else with the piece before, the space kept where it was.
  const opening = new RegExp(`^[${open}\\s]+$`), bare = (t: { text: string }) => !/[\p{L}\p{N}]/u.test(t.text)
  const tokens: { text: string; gap: boolean }[] = []
  for (const t of raw) {
    const last = tokens[tokens.length - 1]
    if (last && opening.test(last.text) && !(bare(t) && !opening.test(t.text))) { last.text += (t.gap ? ' ' : '') + t.text; continue }
    if (last && bare(t) && !opening.test(t.text)) { last.text += (t.gap ? ' ' : '') + t.text; continue }
    tokens.push({ ...t })
  }
  const lineOf = (ts: typeof tokens) => ts.map((t, i) => (i && t.gap ? ' ' : '') + t.text).join('')
  /** The name over `n` lines with the narrowest widest line, breaking only between pieces; on a tie the earlier lines are the longer. */
  const balance = (n: number): string[] => {
    let best: string[] = [], bestW = Infinity
    const cut = (from: number, left: number, acc: string[]) => {
      if (left === 1) {
        const all = [...acc, lineOf(tokens.slice(from))], w = Math.max(...all.map(l => width([...l])))
        if (w <= bestW + 1e-9) { best = all; bestW = w }
        return
      }
      for (let k = from + 1; k <= tokens.length - left + 1; k++) cut(k, left - 1, [...acc, lineOf(tokens.slice(from, k))])
    }
    cut(0, n, [])
    return best
  }
  const tries: [number, number][] = [[1, big], [1, small], [2, big], [2, small], [3, small]]
  for (const [lines, font] of tries) {
    if (lines === 1 && font === small && width(chars) > 3 && radius < 25) continue
    if (lines === 2 && (chars.length < 4 || width(chars) > 8 || tokens.length < 2)) continue
    if (lines === 3 && (radius < 25 || chars.length < 7 || width(chars) > 9 || tokens.length < 3)) continue
    const lh = font * 1.18
    const parts = balance(lines)
    const widest = Math.max(...parts.map(p => width([...p]))) * font
    if (widest > 2 * radius * (lines === 1 ? .8 : lines === 2 ? .74 : .7) - 4 || (lines === 3 ? 6 : 9) + parts.length * lh > 2 * radius * .86) continue
    return { lines: parts, font, lh }
  }
  return { lines: [], font: big, lh: 0 }
}

/** How strongly a neighbour of the cell being read shows its name: a hint, so one name reads at a time. */
const NEIGHBOUR_NAME = .3

/**
 * The cell the pointer is reading, by the same hit circles a press uses (`r`): the cell it is on (nearest centre
 * where circles meet, as for a press), else the nearest outline within `reach` px, else none (-1). The cell read
 * before (`prev`) keeps the name while the pointer stays within `keep` px of it and is not clearly inside another,
 * so a slow pointer on a shared edge does not swap names back and forth.
 */
export function foamFocus(items: readonly { x: number; y: number; r: number }[], ptr: { x: number; y: number } | null | undefined, prev = -1, keep = 3, reach = 8): number {
  if (!ptr) return -1
  const at = (i: number) => Math.hypot(ptr.x - items[i].x, ptr.y - items[i].y)
  const hit = foamNearest(ptr, items as { x: number; y: number; r: number }[])
  if (prev >= 0 && prev < items.length && at(prev) <= items[prev].r + keep && (hit < 0 || hit === prev || at(hit) > items[hit].r - keep)) return prev
  if (hit >= 0) return hit
  let best = -1, gap = reach
  items.forEach((c, i) => { const g = at(i) - c.r; if (g < gap) { gap = g; best = i } })
  return best
}

/**
 * Invisible hit circles for the cells: each at least `min` (half of 24 CSS px) where there is room, never into a
 * neighbour's (the free space between two cells is split by their own sizes), never past the cluster box (so it
 * covers nothing of DSH outside it), and never smaller than `floor`, the part of the cell's own outline it must
 * keep (default its radius). An explicit `box.top` excludes the main-card gap even when the outline floor would cross it.
 * Returns one radius per item.
 */
export function foamHitRadii(items: { x: number; y: number; r: number; floor?: number }[], box?: { w: number; h: number; top?: number }, min = 12): number[] {
  const floor = items.map(a => Math.min(Math.max(0, a.floor ?? a.r), box?.top === undefined ? Infinity : Math.max(0, a.y - box.top)))
  const dist = (i: number, j: number) => Math.hypot(items[j].x - items[i].x, items[j].y - items[i].y)
  const h = items.map((a, i) => {
    let v = Math.max(a.r, min)
    for (let j = 0; j < items.length; j++) if (j !== i) v = Math.min(v, a.r + (dist(i, j) - a.r - items[j].r) / 2)
    if (box) v = Math.min(v, a.x, box.w - a.x, a.y - (box.top ?? 0), box.h - a.y)
    return Math.max(v, floor[i])
  })
  // A circle held up by its floor may still reach into a neighbour's: both give way, each down to its own floor at most.
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const over = h[i] + h[j] - dist(i, j), si = h[i] - floor[i], sj = h[j] - floor[j]
    if (over <= 0 || si + sj <= 0) continue
    const k = Math.min(1, over / (si + sj))
    h[i] -= si * k; h[j] -= sj * k
  }
  return h
}

/**
 * Hit circles for the cells and the duplicate pores, shared out together: a pore is a point with no outline of its own, so the
 * room around it is split with the cells (see `foamHitRadii`). A pore gets at most `max`, never over any cell's outline (`reach`,
 * its farthest edge) or hit circle, a third cell's included; when that leaves it under `need` (a pore that was shown keeps it
 * down to 1px less, so it does not blink at the edge) it gets 0 (not shown), and the cells get back the room it would have taken.
 */
export function foamPoreHits(cells: { x: number; y: number; r: number; floor?: number; reach?: number }[], pores: { x: number; y: number; shown?: boolean }[],
  box?: { w: number; h: number; top?: number }, max = 8, need = 5.5): { cells: number[]; pores: number[] } {
  const size = (ps: typeof pores) => foamHitRadii([...cells, ...ps.map(p => ({ x: p.x, y: p.y, r: 0, floor: 0 }))], box)
  const room = (ps: typeof pores, radii: number[]) => ps.map((p, i) => {
    let r = Math.min(max, radii[cells.length + i])
    cells.forEach((c, j) => { r = Math.min(r, Math.hypot(p.x - c.x, p.y - c.y) - Math.max(radii[j], c.reach ?? c.r)) })
    return r >= (p.shown ? need - 1 : need) ? r : 0
  })
  let radii = size(pores), out = room(pores, radii)
  if (out.some(r => !r)) {
    const kept = pores.filter((_, i) => out[i] > 0)
    radii = size(kept)
    const again = room(kept.map(p => ({ ...p, shown: true })), radii)
    let k = 0
    out = out.map(r => r > 0 ? again[k++] : 0)
  }
  return { cells: radii.slice(0, cells.length), pores: out }
}

/**
 * The two places the pore of two touching cells can sit: not their contact point, where no hit circle can fit, but the
 * notches on either side where their outlines curve apart, `clear` px off both (the hit circles share that gap with the
 * pore, so 12 px leaves it its 5.5 px). `contact` is the point between the outlines, where the pore's stalk starts.
 */
export function foamNotches(a: { x: number; y: number; reach: number }, b: { x: number; y: number; reach: number }, clear = 12):
  { contact: { x: number; y: number }; sides: { x: number; y: number }[] } {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || .01, ux = dx / d, uy = dy / d
  const gap = (d - a.reach - b.reach) / 2, mx = a.x + ux * (a.reach + gap), my = a.y + uy * (a.reach + gap)
  const t = Math.max(0, ...[a, b].map(c => Math.sqrt(Math.max(0, (c.reach + clear) ** 2 - (c.reach + gap) ** 2))))
  return { contact: { x: mx, y: my }, sides: [1, -1].map(s => ({ x: mx - uy * t * s, y: my + ux * t * s })) }
}

/**
 * Which candidate spot a pore takes, by the room it would get under the same sharing rule as foamPoreHits: half the gap to
 * each cell's outline (the cell's hit circle takes the other half), the whole way to the box edges, at most `max`. The spot it
 * had (`prev`) is kept while it still fits (a shown pore with 1 px to spare, as foamPoreHits keeps it; a hidden one only with
 * the full room it needs to appear, so it never stays hidden where the other spot has room), and always while `locked`
 * (pointed at, or its panel open), so a
 * neighbour drifting by never makes it jump; otherwise the roomiest spot that fits wins, else the roomiest at all (and
 * foamPoreHits then hides it). Returns the index into `spots`.
 */
export function foamPoreSpot(spots: readonly { x: number; y: number }[], prev: number, cells: readonly { x: number; y: number; reach: number }[],
  box?: { w: number; h: number; top?: number }, locked = false, shown = true, need = 5.5, max = 8): number {
  const room = (p: { x: number; y: number }) => Math.min(max, ...cells.map(c => (Math.hypot(p.x - c.x, p.y - c.y) - c.reach) / 2),
    ...(box ? [p.x, box.w - p.x, p.y - (box.top ?? 0), box.h - p.y] : []))
  const rooms = spots.map(room)
  if (prev >= 0 && prev < spots.length && (locked || rooms[prev] >= (shown ? need - 1 : need))) return prev
  let best = 0
  rooms.forEach((r, i) => { if (r > rooms[best] + 1e-9) best = i })
  return best
}

/** Which item a point means: among those whose circle holds it, the one with the nearest centre; -1 for none. */
export function foamNearest(p: { x: number; y: number }, items: { x: number; y: number; r: number }[]): number {
  let best = -1, bestD = Infinity
  items.forEach((a, i) => { const d = Math.hypot(p.x - a.x, p.y - a.y); if (d <= a.r && d < bestD) { best = i; bestD = d } })
  return best
}

export interface FoamBox { left: number; top: number; right: number; bottom: number }
export interface FoamPlaceOptions {
  /** The side tried first; flips to the other when it does not fit. */
  side?: 'above' | 'below'
  /** Centred on the anchor (a hint), or starting at its left edge and flipping to end at its right edge (a menu at the pointer). */
  align?: 'center' | 'start'
  gap?: number
  /** Kept free at every viewport edge. */
  margin?: number
}

/** Where a floating box of `size` goes next to `anchor` so it stays whole inside the viewport on all four sides. */
export function foamPlace(size: { w: number; h: number }, anchor: FoamBox, view: { w: number; h: number }, opts: FoamPlaceOptions = {}): { left: number; top: number; side: 'above' | 'below' } {
  const m = opts.margin ?? 8, g = opts.gap ?? 6, { w, h } = size
  const above = anchor.top - g - h, below = anchor.bottom + g
  const fitsAbove = above >= m, fitsBelow = below + h <= view.h - m
  let side = opts.side ?? 'above'
  if (side === 'above' ? !fitsAbove : !fitsBelow) {
    if (side === 'above' ? fitsBelow : fitsAbove) side = side === 'above' ? 'below' : 'above'
    else side = anchor.top - m >= view.h - m - anchor.bottom ? 'above' : 'below'
  }
  const top = Math.max(m, Math.min(side === 'above' ? above : below, view.h - m - h))
  let left = opts.align === 'start' ? anchor.left : (anchor.left + anchor.right) / 2 - w / 2
  if (opts.align === 'start' && left + w > view.w - m) left = anchor.right - w
  left = Math.max(m, Math.min(left, view.w - m - w))
  return { left, top, side }
}

/** Places a fixed-position element next to `anchor` within the viewport (see `foamPlace`); returns where it went. */
export function foamClampToViewport(el: HTMLElement, anchor: FoamBox, opts: FoamPlaceOptions = {}) {
  el.style.left = '0px'; el.style.top = '0px'
  const r = el.getBoundingClientRect(), root = document.documentElement
  const p = foamPlace({ w: r.width, h: r.height }, anchor, { w: root.clientWidth || innerWidth, h: root.clientHeight || innerHeight }, opts)
  el.style.left = p.left + 'px'; el.style.top = p.top + 'px'; el.dataset.side = p.side
  return p
}

/**
 * Keyboard for a menu-like popover: Up/Down move between its items (wrapping), Home/End jump to the first/last,
 * Enter/Space activate, Escape and Tab call `close`. Returns a function that removes the handler.
 */
export function foamMenuKeys(el: HTMLElement, close: () => void, items = '[role=menuitem]:not([disabled])'): () => void {
  const onKey = (e: KeyboardEvent) => {
    const list = Array.from(el.querySelectorAll<HTMLElement>(items)), at = list.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => { e.preventDefault(); e.stopPropagation(); list[(i + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(at < 0 ? 0 : at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? list.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) { e.preventDefault(); e.stopPropagation(); list[at].click() }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close() }
  }
  el.addEventListener('keydown', onKey)
  return () => el.removeEventListener('keydown', onKey)
}

/** A topic's short status in words for its details and the all-topics list; empty for a plain idle topic. Says only what TheOne's state supports. */
export function foamStatusText(topic: Pick<FoamTopic, 'phase' | 'status' | 'queueReason' | 'current' | 'aside'>, text: (key: FoamTextKey) => string): string {
  const status = topic.status ?? topic.phase
  const key: FoamTextKey | null = status === 'routing' ? 'statusRouting' : status === 'starting' ? 'statusStarting' : status === 'running' ? 'statusRunning'
    : status === 'recovering' ? 'statusRecovering' : status === 'answered' ? 'statusAnswered' : status === 'question' ? 'statusQuestion'
    : status === 'approval' ? 'statusApproval' : status === 'waiting' ? 'statusWaiting' : status === 'failed' ? 'statusFailed'
    : status === 'queued' ? (topic.queueReason === 'capacity' ? 'queueCapacity' : topic.queueReason === 'topic_busy' ? 'queueTopic' : topic.queueReason === 'project_busy' ? 'queueProject' : 'statusQueued')
    : null
  const parts = [topic.current ? text('statusCurrent') : '', key ? text(key) : '', topic.aside && !key ? text('statusAside') : '']
  return parts.filter(Boolean).join(' · ')
}

/**
 * The all-topics list's order: the topic main chat is in, then the ones doing something, then the rest, set-aside
 * topics last; most recent first within each, ties by name, so the order is the same every time it opens.
 */
export function foamOrder(topics: readonly FoamTopic[]): FoamTopic[] {
  const rank = (t: FoamTopic) => t.current ? 0 : t.phase !== 'idle' ? 1 : t.aside ? 3 : 2
  return [...topics].sort((a, b) => rank(a) - rank(b) || (b.lastActive ?? 0) - (a.lastActive ?? 0) || b.weight - a.weight
    || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Type-to-filter: a plain, case-insensitive substring of the title or the short label. Read-only. */
export function foamFilter<T extends Pick<FoamTopic, 'title' | 'label'>>(topics: readonly T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase()
  return q ? topics.filter(t => t.title.toLocaleLowerCase().includes(q) || !!t.label?.toLocaleLowerCase().includes(q)) : [...topics]
}

/** Whether an Enter in a text field means "do it": never while an input method is still composing (its Enter confirms the text). */
export function foamEnterActs(e: { key: string; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229
}

/** Topics already in a merge waiting to happen, as source or target (TheOne's pending merges and ones just asked for here). */
export function foamMerging(pending: FoamModel['pendingMerges'], local: Iterable<readonly [string, string]> = []): Set<string> {
  const out = new Set<string>()
  for (const m of pending ?? []) { out.add(m.id); out.add(m.into) }
  for (const [a, b] of local) { out.add(a); out.add(b) }
  return out
}

/** The short reason a merge did not happen, from TheOne's error code; the generic one for anything else. */
export function foamMergeReason(error?: string): FoamTextKey {
  return error === 'MERGE_CONFLICT' ? 'mergeConflict' : error === 'GATEWAY_BUSY' || error === 'TOPIC_BUSY' ? 'mergeBusy' : error === 'MERGE_EXPIRED' ? 'mergeExpired' : 'mergeFailed'
}

type CellState = 'idle' | 'running' | 'queued' | 'done' | 'wait' | 'fail'
interface Cell {
  id: string; kind: 'topic' | 'more'; title: string; short?: string; state: CellState; cur: boolean; ask: boolean; aside: boolean; oneOff: boolean
  group?: string; w: number; startedAt?: number
  g: SVGGElement; gr: SVGRadialGradientElement; stop: SVGStopElement; b: SVGPathElement; h: SVGPathElement; m: SVGPathElement; n: SVGCircleElement; label: SVGTextElement
  neck: SVGGElement; nf: SVGPathElement; ne: SVGPathElement
  mode: 'bud' | 'live' | 'leave' | 'fling'; age: number; hidden: boolean; away: boolean; rebud: boolean; onBorn?: () => void; into?: Cell
  x: number; y: number; vx: number; vy: number; svx: number; svy: number; tx: number; ty: number; R: number; scale: number; alpha: number
  heat: number; solid: number; kick: number; flash: number; reveal: number; want: number; focus: number; nx: number; ny: number; cx: number; cy: number
  offer?: { messageId: string; until: number }
  /** A move of `messageId` here is on its way; only the answer to request `req` ends it. */
  reroute?: { messageId: string; req: number }
  /** Thrown aside and TheOne has not answered yet: a refusal brings it back even after the throw animation ended. */
  flung?: boolean
  phase: number; shownKey: string; full: boolean; lay: { lines: string[]; font: number; lh: number }; showing: boolean
  /** The invisible hit circle under the outline, its radius, and the outline's nearest and farthest reach from the centre. */
  hc: SVGCircleElement; hit: number; vin: number; vr: number
}
interface Vesicle { el: SVGGElement; from: () => Pt; to: () => Pt; arrive: () => void; t: number; dur: number; hold: number | (() => boolean); toMark: boolean }

export function createFoam(options: FoamOptions): Foam {
  const { host, actions } = options
  // Read live, so switching reduced motion on takes effect without a reload.
  const motion = matchMedia('(prefers-reduced-motion: reduce)'), reduced = () => motion.matches
  host.classList.add('theone-foam')
  host.classList.toggle('rail', !!options.rail)
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = '<defs></defs><g data-part="cells"></g><g data-part="necks"></g><g data-part="vesicles"></g>'
  host.appendChild(svg)
  const defs = svg.firstChild as SVGDefsElement, layer = svg.children[1] as SVGGElement, necks = svg.children[2] as SVGGElement, vlayer = svg.children[3] as SVGGElement
  // Possible duplicates: the dotted thread lies under the cells, so only the gap between the two shows it; its small pore sits on top to be clicked.
  const threads = document.createElementNS(NS, 'g'), pores = document.createElementNS(NS, 'g')
  threads.setAttribute('data-part', 'threads'); pores.setAttribute('data-part', 'pores'); layer.before(threads); vlayer.before(pores)
  const tip = document.createElement('div'); tip.className = 'theone-foam-tip'; document.body.appendChild(tip)
  // The cells are drawn, not focusable: a visually hidden list of buttons gives keyboard and screen-reader users the same topics.
  const list = document.createElement('div'); list.className = 'theone-foam-list'; list.setAttribute('role', 'list'); host.appendChild(list)
  const keys = new Map<string, HTMLButtonElement>()
  // A quiet, always-there way to every topic (also on the collapsed rail and with nothing folded): a small line-drawn cluster under the cells.
  const entry = document.createElement('button')
  entry.type = 'button'; entry.className = 'theone-foam-all'; entry.hidden = true; entry.setAttribute('aria-haspopup', 'dialog')
  entry.innerHTML = '<svg viewBox="0 0 22 14" aria-hidden="true"><circle cx="6.2" cy="8.4" r="3.7"/><circle cx="13.6" cy="5.6" r="3.9"/><circle cx="15.4" cy="11.3" r="1.9"/></svg><span></span>'
  const entryCount = entry.lastChild as HTMLSpanElement
  host.appendChild(entry)
  /** The open details of one topic, or the all-topics list; `back` gets focus again when it closes. The list keeps the order it opened with. */
  /** `mid`: details are bound to the message offered when they opened, so moving it never silently means a newer message. */
  let pop: { el: HTMLDivElement; kind: 'detail' | 'all'; id: string; back: HTMLElement | null; sig: string; order: string[]; query: string; pick?: string; mid?: string } | null = null

  const cells: Cell[] = [], ves: Vesicle[] = []
  let links = new Map<string, number>(), bonds: [Cell, Cell][] = []
  let rail = !!options.rail, sz = rail ? MINI : 1, height = 8, heightTarget = -1, heightV = 0, pulse = 0, folded = 0, uid = 0, first = true
  let L: Pt = { x: 0, y: 0 }, ptr: Pt | null = null
  /** A press on a cell; it becomes a drag only after the pointer has really moved. A merge needs the pointer to rest on the other cell first. */
  let drag: { cell: Cell; dx: number; dy: number; trail: { x: number; y: number; t: number }[]; started: boolean; last: Pt; origin: Pt; pointer: number; rest?: { cell: Cell; since: number } } | null = null
  let model: FoamModel = { topics: [] }
  const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'theone-foam-undo'; document.body.appendChild(undo)
  let undoTimer = 0
  let target: { kind: 'main' } | { kind: 'cell'; cell: Cell } | { kind: 'session'; el: Element; id: string } | null = null
  let clarifying: { cells: Cell[]; ves?: Vesicle } | null = null
  let menu: HTMLDivElement | null = null, tipOwner: Cell | null = null, raf = 0, last = now(), t = 0
  const pending: FoamEvent[] = []
  /** Merged here a moment ago (TheOne said 200): a snapshot from before may still list the source, so it is not brought back until then. */
  const gone = new Map<string, number>()
  let rerouteSeq = 0

  const sizeOf = (c: Cell) => c.kind === 'more' ? 16 : c.oneOff ? 21 : c.state === 'running' || c.state === 'done' || c.state === 'wait' || c.state === 'fail' || c.cur ? 29 : c.state === 'queued' ? 24 : 16 + 9 * c.w
  /** At rest only the topics doing something carry a name; the rest are plain cells until the pointer comes near. */
  const named = (c: Cell) => c.kind === 'more' || c.cur || c.state !== 'idle' || c.ask || !!c.offer || c.mode === 'bud'
  const busy = (c: Cell) => c.state === 'running' || c.state === 'queued' || c.state === 'wait' || c.state === 'done'
  const topics = () => cells.filter(c => c.kind === 'topic' && c.mode !== 'leave')
  const byId = (id: string) => cells.find(c => c.kind === 'topic' && c.id === id && c.mode !== 'leave')
  const linkW = (c: Cell, o: Cell) => (c.group && c.group === o.group ? .8 : 0) + (links.get(c.id + '|' + o.id) ?? 0)
  const local = (e: { clientX: number; clientY: number }) => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  const pos = (c: Cell): Pt => ({ x: c.cx, y: c.cy })
  const markPos = (): Pt => ({ x: L.x, y: L.y })
  /** The cell a pointer at this client point means: of the shown cells whose hit circle or outline holds it, the nearest centre. */
  function cellAt(x: number, y: number, skip?: Cell, topicsOnly = false): Cell | undefined {
    const r = host.getBoundingClientRect()
    const list = cells.filter(o => o !== skip && o.mode === 'live' && !o.hidden && o.scale >= .02 && (!topicsOnly || o.kind === 'topic'))
    const i = foamNearest({ x: x - r.left, y: y - r.top }, list.map(o => ({ x: o.cx, y: o.cy, r: Math.max(o.hit, o.vr) })))
    return i < 0 ? undefined : list[i]
  }
  /**
   * One target for reading, the hint and a press: the cell under the pointer by the press rule, held through a
   * shared edge. A new target restarts the hint's wait; the name itself comes up at once.
   */
  let reading: Cell | undefined, tipWait = 0
  function read(e: { clientX: number; clientY: number } | null): Cell | undefined {
    let next: Cell | undefined
    if (e && !drag) {
      const r = host.getBoundingClientRect()
      const list = cells.filter(o => o.mode === 'live' && !o.hidden && o.scale >= .02)
      next = list[foamFocus(list.map(o => ({ x: o.cx, y: o.cy, r: Math.max(o.hit, o.vr) })), { x: e.clientX - r.left, y: e.clientY - r.top }, reading ? list.indexOf(reading) : -1)]
    }
    if (next !== reading) {
      reading = next; clearTimeout(tipWait)
      if (tipOwner && tipOwner !== next && !drag) hideTip()
      if (next) tipWait = window.setTimeout(() => { if (!drag && reading === next) showTip(next) }, 420)
    }
    return reading
  }

  function makeCell(id: string, title: string, spawn: boolean): Cell {
    const gid = `theone-foam-${uid++}`
    const gr = document.createElementNS(NS, 'radialGradient')
    gr.id = gid; gr.setAttribute('r', '62%')
    gr.innerHTML = '<stop offset="0%" stop-color="var(--foam-heat)"/><stop offset="100%" stop-color="var(--foam-heat)" stop-opacity="0"/>'
    defs.appendChild(gr)
    const g = document.createElementNS(NS, 'g')
    g.setAttribute('class', 'theone-cell idle')
    g.innerHTML = `<path data-part="body"/><path data-part="heat" fill="url(#${gid})"/><path data-part="membrane"/><circle data-part="nucleus"/><text></text>`
    layer.appendChild(g)
    const neck = document.createElementNS(NS, 'g')
    neck.setAttribute('class', 'theone-neck'); neck.innerHTML = '<path data-part="fill"/><path data-part="edge"/>'
    necks.appendChild(neck)
    const hc = document.createElementNS(NS, 'circle'); hc.setAttribute('data-part', 'hit'); hc.setAttribute('r', '0')
    const w = host.clientWidth
    const c: Cell = { id, kind: 'topic', title, state: 'idle', cur: false, ask: false, aside: false, oneOff: false, w: .05, hc, hit: 0, vin: 0, vr: 0,
      g, gr, stop: gr.firstChild as SVGStopElement, b: g.children[0] as SVGPathElement, h: g.children[1] as SVGPathElement, m: g.children[2] as SVGPathElement,
      n: g.children[3] as SVGCircleElement, label: g.children[4] as SVGTextElement, neck, nf: neck.children[0] as SVGPathElement, ne: neck.children[1] as SVGPathElement,
      mode: spawn ? 'bud' : 'live', age: 0, hidden: false, away: false, rebud: false,
      x: spawn ? L.x : w / 2 + (Math.random() - .5) * 90, y: spawn ? L.y : 30 + Math.random() * 100, vx: 0, vy: 0, svx: 0, svy: 0, tx: 0, ty: 0,
      R: 20, scale: spawn ? .12 : 1, alpha: 1, heat: 0, solid: 1, kick: 0, flash: 0, reveal: 0, want: 0, focus: 1, nx: 0, ny: 0, cx: 0, cy: 0,
      phase: Math.random() * 6, shownKey: '', full: false, lay: { lines: [], font: 9.5, lh: 0 }, showing: false }
    // Drawn under the outline, so the outline looks the same; it only widens where a small cell can be pressed.
    g.insertBefore(hc, g.firstChild)
    g.addEventListener('pointerdown', e => {
      // Where hit areas and outlines meet, the press belongs to the cell being read: the one whose name is up.
      const o = read(e) ?? cellAt(e.clientX, e.clientY) ?? c
      // One gesture at a time: a second finger or pointer never takes over a drag.
      if (e.button || drag || o.mode !== 'live' || o.kind === 'more') return
      e.preventDefault(); clearTimeout(tipWait); hideTip()
      const p = local(e)
      drag = { cell: o, dx: p.x - o.x, dy: p.y - o.y, trail: [{ x: e.clientX, y: e.clientY, t: now() }], started: false, last: { x: e.clientX, y: e.clientY },
        origin: { x: e.clientX, y: e.clientY }, pointer: e.pointerId }
      o.tx = o.x; o.ty = o.y
      try { o.g.setPointerCapture(e.pointerId) } catch { /* Older engines: the window listeners still see the release. */ }
    })
    // "+N" opens the full list (folded topics included); Topic workspaces stays one row away at its foot.
    g.addEventListener('click', e => { const at = cellAt(e.clientX, e.clientY) ?? c; if (at.kind === 'more' && !drag) openAll(activeOrNull(), at.m.getBoundingClientRect()) })
    // Hover only tells what the cell cannot show itself: a name that did not surface, or what a busy topic is doing.
    g.addEventListener('contextmenu', e => { e.preventDefault(); clearTimeout(tipWait); hideTip(); openMenu(e.clientX, e.clientY, read(e) ?? cellAt(e.clientX, e.clientY) ?? c) })
    cells.push(c)
    return c
  }
  const more = makeCell('', '+0', false)
  more.kind = 'more'; more.g.classList.add('more'); more.hidden = true; more.scale = 0

  function setState(c: Cell, state: CellState) {
    if (c.state === state) return
    c.g.classList.remove(c.state); c.state = state; c.g.classList.add(state)
  }
  function light(c: Cell, related: Cell[] = []) {
    c.flash = 1; c.kick = 1
    c.g.classList.add('lit'); window.setTimeout(() => c.g.classList.remove('lit'), 900)
    for (const o of related) { o.flash = Math.max(o.flash, .45); o.kick = Math.max(o.kick, .5) }
  }
  function vesicle(from: () => Pt, to: () => Pt, arrive: () => void, dur = .7, hold: Vesicle['hold'] = 0): Vesicle {
    // Reduced motion: nothing flies; it arrives at once, and a held one appears where it waits.
    if (reduced() && !hold) dur = .01
    const el = document.createElementNS(NS, 'g')
    el.setAttribute('class', 'theone-vesicle'); el.innerHTML = '<circle data-part="membrane" r="3.4"/><circle data-part="nucleus" r="1.3"/>'
    vlayer.appendChild(el)
    const v: Vesicle = { el, from, to, arrive, t: reduced() ? 1 : 0, dur, hold, toMark: false }
    ves.push(v)
    return v
  }
  /** A message reaches a topic: a vesicle carries it there; a folded topic first buds back out of the mark. */
  function routeTo(c: Cell, related: Cell[]) {
    pulse = Math.max(pulse, .55)
    if (c.hidden || c.scale < .3) { c.rebud = true; c.onBorn = () => light(c, related); return }
    vesicle(markPos, () => pos(c), () => light(c, related))
  }
  function fuse(c: Cell, into: Cell) {
    if (c.mode !== 'live' && c.mode !== 'bud') return
    c.mode = 'leave'; c.into = into; c.g.style.pointerEvents = 'none'
    bonds = bonds.filter(b => b[0] !== c && b[1] !== c)
  }
  function fade(c: Cell) {
    if (c.mode === 'leave') return
    c.mode = 'leave'; c.into = undefined; c.g.style.pointerEvents = 'none'
    bonds = bonds.filter(b => b[0] !== c && b[1] !== c)
  }
  /** A topic still on its way out (fusing or fading) is in TheOne's state again: it stays, where it is, instead of a second cell budding. */
  function revive(id: string): Cell | undefined {
    const c = cells.find(o => o.kind === 'topic' && o.id === id && o.mode === 'leave')
    if (!c) return undefined
    c.mode = 'live'; c.into = undefined; c.alpha = 1; c.scale = Math.max(c.scale, reduced() ? 1 : .3); c.g.style.pointerEvents = ''; c.g.style.opacity = '1'
    return c
  }

  function apply(event: FoamEvent): boolean {
    if (event.kind === 'route') {
      const c = byId(event.to); if (!c) return false
      // A blocked message that has now settled: the waiting vesicle goes to where it landed.
      if (clarifying) { apply({ kind: 'resolve', to: event.to }); return true }
      routeTo(c, (event.related ?? []).map(byId).filter((o): o is Cell => !!o && o !== c))
      // The other close candidates light up for a while: routing was not sure, and one click on one of them moves the message there.
      if (event.messageId) for (const o of cells) if (o.offer && o.offer.messageId !== event.messageId) clearOffer(o)
      for (const o of (event.alternates ?? []).map(byId)) if (o && o !== c && !o.hidden) {
        o.flash = Math.max(o.flash, .3); o.g.classList.add('ask')
        // Bright for a few seconds, then a quiet mark that stays until the next message is routed (or a minute passes).
        if (event.messageId) o.offer = { messageId: event.messageId, until: now() + 60000 }
        else window.setTimeout(() => { if (!o.ask && !o.offer) o.g.classList.remove('ask') }, 1400)
      }
    } else if (event.kind === 'supplement') {
      const c = byId(event.to); if (!c) return false
      clearOffers()
      if (!c.hidden) { const v = vesicle(markPos, () => pos(c), () => { c.kick = Math.max(c.kick, .5) }, .55); v.el.setAttribute('data-small', 'true') }
    } else if (event.kind === 'create') {
      const c = byId(event.to); if (!c) return false
      clearOffers()
      pulse = Math.max(pulse, .55)
      if (c.mode === 'bud') c.onBorn = () => light(c)
      else light(c)
    } else if (event.kind === 'clarify') {
      const list = event.candidates.map(byId).filter((c): c is Cell => !!c && !c.hidden).slice(0, 3)
      if (list.length < 2) return true
      endClarify()
      pulse = Math.max(pulse, .55)
      const mid = () => ({ x: list.reduce((s, c) => s + c.cx, 0) / list.length, y: list.reduce((s, c) => s + c.cy, 0) / list.length - 4 })
      clarifying = { cells: list }
      for (const c of list) { c.ask = true; c.g.classList.add('ask') }
      clarifying.ves = vesicle(markPos, mid, () => {}, .7, () => !clarifying || clarifying.cells !== list)
    } else if (event.kind === 'resolve') {
      const held = clarifying?.ves, from = held ? { x: held.el.transform.baseVal.consolidate()?.matrix.e ?? L.x, y: held.el.transform.baseVal.consolidate()?.matrix.f ?? L.y } : markPos()
      endClarify()
      const c = event.to ? byId(event.to) : undefined
      if (c) vesicle(() => from, () => pos(c), () => light(c), .45)
    } else if (event.kind === 'correct') {
      const a = byId(event.from), b = byId(event.to); if (!b) return false
      // A message was moved (here or in another window): what was offered for it no longer applies.
      if (event.messageId) { for (const o of cells) if (o.offer?.messageId === event.messageId) clearOffer(o) } else clearOffers()
      if (a && !a.hidden) { a.flash = 0; a.kick = .6; vesicle(() => pos(a), () => pos(b), () => light(b), .6) }
      else routeTo(b, [])
    } else if (event.kind === 'merged') {
      const a = byId(event.id), b = byId(event.into)
      if (b && event.undo) offerUndo(event.id, b)
      if (a && a.mode === 'leave') return true
      if (a && b) fuse(a, b); else if (a) fade(a)
    } else if (event.kind === 'unmerged') {
      // Taken apart (here, from the undo, or in another window): a source still on its way out comes back.
      gone.delete(event.id)
      const a = byId(event.id) ?? revive(event.id), b = byId(event.into)
      if (!a) return !model.topics.some(t => t.id === event.id)
      light(a, b ? [b] : [])
    } else if (event.kind === 'mergeEnded') {
      const a = byId(event.id), b = byId(event.into)
      bonds = bonds.filter(x => x[0] !== a)
      if (event.failed && b) tipAt(b, text(foamMergeReason(event.error)))
    }
    return true
  }
  function clearOffers() { for (const o of cells) if (o.offer) clearOffer(o) }
  function clearOffer(o: Cell) { o.offer = undefined; o.reroute = undefined; o.g.classList.remove('offer', 'pending'); if (!o.ask) o.g.classList.remove('ask') }
  function endClarify() {
    if (!clarifying) return
    for (const c of clarifying.cells) { c.ask = false; c.g.classList.remove('ask') }
    clarifying = null
  }

  function update(next: FoamModel) {
    model = next
    const seen = new Set<string>(), T = now()
    for (const [id, until] of gone) if (T > until || !model.topics.some(t => t.id === id)) gone.delete(id)
    for (const topic of model.topics) {
      seen.add(topic.id)
      let c = byId(topic.id)
      // Merged here a moment ago and this state predates it: the source keeps fusing.
      if (!c && gone.has(topic.id)) continue
      if (!c) c = revive(topic.id) ?? makeCell(topic.id, topic.title, !first && !reduced())
      const was = c.state
      c.title = topic.title; c.short = topic.label; c.w = clamp(topic.weight); c.group = topic.group; c.aside = !!topic.aside; c.oneOff = !!topic.oneOff; c.startedAt = topic.startedAt
      c.ask = c.ask || !!topic.asking; c.g.classList.toggle('ask', c.ask)
      if (c.cur !== !!topic.current) { c.cur = !!topic.current; c.g.classList.toggle('cur', c.cur) }
      const state: CellState = topic.phase === 'answered' ? 'done' : topic.phase === 'waiting' ? 'wait' : topic.phase === 'failed' ? 'fail' : topic.phase
      // The answer went to main chat: it travels back to the mark.
      if (was === 'done' && state !== 'done' && !c.hidden) {
        c.showing = true
        vesicle(() => pos(c!), markPos, () => { pulse = 1; c!.showing = false }, .6).toMark = true
      }
      if (was !== 'running' && state === 'running') c.kick = Math.max(c.kick, .8)
      if (was === 'running' && state === 'done') c.kick = 1
      setState(c, state)
    }
    for (const c of topics()) if (!seen.has(c.id)) fade(c)
    links = new Map()
    for (const link of model.links ?? []) { links.set(link.a + '|' + link.b, link.weight); links.set(link.b + '|' + link.a, link.weight) }
    bonds = (model.pendingMerges ?? []).map(m => [byId(m.id), byId(m.into)] as [Cell | undefined, Cell | undefined]).filter((b): b is [Cell, Cell] => !!b[0] && !!b[1])
    syncDups()
    first = false
    syncList()
    syncEntry()
    if (pop?.kind === 'detail') renderDetail(); else if (pop) renderAll()
    for (let i = 0; i < pending.length;) { if (apply(pending[i])) pending.splice(i, 1); else i++ }
    if (pending.length > 20) pending.splice(0, pending.length - 20)
  }
  const topicOf = (id: string) => model.topics.find(t => t.id === id)
  function describe(c: Cell): string {
    const t = topicOf(c.id), status = t ? foamStatusText(t, text) : ''
    return status ? c.title + ' · ' + status : c.title
  }
  function syncList() {
    const shown = topics().filter(c => !c.aside || busy(c))
    let lost = false
    for (const [id, el] of keys) if (!shown.some(c => c.id === id)) { lost ||= el === document.activeElement; el.parentElement?.remove(); keys.delete(id) }
    // Focus was on a topic that just went away (set aside, merged, removed): it lands on the all-topics entry, not on the page.
    if (lost && !entry.hidden) entry.focus()
    for (const c of shown) {
      let el = keys.get(c.id)
      if (!el) {
        // A native button inside a list item; activating it opens the same details a click on the cell does.
        const item = document.createElement('div'), b = el = document.createElement('button')
        item.setAttribute('role', 'listitem'); item.appendChild(b)
        b.type = 'button'; b.setAttribute('aria-haspopup', 'dialog')
        b.addEventListener('focus', () => c.g.classList.add('fuse'))
        b.addEventListener('blur', () => c.g.classList.remove('fuse'))
        b.addEventListener('click', () => { const live = byId(c.id); if (live) openDetail(live, b) })
        b.addEventListener('keydown', e => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = c.m.getBoundingClientRect(); openMenu(r.left + r.width / 2, r.bottom, c, true) }
        })
        keys.set(c.id, b); list.appendChild(item)
      }
      el.textContent = describe(c)
      el.setAttribute('aria-current', c.cur ? 'true' : 'false')
    }
  }
  function entryLabel(): string {
    const waiting = model.topics.filter(t => t.phase === 'waiting').length
    return waiting ? text('allTopics') + ' · ' + text('allWaiting', { n: waiting }) : text('allTopics')
  }
  function syncEntry() {
    const waiting = model.topics.filter(t => t.phase === 'waiting').length
    entry.hidden = !model.topics.length
    entry.classList.toggle('need', waiting > 0)
    entryCount.textContent = waiting ? String(waiting) : ''
    entry.setAttribute('aria-label', entryLabel())
  }
  function event(e: FoamEvent) {
    if (!apply(e)) pending.push(e)
    // A newer message may have replaced the one the open details were for: its move-here item goes away at once.
    if (pop?.kind === 'detail') renderDetail()
  }

  function text(key: FoamTextKey, vars?: Record<string, string | number>) { return actions.text(key, vars) }
  function tipText(c: Cell): string {
    if (c.kind === 'more') return text('more', { n: folded })
    const who = c.full ? '' : c.title + ' · '
    const b = bonds.find(x => x[0] === c || x[1] === c)
    if (b) return who + text('bond', { name: (b[0] === c ? b[1] : b[0]).title })
    if (c.offer) return who + text('offer')
    if (c.ask) return who + text('asking')
    if (c.state === 'wait') return who + text('waiting')
    if (c.state === 'fail') return who + text('failed')
    if (c.state === 'queued') return who + text('queued')
    if (c.state === 'done') return who + text('answered')
    if (c.state === 'running') return who + text('running', { s: Math.max(0, Math.round((Date.now() - (c.startedAt ?? Date.now())) / 1000)) })
    const dup = dupsOf(c)[0]
    if (dup) return who + text('dupTip', { name: (dup.a === c ? dup.b : dup.a).title })
    return c.full ? '' : c.title
  }
  /** A hint above what it is about (below when there is no room), whole inside the viewport, long names wrapped. */
  function placeTip(anchor: FoamBox, s: string) {
    if (!s) { tip.classList.remove('on'); return }
    tip.textContent = s; foamClampToViewport(tip, anchor, { side: 'above', align: 'center', gap: 6 }); tip.classList.add('on')
  }
  /** The pointer as an anchor: a hint clears the cursor whether it sits above or below it. */
  const pointerBox = (x: number, y: number): FoamBox => ({ left: x, right: x, top: y - 2, bottom: y + 18 })
  function showTip(c: Cell) {
    tipOwner = c
    placeTip(c.m.getBoundingClientRect(), tipText(c))
  }
  function hideTip() { tipOwner = null; tip.classList.remove('on') }
  const tipTimer = window.setInterval(() => { if (tipOwner) showTip(tipOwner) }, 500)

  /** The open menu's topic, what it was opened from (for focus to go back to), and its key handler. */
  let menuOf: { cell: Cell; back: HTMLElement | null; prev: Element | null; unkeys: () => void } | null = null
  /** `restore`: focus goes back to where the menu came from; 'gone': its topic went away, so not to that topic's row. */
  function closeMenu(restore: boolean | 'gone' = false) {
    const was = menuOf, had = menu
    menu?.remove(); menu = null; menuOf = null
    if (!had || !was) return
    was.unkeys()
    if (!restore) return
    const usable = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el !== document.body && !had.contains(el) && !el.closest('[hidden]')
    const alive = was.cell.kind === 'topic' && !!byId(was.cell.id)
    const row = alive && restore === true ? keys.get(was.cell.id) : undefined
    // Where it came from, if that is still there; else the topic's own row in the keyboard list; else the all-topics entry.
    // Its topic went away: never that topic's row, never a neighbour.
    const to = [restore === true ? was.back : null, restore === 'gone' && was.prev === keys.get(was.cell.id) ? null : was.prev, row, entry].find(usable)
    if (to) to.focus()
    else if (had.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  }
  /** A cell's actions, for its right-click menu and its details alike; null is a separator. The key names the item. */
  type MenuItem = [label: string, run: () => void, key: FoamTextKey] | null
  /** `mid`: the message the menu or details were opened for; the move-here item exists only while that same message is still offered. */
  function menuItems(c: Cell, mid = c.offer?.messageId): MenuItem[] {
    const id = c.id
    const items: MenuItem[] = c.kind === 'more' ? [[text('menuWorkspace'), actions.openWorkspace, 'menuWorkspace']]
      : c.state === 'running' ? [[text('menuOpen'), () => actions.open(id), 'menuOpen'], null, [text('menuStop'), () => actions.stop(id), 'menuStop']]
      : c.state === 'queued' ? [[text('menuOpen'), () => actions.open(id), 'menuOpen'], [text('menuCancel'), () => actions.cancelQueued(id), 'menuCancel']]
      : c.state === 'done' ? [[text('menuShowNow'), () => actions.showAnswer(id), 'menuShowNow'], [text('menuOpen'), () => actions.open(id), 'menuOpen']]
      : c.state === 'wait' ? [[text('menuAnswer'), () => actions.answer(id), 'menuAnswer'], [text('menuOpen'), () => actions.open(id), 'menuOpen']]
      : [[text('menuContinue'), () => actions.mount(id), 'menuContinue'], [text('menuOpen'), () => actions.open(id), 'menuOpen'],
        ...(c.cur ? [] : [[text('menuAside'), () => void actions.putAside(id).then(ok => { if (!ok) tipAt(c, text('actionFailed')) }), 'menuAside'] as MenuItem]),
        null, [text('menuDelete'), () => actions.remove(id), 'menuDelete']]
    if (c.kind === 'topic') {
      // A candidate routing hesitated over: the same move a click on the cell makes, reachable without the pointer.
      // Bound to the message offered when the menu or details opened: once a newer message replaced it, the item is gone, never retargeted.
      if (mid && c.offer?.messageId === mid) items.unshift([text('menuReroute'), () => rerouteTo(c, mid), 'menuReroute'], null)
      const extra: MenuItem[] = []
      for (const d of dupsOf(c)) extra.push([text('dupMenu', { name: (d.a === c ? d.b : d.a).title }), () => openDup(d.s.id, c), 'dupMenu'])
      const queued = (model.pendingMerges ?? []).find(m => m.id === id && m.state === 'queued' && m.operationId)
      if (queued) extra.push([text('menuCancelMerge'), () => void actions.cancelMerge(queued.operationId!).then(ok => { if (!ok) tipAt(c, text('actionFailed')) }), 'menuCancelMerge'])
      // The same merge as dragging one cell onto another, reachable without a drag (and from the keyboard).
      if (!rail && model.topics.length > 1 && !merging().has(c.id)) extra.push([text('menuMergeInto'), () => openAll(activeOrNull(), c.m.getBoundingClientRect(), c.id), 'menuMergeInto'])
      for (const m of (model.merges ?? []).filter(m => m.targetId === id).slice(0, 3)) extra.push([text('menuUnmerge', { name: m.title }), () => undoMerge(m.sourceId, c), 'menuUnmerge'])
      if (extra.length) items.push(null, ...extra)
    }
    return items
  }
  function openMenu(x: number, y: number, c: Cell, fromKeyboard = false) {
    const prev = document.activeElement
    closeMenu(); closePop()
    const items = menuItems(c)
    const el = menu = document.createElement('div')
    el.className = 'theone-foam-menu'; el.setAttribute('role', 'menu')
    for (const item of items) {
      if (!item) { el.appendChild(document.createElement('hr')); continue }
      const row = document.createElement('button')
      row.type = 'button'; row.setAttribute('role', 'menuitem'); row.textContent = item[0]
      row.onclick = () => { closeMenu(true); item[1]() }
      el.appendChild(row)
    }
    document.body.appendChild(el)
    // From the keyboard the menu hangs off the cell itself; from the pointer it opens where the click was. Either way it stays whole on screen.
    const anchor: FoamBox = fromKeyboard ? c.m.getBoundingClientRect() : { left: x, right: x, top: y, bottom: y }
    foamClampToViewport(el, anchor, fromKeyboard ? { side: 'below', align: 'center', gap: 6 } : { side: 'below', align: 'start', gap: 2 })
    // Keyboard-opened, focus returns to the topic's row in the list; pointer-opened, to whatever had it before.
    menuOf = { cell: c, back: fromKeyboard ? keys.get(c.id) ?? null : null, prev, unkeys: foamMenuKeys(el, () => closeMenu(true)) }
    el.querySelector('button')?.focus()
  }
  const outside = (e: PointerEvent) => {
    const at = e.target as Node
    if (menu && !menu.contains(at)) closeMenu()
    if (pop && !pop.el.contains(at) && !(pop.kind === 'all' && entry.contains(at))) closePop()
  }
  const keydown = (e: KeyboardEvent) => {
    // Escape while an input method is composing only cancels the composition.
    if (e.key !== 'Escape' || e.isComposing) return
    if (pop?.el.contains(e.target as Node)) {
      e.preventDefault(); e.stopPropagation()
      // Escape in a filled filter clears it first; the next one closes the list.
      const input = e.target instanceof HTMLInputElement ? e.target : null
      if (input?.value) { input.value = ''; pop.query = ''; renderAll() } else closePop(true)
    } else if (pop) { e.preventDefault(); e.stopPropagation(); closePop() }
    if (menu) { e.preventDefault(); e.stopPropagation(); closeMenu(true) }
    if (drag) { e.preventDefault(); cancelDrag() }
  }

  // ---- Details and the all-topics list: light popovers in the menu's style. Looking never mounts, sets aside, merges or corrects anything.
  const activeOrNull = () => { const a = document.activeElement; return a instanceof HTMLElement && a !== document.body ? a : null }
  function closePop(restore = false, toEntry = false) {
    if (!pop) return
    const { el, back } = pop
    const had = el.contains(document.activeElement)
    pop = null; el.remove()
    // Focus goes back to what opened it; when that is gone (or was nothing), to the all-topics entry.
    if (restore || had) (!toEntry && back?.isConnected && !back.closest('[hidden]') ? back : entry.hidden ? null : entry)?.focus()
  }
  entry.addEventListener('click', () => { if (pop?.kind === 'all') closePop(true); else openAll(entry) })
  entry.addEventListener('pointerenter', () => { if (drag) return; placeTip(entry.getBoundingClientRect(), entryLabel()) })
  entry.addEventListener('pointerleave', () => hideTip())
  /** Next to what opened it, held there (it does not follow the cell or the pointer), inside the window, and not over the card above the cluster. */
  function placePop(el: HTMLElement, a: { left: number; right: number; top: number; bottom: number }, tall = innerHeight - 16) {
    el.style.maxHeight = Math.max(120, Math.min(tall, innerHeight - 16)) + 'px'
    const b = el.getBoundingClientRect()
    let left = a.right + 8
    if (left + b.width > innerWidth - 8) left = a.left - 8 - b.width
    const top = Math.max(a.top - 6, host.getBoundingClientRect().top)
    el.style.left = Math.max(8, Math.min(left, innerWidth - b.width - 8)) + 'px'
    el.style.top = Math.max(8, Math.min(top, innerHeight - b.height - 8)) + 'px'
  }
  /** Arrow keys walk the popover's controls (wrapping), Home and End jump; Tab out of it closes it. */
  function popNav(e: KeyboardEvent) {
    // Arrow keys while an input method is composing belong to its candidate list.
    if (!pop || e.isComposing || e.keyCode === 229) return
    const all = [...pop.el.querySelectorAll<HTMLElement>('input, button:not([disabled])')].filter(x => !x.closest('[hidden]'))
    const i = all.indexOf(document.activeElement as HTMLElement), inInput = document.activeElement instanceof HTMLInputElement
    const next = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i <= 0 ? all.length - 1 : i - 1)
      : e.key === 'Home' && !inInput ? 0 : e.key === 'End' && !inInput ? all.length - 1 : -1
    if (next < 0 || !all.length) return
    e.preventDefault(); all[next].focus()
  }
  function makePop(kind: 'detail' | 'all', id: string, back: HTMLElement | null) {
    const el = document.createElement('div')
    el.className = 'theone-foam-menu theone-foam-pop ' + (kind === 'detail' ? 'theone-foam-detail' : 'theone-foam-all-list')
    el.setAttribute('role', 'dialog')
    el.addEventListener('keydown', popNav)
    el.addEventListener('focusout', e => { const to = e.relatedTarget as Node | null; if (to && pop?.el === el && !el.contains(to) && to !== entry) closePop() })
    pop = { el, kind, id, back, sig: '', order: [], query: '' }
    return el
  }
  const span = (cls: string, s: string) => { const el = document.createElement('span'); el.className = cls; el.textContent = s; return el }
  function popButton(label: string, run: () => void, cls = '') {
    const b = document.createElement('button')
    b.type = 'button'; b.textContent = label; if (cls) b.className = cls
    b.onclick = () => { closePop(); run() }
    return b
  }

  /** A topic's details: its whole name, what it is doing, one main action, and the same actions as its menu. */
  function openDetail(c: Cell, back: HTMLElement | null) {
    closeMenu(); hideTip()
    // Opened from the all-topics list: closing goes back to the list's own trigger.
    const keep = pop?.kind === 'all' ? pop.back ?? entry : back
    closePop()
    const el = makePop('detail', c.id, keep)
    pop!.mid = c.offer?.messageId
    renderDetail()
    if (pop?.el !== el) return
    document.body.appendChild(el)
    // Beside the cell when it is on screen; a folded, set-aside or rail-hidden one opens beside the all-topics entry.
    const onScreen = c.mode === 'live' && !c.hidden && c.scale > .3
    placePop(el, (onScreen ? c.m : entry.hidden ? host : entry).getBoundingClientRect())
    el.querySelector('button')?.focus()
  }
  function renderDetail() {
    if (!pop || pop.kind !== 'detail') return
    const c = byId(pop.id), t = topicOf(pop.id)
    // The topic went away (merged, deleted) while open: close, and focus lands on the all-topics entry, never on a neighbour.
    if (!c || !t) { closePop(false, true); return }
    const status = foamStatusText(t, text)
    const items = menuItems(c, pop.mid).filter(item => item?.[2] !== 'menuContinue')
    while (items[0] === null) items.shift()
    const primary = !t.current
    const sig = [c.title, status, primary, pop.mid && c.offer?.messageId === pop.mid ? pop.mid : '', ...items.map(item => item ? item[0] : '-')].join('\n')
    if (sig === pop.sig) return
    const el = pop.el, focused = el.contains(document.activeElement) ? document.activeElement?.textContent : null
    pop.sig = sig; el.textContent = ''
    el.setAttribute('aria-label', c.title)
    const head = document.createElement('div')
    head.className = 'theone-foam-head'
    head.appendChild(span('theone-foam-name', c.title))
    if (status) head.appendChild(span('theone-foam-status' + (t.phase === 'waiting' ? ' need' : ''), status))
    el.appendChild(head)
    // Carrying on is the one main action; it is the only thing here that moves main chat.
    if (primary) el.appendChild(popButton(text('menuContinue'), () => actions.mount(c.id), 'theone-foam-primary'))
    if (items.length) el.appendChild(document.createElement('hr'))
    for (const item of items) el.appendChild(item ? popButton(item[0], item[1]) : document.createElement('hr'))
    if (focused) [...el.querySelectorAll('button')].find(b => b.textContent === focused)?.focus()
  }

  /** Every topic, set-aside and folded ones too, in a stable order, filtered as one types; a row opens that topic's details. */
  /** `pick`: the list chooses which topic `pick` merges into (the menu's "merge into…"); a row then merges instead of opening details. */
  function openAll(back: HTMLElement | null, at?: DOMRect, pick?: string) {
    closeMenu(); hideTip(); closePop()
    const el = makePop('all', '', back)
    el.setAttribute('aria-label', pick ? text('mergeIntoPick') : text('allTopics'))
    pop!.pick = pick
    pop!.order = foamOrder(model.topics).map(t => t.id).filter(id => id !== pick)
    const input = document.createElement('input')
    input.type = 'search'; input.className = 'theone-foam-filter'; input.placeholder = pick ? text('mergeIntoPick') : text('filter'); input.setAttribute('aria-label', text('filter'))
    input.autocomplete = 'off'; input.spellcheck = false
    input.addEventListener('input', () => { if (pop?.el === el) { pop.query = input.value; renderAll() } })
    // Enter acts on the first row, but never the Enter that confirms an input method's candidate.
    input.addEventListener('keydown', e => { if (foamEnterActs(e)) { e.preventDefault(); el.querySelector<HTMLButtonElement>('.theone-foam-row:not([disabled])')?.click() } })
    const rows = document.createElement('div')
    rows.className = 'theone-foam-rows'; rows.setAttribute('role', 'list')
    const empty = span('theone-foam-empty', text('noMatch'))
    empty.hidden = true
    el.append(input, rows, empty, ...(pick ? [] : [document.createElement('hr'), popButton(text('menuWorkspace'), actions.openWorkspace)]))
    renderAll()
    if (pop?.el !== el) return
    document.body.appendChild(el)
    placePop(el, at ?? (entry.hidden ? host : entry).getBoundingClientRect(), 440)
    input.focus()
  }
  function renderAll() {
    if (!pop || pop.kind !== 'all') return
    const known = new Map(model.topics.map(t => [t.id, t]))
    // Choosing where a topic goes that is gone, or is now in another merge itself: nothing left to choose.
    if (pop.pick && (!byId(pop.pick) || merging().has(pop.pick))) { closePop(false, true); return }
    // The order is fixed while the list is open, so rows never move under the pointer; new topics join at the end.
    for (const t of foamOrder(model.topics)) if (!pop.order.includes(t.id) && t.id !== pop.pick) pop.order.push(t.id)
    pop.order = pop.order.filter(id => known.has(id))
    const shown = foamFilter(pop.order.map(id => known.get(id)!), pop.query)
    // Picking a merge target: a topic already in a merge waiting to happen is shown, but cannot be picked.
    const held = pop.pick ? merging() : new Set<string>()
    const sig = pop.query + '\n' + shown.map(t => [t.id, t.title, t.current, foamStatusText(t, text), held.has(t.id)].join('\t')).join('\n')
    if (sig === pop.sig) return
    pop.sig = sig
    const el = pop.el, rows = el.querySelector('.theone-foam-rows')!, empty = el.querySelector<HTMLElement>('.theone-foam-empty')!
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('.theone-foam-row')?.getAttribute('data-id')
    rows.textContent = ''
    for (const t of shown) {
      const item = document.createElement('div'), b = document.createElement('button'), blocked = held.has(t.id)
      const status = blocked ? text('pickMerging') : foamStatusText(t, text)
      item.setAttribute('role', 'listitem')
      b.type = 'button'; b.className = 'theone-foam-row'; b.setAttribute('data-id', t.id)
      if (!pop.pick) b.setAttribute('aria-haspopup', 'dialog')
      if (blocked) b.disabled = true
      if (t.current) b.setAttribute('aria-current', 'true')
      b.appendChild(span('theone-foam-name', t.title))
      if (status) b.appendChild(span('theone-foam-status' + (t.phase === 'waiting' && !blocked ? ' need' : ''), status))
      const pick = pop.pick
      b.onclick = () => {
        const c = byId(t.id); if (!c) return
        if (!pick) { openDetail(c, null); return }
        const from = byId(pick)
        closePop(true)
        if (!from || from === c) return
        // Checked again now: either end may have joined another merge since the list was drawn.
        const busyNow = merging()
        if (busyNow.has(from.id) || busyNow.has(c.id)) { tipAt(c, text('mergeConflict')); return }
        mergeInto(from, c)
      }
      item.appendChild(b); rows.appendChild(item)
      if (t.id === focused) b.focus()
    }
    empty.hidden = shown.length > 0
  }
  /** Escape, a lost pointer or the window losing focus: the cell goes back, nothing is sent. */
  function cancelDrag() {
    if (!drag) return
    const { cell, pointer } = drag
    cell.g.classList.remove('drag'); drag = null; hideTip(); setTarget(null)
    try { if (cell.g.hasPointerCapture(pointer)) cell.g.releasePointerCapture(pointer) } catch { /* Already released. */ }
  }
  /** Losing the pointer (another pointer's cancel never counts), the window or the page: the drag is called off. */
  const blur = (e?: Event) => { if (e instanceof PointerEvent && drag && e.pointerId !== drag.pointer) return; cancelDrag() }
  const hiddenPage = () => { if (document.visibilityState !== 'visible') cancelDrag() }
  /** The sidebar or page scrolled under a drag: where it would land is no longer what the user aimed at. */
  const scrolled = () => { if (drag?.started) cancelDrag() }
  function undoMerge(sourceId: string, near: Cell) {
    hideUndo()
    void actions.unmerge(sourceId).then(ok => { if (ok) gone.delete(sourceId); else if (cells.includes(near)) tipAt(near, text('actionFailed')) })
  }
  /** Right after a merge: a small "undo" under the merged cell for a few seconds; the cell's menu keeps the undo after it fades. */
  function offerUndo(sourceId: string, near: Cell) {
    clearTimeout(undoTimer)
    undo.textContent = text('undo')
    const r = near.m.getBoundingClientRect()
    undo.style.left = (r.left + r.width / 2) + 'px'; undo.style.top = (r.bottom + 6) + 'px'
    undo.onclick = () => undoMerge(sourceId, near)
    undo.classList.add('on')
    undoTimer = window.setTimeout(hideUndo, 6000)
  }
  function hideUndo() { clearTimeout(undoTimer); undo.classList.remove('on'); undo.onclick = null }
  function tipAt(c: Cell, s: string) {
    placeTip(c.m.getBoundingClientRect(), s); window.setTimeout(hideTip, 1800)
  }

  /*
   * Possible duplicates. TheOne keeps them for the user instead of asking in main chat; the cluster shows each as a
   * quiet dotted thread between the two cells with a small pore to click. It never pulls them together. Only
   * "not the same" declines; Esc, clicking elsewhere, moving away or setting a cell aside leave it pending.
   */
  /**
   * `px`/`py`: where the pore sits this frame (null when not drawn); `room`: its hit area fits between the cells, else the pore is
   * not shown. `spot`: which candidate place it took (kept while it fits, see foamPoreSpot); `hover`: the pointer is on it, which
   * holds the spot still; `path`/`stalk`: the thread, and the stalk out to a notch, drawn only once the pore is known to show.
   */
  interface Dup { s: FoamSuggestion; a: Cell; b: Cell; thread: SVGPathElement; pore: SVGGElement; hit: SVGCircleElement; alpha: number; px: number | null; py: number; room: boolean
    spot: number; hover: boolean; path: string; stalk: string }
  const dups = new Map<string, Dup>()
  /** Answered here and waiting for TheOne's next state: the thread is not drawn meanwhile. */
  const answering = new Set<string>()
  let dupPanel: { el: HTMLDivElement; id: string; back: Element | null; from?: Cell } | null = null, keyboard = false
  const dupsOf = (c: Cell) => [...dups.values()].filter(d => (d.a === c || d.b === c) && !answering.has(d.s.id))
  const shownCell = (d: Dup) => [d.a, d.b].find(c => !c.hidden && c.mode === 'live') ?? d.a
  function syncDups() {
    const seen = new Set<string>()
    for (const s of model.suggestions ?? []) {
      const a = byId(s.a), b = byId(s.b)
      if (!a || !b || a === b) continue
      seen.add(s.id)
      let d = dups.get(s.id)
      if (!d) {
        const thread = document.createElementNS(NS, 'path'); thread.setAttribute('class', 'theone-dup-thread'); threads.appendChild(thread)
        const pore = document.createElementNS(NS, 'g'); pore.setAttribute('class', 'theone-dup')
        pore.innerHTML = '<circle data-part="hit" r="8"/><circle data-part="ring" r="3.2"/>'
        pores.appendChild(pore)
        const id = s.id
        pore.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation() })
        pore.addEventListener('click', () => { if (dupPanel?.id === id) closeDup(); else openDup(id) })
        pore.addEventListener('pointerenter', () => { const it = dups.get(id); if (it) it.hover = true; if (drag) return; placeTip(pore.getBoundingClientRect(), text('dupTitle')) })
        pore.addEventListener('pointerleave', () => { const it = dups.get(id); if (it) it.hover = false; if (!tipOwner) tip.classList.remove('on') })
        d = { s, a, b, thread, pore, hit: pore.firstChild as SVGCircleElement, alpha: 0, px: null, py: 0, room: false, spot: -1, hover: false, path: '', stalk: '' }
        dups.set(id, d)
      }
      d.s = s; d.a = a; d.b = b
    }
    for (const [id, d] of dups) if (!seen.has(id)) { d.thread.remove(); d.pore.remove(); dups.delete(id) }
    for (const id of answering) if (!seen.has(id)) answering.delete(id)
    if (dupPanel && !dups.has(dupPanel.id)) closeDup()
  }
  /** The pending suggestion between two cells, and its direction with `c` going into `into`. */
  function dupBetween(c: Cell, into: Cell): { id: string; direction: { sourceId: string; targetId: string } } | undefined {
    for (const d of dupsOf(c)) {
      if (d.a !== into && d.b !== into) continue
      const direction = d.s.directions.find(x => x.sourceId === c.id && x.targetId === into.id)
      if (direction) return { id: d.s.id, direction }
    }
    return undefined
  }
  function drawDups(dt: number, box: { w: number; h: number; top: number }) {
    // Every outline a pore must keep clear of, gathered once per frame for all pairs.
    let outlines: { c: Cell; x: number; y: number; reach: number }[] | null = null
    for (const d of dups.values()) {
      const { a, b } = d
      const show = !answering.has(d.s.id) && sz > .7 && [a, b].every(c => cells.includes(c) && c.mode === 'live' && !c.hidden && c.scale > .5)
        && !(drag?.started && (drag.cell === a || drag.cell === b))
      d.alpha = reduced() ? (show ? 1 : 0) : ease(d.alpha, show ? 1 : 0, show ? 1.4 : 6, dt)
      d.px = null
      if (d.alpha < .02) { d.thread.setAttribute('d', ''); d.pore.style.display = 'none'; d.spot = -1; continue }
      outlines ??= cells.filter(c => c.mode === 'live' && !c.hidden && c.scale > .02).map(c => ({ c, x: c.cx, y: c.cy, reach: Math.max(c.vr, c.R * c.scale) }))
      const ra = a.R * a.scale, rb = b.R * b.scale, dx = b.cx - a.cx, dy = b.cy - a.cy, dist = Math.hypot(dx, dy) || .01, ux = dx / dist, uy = dy / dist
      const gap = dist - ra - rb
      const open = dupPanel?.id === d.s.id
      // The pore's hit area is shared out with the cells' afterwards (see step); it is shown only where that leaves it room.
      // Candidate places, scored by that same rule; the place it had is kept while it fits, and held while pointed at or open.
      let path = '', spots: { x: number; y: number }[], from: { x: number; y: number } | null = null
      // Touching or apart, with 4 px of hysteresis so a pair hovering at the threshold does not swap between the two kinds of
      // place, and none at all while the pore is pointed at or its panel open (the pore must not move under the pointer).
      const was = d.spot >= 0 ? Math.floor(d.spot / 10) : 0, edge = Math.min(ra, rb) * 1.4
      const close = was && (open || d.hover) ? was === 1 : gap < edge + (was === 1 ? 4 : was === 2 ? -4 : 0)
      if (close) {
        // Close together: a dotted neck outline in the crevice between them, the pore in one of the notches where their
        // outlines part (on their contact point no hit circle could ever fit, so the pore would never show in a packed cluster).
        path = bridge(pos(a), ra, pos(b), rb, 1e6, .42)?.edge ?? ''
        const n = foamNotches({ x: a.cx, y: a.cy, reach: Math.max(a.vr, ra) }, { x: b.cx, y: b.cy, reach: Math.max(b.vr, rb) })
        spots = n.sides; from = n.contact
      } else {
        // Further apart: a gently bowed dotted thread from wall to wall, the pore on it: halfway if that is clear, else
        // further along, so a third cell lying over the middle of the thread does not hide it.
        const sx = a.cx + ux * (ra + 2), sy = a.cy + uy * (ra + 2), ex = b.cx - ux * (rb + 2), ey = b.cy - uy * (rb + 2)
        const mx = (sx + ex) / 2 - uy * gap * .12, my = (sy + ey) / 2 + ux * gap * .12
        path = `M${fx(sx)} ${fx(sy)}Q${fx(mx)} ${fx(my)} ${fx(ex)} ${fx(ey)}`
        spots = [.5, .38, .62, .26, .74].map(k => ({ x: (1 - k) ** 2 * sx + 2 * k * (1 - k) * mx + k * k * ex, y: (1 - k) ** 2 * sy + 2 * k * (1 - k) * my + k * k * ey }))
      }
      // A different kind of place (the pair moved apart or together) starts the choice afresh.
      const kind = close ? 1 : 2
      const pick = foamPoreSpot(spots, was === kind ? d.spot % 10 : -1, outlines, box, open || d.hover, d.room)
      d.spot = kind * 10 + pick
      const px = spots[pick].x, py = spots[pick].y
      // A short dotted stalk from the contact point out to a notch, so the pore reads as belonging to the pair; it is added
      // (placePores) only once the pore is known to show, so a hidden pore leaves no stray line.
      d.path = path; d.stalk = from ? `M${fx(from.x)} ${fx(from.y)}L${fx(px)} ${fx(py)}` : ''
      // A slow breath, not a blink; it stands still with reduced motion (t does not advance then).
      const o = d.alpha * (open ? 1 : .8 + .2 * Math.sin(t * 1.2 + a.phase))
      d.thread.setAttribute('d', path + (d.room ? d.stalk : '')); d.thread.style.opacity = fx(o * .85); d.thread.classList.toggle('open', open)
      d.pore.setAttribute('transform', `translate(${fx(px)} ${fx(py)}) scale(${fx(Math.max(.7, sz))})`); d.pore.style.opacity = fx(o); d.pore.classList.toggle('open', open)
      d.px = px; d.py = py
      d.hit.style.pointerEvents = drag || !show ? 'none' : ''
    }
  }
  /**
   * The pores' hit circles, shared out with the cells' (`foamPoreHits`). With too little room a pore is not drawn at all, so
   * nothing looks clickable that is not; the cells' menus and details still lead to the suggestion.
   */
  function placePores(list: Dup[], radii: number[]) {
    const scale = Math.max(.7, sz)
    list.forEach((d, i) => {
      d.room = radii[i] > 0
      d.pore.style.display = d.room ? '' : 'none'
      d.thread.setAttribute('d', d.path + (d.room ? d.stalk : ''))
      d.hit.setAttribute('r', fx(radii[i] / scale))
    })
    for (const d of dups.values()) if (d.px === null) d.room = false
  }
  /** The small panel for one possible duplicate, near the pair: both full names, which one to keep, not the same, later. */
  function openDup(id: string, from?: Cell) {
    const d = dups.get(id)
    if (!d) return
    const back = document.activeElement
    closeMenu(); closeDup(false); hideTip()
    const el = document.createElement('div')
    el.className = 'theone-foam-menu theone-foam-dup'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', text('dupTitle'))
    const head = document.createElement('div'); head.className = 'theone-foam-dup-head'
    const title = document.createElement('div'); title.className = 'theone-foam-dup-title'; title.textContent = text('dupTitle'); head.appendChild(title)
    for (const c of [d.a, d.b]) { const name = document.createElement('div'); name.className = 'theone-foam-dup-name'; name.textContent = c.title; head.appendChild(name) }
    el.appendChild(head)
    const row = (label: string, run: () => void) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = run; el.appendChild(button)
    }
    el.appendChild(document.createElement('hr'))
    for (const direction of d.s.directions) {
      const into = direction.targetId === d.a.id ? d.a : d.b
      row(text('dupInto', { name: into.title }), () => acceptDup(id, direction))
    }
    el.appendChild(document.createElement('hr'))
    row(text('dupNo'), () => declineDup(id))
    row(text('dupLater'), () => laterDup(id))
    // Arrow keys move between the choices; Tab stays inside until the panel closes.
    el.addEventListener('keydown', e => {
      const buttons = [...el.querySelectorAll('button')], at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const by = e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) ? 1 : e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 0
      const jump = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1
      if (!by && jump < 0) return
      e.preventDefault()
      buttons[jump >= 0 ? jump : (at + by + buttons.length) % buttons.length]?.focus()
    })
    document.body.appendChild(el)
    dupPanel = { el, id, back, from }
    // Below the pair, centred on it; above it when there is no room below. It stays where it opened.
    const boxes = [d.a, d.b].filter(c => !c.hidden && c.scale > .3).map(c => c.m.getBoundingClientRect())
    const hr = host.getBoundingClientRect(), p = el.getBoundingClientRect()
    const left = boxes.length ? Math.min(...boxes.map(r => r.left)) : hr.left, right = boxes.length ? Math.max(...boxes.map(r => r.right)) : hr.right
    const top = boxes.length ? Math.min(...boxes.map(r => r.top)) : hr.top, bottom = boxes.length ? Math.max(...boxes.map(r => r.bottom)) : hr.top
    let y = bottom + 8
    if (y + p.height > innerHeight - 8) y = Math.max(8, top - p.height - 8)
    el.style.left = clamp((left + right) / 2 - p.width / 2, 8, Math.max(8, innerWidth - p.width - 8)) + 'px'; el.style.top = y + 'px'
    el.querySelector('button')?.focus()
  }
  /** Closes the panel; nothing is sent. Focus goes back where it was, or to the topic in the keyboard list. */
  function closeDup(restore = true) {
    if (!dupPanel) return
    const { el, back, from, id } = dupPanel
    dupPanel = null; el.remove()
    if (!restore) return
    if (back instanceof HTMLElement && back.isConnected && back !== document.body && !back.closest('.theone-foam-menu')) { back.focus(); return }
    const d = dups.get(id), c = from ?? (d && shownCell(d))
    if (keyboard && c) keys.get(c.id)?.focus()
  }
  function acceptDup(id: string, direction: { sourceId: string; targetId: string }) {
    const d = dups.get(id)
    if (!d) return
    closeDup()
    const c = byId(direction.sourceId), into = byId(direction.targetId), near = (into && !into.hidden ? into : undefined) ?? shownCell(d)
    answering.add(id)
    // Same as a merge by hand: a neck until TheOne confirms, then the two fuse and "undo" is offered; queued keeps the neck.
    if (c && into && !c.hidden && !into.hidden) bonds = [...bonds.filter(b => b[0] !== c && b[1] !== c), [c, into]]
    void actions.answerSuggestion(id, 'accept', direction).then(result => {
      if (result === 'merged' && c && into) { gone.set(c.id, now() + 8000); apply({ kind: 'merged', id: c.id, into: into.id }); offerUndo(c.id, into) }
      else if (result === 'failed') { answering.delete(id); if (c) bonds = bonds.filter(b => b[0] !== c); tipAt(near, text('mergeFailed')) }
    })
  }
  function declineDup(id: string) {
    const d = dups.get(id)
    if (!d) return
    closeDup()
    answering.add(id)
    void actions.answerSuggestion(id, 'decline').then(result => { if (result === 'failed') { answering.delete(id); tipAt(shownCell(d), text('actionFailed')) } })
  }
  /** Later: the panel closes and the thread stays; TheOne keeps the suggestion pending. */
  function laterDup(id: string) {
    closeDup()
    void actions.answerSuggestion(id, 'later')
  }
  const dupPointer = (e: PointerEvent) => {
    keyboard = false
    if (dupPanel && !dupPanel.el.contains(e.target as Node) && !dups.get(dupPanel.id)?.pore.contains(e.target as Node)) closeDup(false)
  }
  const dupKey = (e: KeyboardEvent) => {
    keyboard = true
    if (e.key === 'Escape' && dupPanel) { e.preventDefault(); e.stopPropagation(); closeDup() }
  }
  document.addEventListener('pointerdown', dupPointer, true)
  document.addEventListener('keydown', dupKey, true)

  function dropTarget(e: PointerEvent, c: Cell): typeof target {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (c.g.contains(el)) continue
      const mark = options.mark()
      const card = mark?.closest('button')
      if (card?.contains(el)) return { kind: 'main' }
      // The same rule as a press: of the cells under the pointer, the nearest centre. In the collapsed rail the small cells only
      // watch; merging them by dragging one onto another is left to the open sidebar.
      const g = el.closest('.theone-cell'), o = g && (cellAt(e.clientX, e.clientY, c, true) ?? cells.find(x => x.g === g && x.mode === 'live' && x.kind === 'topic'))
      if (o && o !== c) { if (rail) continue; return { kind: 'cell', cell: o } }
      const row = el.closest('[data-row-key^="session:"]')
      if (row) return { kind: 'session', el: row, id: row.getAttribute('data-row-key')!.slice(8) }
    }
    return null
  }
  function setTarget(next: typeof target) {
    const was = target
    if (was?.kind === next?.kind && (was as { cell?: Cell })?.cell === (next as { cell?: Cell })?.cell && (was as { el?: Element })?.el === (next as { el?: Element })?.el) return
    if (was?.kind === 'cell') was.cell.g.classList.remove('fuse')
    if (was?.kind === 'session') was.el.removeAttribute('data-theone-drop')
    if (was?.kind === 'main') options.mark()?.closest('button')?.removeAttribute('data-theone-drop')
    if (next?.kind === 'cell') next.cell.g.classList.add('fuse')
    if (next?.kind === 'session') next.el.setAttribute('data-theone-drop', 'true')
    if (next?.kind === 'main') options.mark()?.closest('button')?.setAttribute('data-theone-drop', 'true')
    target = next
  }
  function dropText(c: Cell, hit: NonNullable<typeof target>): string {
    if (hit.kind === 'main') return c.cur ? '' : text('dropMain', { name: c.title })
    if (hit.kind === 'cell') return text(busy(c) || busy(hit.cell) ? 'dropMergeLater' : 'dropMerge', { name: hit.cell.title })
    return text('dropSession', { name: c.title })
  }
  const REST = 500
  /** Where a release would land right now; another cell counts only once the pointer has rested on it. */
  function aim(e: { clientX: number; clientY: number }, c: Cell) {
    const hit = dropTarget(e as PointerEvent, c)
    if (!drag) return hit
    if (hit?.kind !== 'cell') { drag.rest = undefined; return hit }
    if (drag.rest?.cell !== hit.cell) drag.rest = { cell: hit.cell, since: now() }
    return now() - drag.rest.since >= REST ? hit : null
  }
  /** The tip and highlight for where the drag is aiming: resting on a cell first says what holding will do. */
  function showAim(c: Cell) {
    if (!drag) return
    const hit = aim({ clientX: drag.last.x, clientY: drag.last.y }, c)
    setTarget(hit)
    const resting = !hit && drag.rest ? text('mergeHold', { name: drag.rest.cell.title }) : ''
    placeTip(pointerBox(drag.last.x, drag.last.y), hit ? dropText(c, hit) : resting)
  }
  const move = (e: PointerEvent) => {
    const p = local(e), r = host.getBoundingClientRect()
    ptr = e.clientX > r.left - 24 && e.clientX < r.right + 24 && e.clientY > r.top - 10 && e.clientY < r.bottom + 24 ? p : null
    read(ptr && e)
    if (!drag || e.pointerId !== drag.pointer) return
    const c = drag.cell
    drag.last = { x: e.clientX, y: e.clientY }
    drag.trail.push({ x: e.clientX, y: e.clientY, t: now() }); if (drag.trail.length > 8) drag.trail.shift()
    // A press becomes a drag once the pointer is 5px from where it went down, however slowly it got there.
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.origin.x, e.clientY - drag.origin.y) < 5) return
      drag.started = true; c.g.classList.add('drag')
    }
    c.tx = p.x - drag.dx; c.ty = p.y - drag.dy
    showAim(c)
  }
  /** Topics in a merge waiting to happen, TheOne's or one just asked for here (its neck): neither end takes part in another merge. */
  const merging = () => foamMerging(model.pendingMerges, bonds.map(b => [b[0].id, b[1].id] as const))
  /** Merges one topic into another: a pending suggestion between them is answered instead; the cells are joined until TheOne confirms. */
  function mergeInto(c: Cell, into: Cell) {
    const dup = dupBetween(c, into)
    if (dup) { acceptDup(dup.id, dup.direction); return }
    bonds = [...bonds.filter(b => b[0] !== c && b[1] !== c), [c, into]]
    void actions.merge(c.id, into.id).then(result => {
      if (result === 'merged') { gone.set(c.id, now() + 8000); apply({ kind: 'merged', id: c.id, into: into.id }); offerUndo(c.id, into) }
      else if (result === 'failed') { bonds = bonds.filter(b => b[0] !== c); tipAt(into, text('mergeFailed')) }
    })
  }
  /** Moves the message routing hesitated over into this candidate; a failed try keeps the candidate. */
  /** Moves `messageId` (the message offered when the menu or details opened) into this candidate; a failed try keeps the candidate. */
  function rerouteTo(c: Cell, messageId: string) {
    // A newer message took its place: this never moves the newer one instead.
    if (c.offer?.messageId !== messageId) { tipAt(c, text('rerouteFailed')); return }
    if (c.reroute?.messageId === messageId) return
    const req = ++rerouteSeq
    c.reroute = { messageId, req }
    c.g.classList.add('pending')
    void actions.reroute(messageId, c.id).then(status => {
      // Only the answer to the latest request ends its waiting; a late answer for an older message changes nothing newer.
      const latest = c.reroute?.req === req
      if (latest) { c.reroute = undefined; c.g.classList.remove('pending') }
      if (status >= 200 && status < 300) { for (const o of cells) if (o.offer?.messageId === messageId) clearOffer(o); light(c); return }
      if (!latest || c.offer?.messageId !== messageId) return
      c.offer.until = Math.max(c.offer.until, now() + 30000)
      tipAt(c, text(status === 409 ? 'rerouteBusy' : 'rerouteFailed'))
    })
  }
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return
    const c = drag.cell, trail = drag.trail, started = drag.started, resting = !!drag.rest
    const click = !started && Math.hypot(e.clientX - drag.origin.x, e.clientY - drag.origin.y) < 5
    drag.last = { x: e.clientX, y: e.clientY }
    trail.push({ x: e.clientX, y: e.clientY, t: now() })
    // Checked again where the pointer was let go, not where it last moved.
    const hit = started ? aim(e, c) : null
    const over = started ? dropTarget(e, c) : null
    c.g.classList.remove('drag'); drag = null; hideTip(); setTarget(null)
    if (!started) {
      // A click opens the topic's details. On a candidate routing hesitated over, the details lead with moving the message here:
      // moving it teaches routing, so it is a choice made there, never a side effect of looking.
      if (click) openDetail(c, activeOrNull())
      return
    }
    if (hit?.kind === 'main') { if (!c.cur) actions.mount(c.id); return }
    // Dropped on the topic TheOne thought might be the same one: that answers its suggestion, in this direction (see mergeInto).
    if (hit?.kind === 'cell') { mergeInto(c, hit.cell); return }
    if (hit?.kind === 'session') {
      const icon = hit.el.querySelector('svg, img, i') ?? hit.el
      const box = () => { const a = icon.getBoundingClientRect(), b = host.getBoundingClientRect(); return { x: a.left + a.width / 2 - b.left, y: a.top + a.height / 2 - b.top } }
      // The chat flies in only once TheOne has attached it.
      void actions.attach(c.id, hit.id).then(ok => { if (ok) vesicle(box, () => pos(c), () => light(c)); else tipAt(c, text('actionFailed')) })
      return
    }
    // No throwing small cells in the collapsed rail: they are for watching and clicking, so a quick stray drag sets nothing aside.
    if (rail) return
    // Let go over a cell without resting long enough to merge (even if the pointer only reached it on release): the cell just goes back.
    if (resting || over?.kind === 'cell') return
    // A throw needs speed in the last moment before letting go: a pause before release, or a slow drag past the edge, is not a throw.
    const lastS = trail[trail.length - 1], recent = trail.filter(s => lastS.t - s.t <= 100)
    const firstS = recent[0]
    if (!firstS || recent.length < 2) return
    const dt = Math.max(16, lastS.t - firstS.t) / 1000, vx = (lastS.x - firstS.x) / dt, vy = (lastS.y - firstS.y) / dt
    const sr = options.side()?.getBoundingClientRect()
    const out = !!sr && (e.clientX > sr.right + 6 || e.clientX < sr.left - 6)
    const speed = Math.hypot(vx, vy)
    if (speed <= 1100 && !(out && speed > 500)) return
    if (busy(c) || c.cur) {
      c.vx = -vx * .15; c.vy = -vy * .15; c.kick = 1
      placeTip(pointerBox(e.clientX, e.clientY), text(c.cur ? 'currentFling' : 'busyFling'))
      window.setTimeout(hideTip, 1300)
      return
    }
    const k = Math.min(1, 2600 / speed)
    c.mode = 'fling'; c.age = 0; c.vx = vx * k; c.vy = vy * k; c.g.style.pointerEvents = 'none'; c.flung = true
    bonds = bonds.filter(b => b[0] !== c && b[1] !== c)
    void actions.putAside(c.id).then(ok => {
      const waiting = c.flung
      c.flung = false
      if (ok || !waiting || !cells.includes(c) || c.mode === 'leave' || !model.topics.some(t => t.id === c.id)) return
      // TheOne said no, however late: the topic buds back out of the mark, not set aside.
      c.mode = 'bud'; c.age = 0; c.x = L.x; c.y = L.y; c.vx = 0; c.vy = 0; c.scale = .12; c.alpha = 1; c.hidden = false; c.away = false; c.aside = false; c.g.style.pointerEvents = ''
      pulse = Math.max(pulse, .6)
      c.onBorn = () => tipAt(c, text('actionFailed'))
    })
  }
  window.addEventListener('pointermove', move)
  // Leaving the window sends no move: let the name and the hint go as if the pointer had left the cluster.
  const away = () => { ptr = null; read(null) }
  document.documentElement.addEventListener('pointerleave', away)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', blur)
  window.addEventListener('lostpointercapture', blur)
  window.addEventListener('scroll', scrolled, true)
  document.addEventListener('visibilitychange', hiddenPage)
  window.addEventListener('blur', blur)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keydown, true)
  // Reduced motion switched on: whatever is flying lands now (a held one appears where it waits); the next frame settles the rest.
  const motionChanged = () => { if (motion.matches) for (const v of ves) v.t = Math.max(v.t, 1) }
  motion.addEventListener('change', motionChanged)

  function step(dt: number) {
    const T = now()
    options.place?.()
    if (drag?.started && drag.rest && target?.kind !== 'cell') showAim(drag.cell)
    // Reduced motion: sizes, places and the box's height go straight to where they settle; nothing springs or grows on screen.
    const still = reduced()
    sz = still ? (rail ? MINI : 1) : ease(sz, rail ? MINI : 1, 4, dt)
    const words = clamp((sz - .72) / .28)

    // Which topics show: past the limit the least used fold into "+N", set-aside topics always fold, the collapsed rail shows only active ones.
    const all = topics().filter(c => c.mode !== 'fling')
    const prio = (c: Cell) => (c.cur || c.state !== 'idle' || c.ask || c.mode === 'bud' ? 10 : 0) + c.w
    const order = all.filter(c => !c.aside || busy(c) || c.rebud).sort((a, b) => prio(b) - prio(a))
    const keep = new Set(order.length > MAX_VISIBLE ? order.slice(0, MAX_VISIBLE - 1) : order)
    folded = all.filter(c => !keep.has(c)).length
    for (const c of all) {
      const isFolded = !keep.has(c), hide = c.mode === 'live' && (isFolded || (rail && !c.cur && c.state === 'idle'))
      if (c.hidden && !hide && c.mode === 'live' && c.away && c.rebud) { c.mode = 'bud'; c.age = 0; c.x = L.x; c.y = L.y; c.scale = .12; pulse = Math.max(pulse, .7) }
      if (c.mode === 'live') { c.hidden = hide; c.away = hide && isFolded }
      if (!hide) c.rebud = false
    }
    more.hidden = !folded || rail
    const moreName = '+' + folded
    if (more.title !== moreName) { more.title = moreName; more.kick = .8 }

    for (const b of [...bonds]) if (b.some(c => c.mode !== 'live')) bonds.splice(bonds.indexOf(b), 1)
    for (const c of all) if (c.offer) {
      if (T > c.offer.until) clearOffer(c)
      else if (T > c.offer.until - 56000 && !c.g.classList.contains('offer')) { c.g.classList.add('offer'); if (!c.ask) c.g.classList.remove('ask') }
    }

    const live = cells.filter(c => c.mode === 'live' && !c.hidden)
    let top = Infinity, bottom = -Infinity, x0 = Infinity, x1 = -Infinity
    for (const c of live) if (drag?.cell !== c) { top = Math.min(top, c.y - c.R); bottom = Math.max(bottom, c.y + c.R); x0 = Math.min(x0, c.x - c.R); x1 = Math.max(x1, c.x + c.R) }
    // A strip under the cells holds the all-topics entry, so no cell ever drifts under it.
    const strip = entry.hidden ? 0 : STRIP
    const want = (bottom > top ? Math.min(320, bottom - top + 14 * sz + 4) : 4) + strip
    // The box follows the cluster on a soft spring with a little give; small wobbles of the cells do not move the sidebar.
    if (heightTarget < 0) { height = heightTarget = want; host.style.height = fx(height) + 'px'; options.onHeight(height) }
    if (want > heightTarget + 2 || want < heightTarget - 6) heightTarget = want
    const hk = 70, hc = 2 * .72 * Math.sqrt(hk)
    heightV += (hk * (heightTarget - height) - hc * heightV) * dt
    if (reduced() || (Math.abs(heightTarget - height) < .05 && Math.abs(heightV) < .05)) heightV = 0
    const nextHeight = reduced() ? heightTarget : heightV ? height + heightV * dt : heightTarget
    if (Math.abs(nextHeight - height) > .01) { height = nextHeight; host.style.height = fx(height) + 'px'; options.onHeight(height) }
    const fr = host.getBoundingClientRect(), mark = options.mark(), mr = mark?.getBoundingClientRect()
    const w = fr.width, h = Math.max(height - strip, 8), cx = w / 2, cy = Math.max(14, h / 2)
    if (mr) L = { x: mr.left + mr.width / 2 - fr.left, y: mr.top + mr.height / 2 - fr.top }
    const markR = MARK_R + pulse * pulse * .8

    // Forces: an oval pull to the middle, recent topics rise toward the card, related topics stick together, pressure where cells touch, slow wander.
    const forces = (dt: number) => {
      let top = Infinity, bottom = -Infinity, x0 = Infinity, x1 = -Infinity
      for (const c of live) if (drag?.cell !== c) { top = Math.min(top, c.y - c.R); bottom = Math.max(bottom, c.y + c.R); x0 = Math.min(x0, c.x - c.R); x1 = Math.max(x1, c.x + c.R) }
      const shiftX = x1 > x0 ? (cx - (x0 + x1) / 2) * 3 : 0, shiftY = bottom > top ? (cy - (top + bottom) / 2) * 2 : 0
      for (const c of cells) {
        let fx2 = 0, fy2 = 0, damp = .06
        c.age += dt
        if (c.mode === 'bud') {
          const dx = cx - L.x, dy = cy - L.y, d = Math.hypot(dx, dy) || 1
          const reach = markR + sizeOf(c) * sz * c.scale * .95 + c.age * 9 * sz
          fx2 = (L.x + dx / d * reach - c.x) * 90; fy2 = (L.y + dy / d * reach - c.y) * 90; damp = .002
          if (c.age > .8) { c.mode = 'live'; c.hidden = false; c.away = false; c.vx += dx / d * 120; c.vy += dy / d * 120; c.onBorn?.(); c.onBorn = undefined }
        } else if (c.mode === 'leave') {
          if (c.into && cells.includes(c.into)) { fx2 = (c.into.cx - c.x) * 40; fy2 = (c.into.cy - c.y) * 40; damp = .003 }
        } else if (c.mode === 'fling') {
          damp = .35
        } else if (c.hidden) {
          fx2 = (cx - c.x) * 4; fy2 = (cy - c.y) * 4
        } else {
          const act = c.cur || c.state !== 'idle' ? 1 : c.w
          const ox = cx - c.x, oy = (cy - c.y) * 1.8, od = Math.hypot(ox, oy) || 1, pull = Math.min(od, 30 * sz) * 1.6
          // The topic main chat is in rises closest to the card it belongs to.
          fx2 += ox / od * pull + shiftX; fy2 += oy / od * pull + shiftY - (28 * (act - .45) + (c.cur ? 45 : 0)) * sz
          const wob = (c.state === 'running' ? 14 : c.state === 'idle' ? 3 + 4 * c.w : 5) * sz
          fx2 += wob * Math.sin(t * .31 + c.phase) + wob * .5 * Math.sin(t * .83 + c.phase * 2)
          fy2 += wob * Math.cos(t * .27 + c.phase * 1.4)
          for (const o of live) {
            if (o === c) continue
            const dx = o.x - c.x, dy = o.y - c.y, d = Math.hypot(dx, dy) || .01, rest = (c.R + o.R) * .93, lw = linkW(c, o)
            const f = d < rest ? -(rest - d) * 40 : d < rest * 1.5 ? (d - rest) * Math.max(4, 11 + 12 * lw) : lw > 0 && d < rest * 3.2 ? (d - rest) * 6 * lw : 0
            fx2 += dx / d * f; fy2 += dy / d * f
          }
          // Cells lean toward the pointer, except with reduced motion.
          if (ptr && !drag && !still) {
            const dx = ptr.x - c.x, dy = ptr.y - c.y, d = Math.hypot(dx, dy) || 1, reach = 80 * sz
            if (d < reach) { const f = (c.state === 'running' ? 16 : 6) * (1 - d / reach); fx2 += dx / d * f; fy2 += dy / d * f }
          }
          if (drag?.cell !== c) {
            const pad = c.R * .8
            if (c.x < pad) fx2 += (pad - c.x) * 30
            if (c.x > w - pad) fx2 -= (c.x - (w - pad)) * 30
            const top = c.R * c.scale + TOP_GAP + 1
            if (c.y < top) fy2 += (top - c.y) * 30
            if (c.y > h - pad * .7) fy2 -= (c.y - (h - pad * .7)) * 30
          }
        }
        if (drag?.cell === c) { fx2 += (c.tx - c.x) * 70; fy2 += (c.ty - c.y) * 70 }
        // While a cell is being dragged the others hold their places, so the one under the pointer stays there to be dropped on.
        else if (drag?.started && c.mode === 'live' && !c.hidden) { c.vx = c.vy = 0; continue }
        c.vx = (c.vx + fx2 * dt) * Math.pow(damp, dt); c.vy = (c.vy + fy2 * dt) * Math.pow(damp, dt)
        c.x += c.vx * dt; c.y += c.vy * dt
      }
      for (const [c, o] of bonds) {
        const dx = o.x - c.x, dy = o.y - c.y, d = Math.hypot(dx, dy) || 1, f = (d - (c.R + o.R) * .9) * 10 * dt
        c.vx += dx / d * f; c.vy += dy / d * f; o.vx -= dx / d * f; o.vy -= dy / d * f
      }
    }
    // Reduced motion: the same forces run ahead within this frame, so the cells are where they settle instead of drifting there.
    for (let i = still ? 24 : 1; i > 0; i--) forces(dt)

    for (const c of [...cells]) {
      if (c.mode === 'leave') {
        const o = c.into, alive = !!o && cells.includes(o)
        // Reduced motion: a merged or removed topic is simply gone, it does not travel into the other.
        if (still) c.alpha = 0
        else if (alive) {
          const d = Math.hypot(c.x - o!.cx, c.y - o!.cy)
          c.scale = ease(c.scale, clamp((d - o!.R * .3) / 50, .08, 1), 6, dt)
          if (d < o!.R * .45 || c.age > 3) c.alpha = ease(c.alpha, 0, 14, dt)
        } else { c.scale = ease(c.scale, 0, 5, dt); c.alpha = ease(c.alpha, 0, 4, dt) }
        if (c.alpha < .04 || c.scale < .03) {
          c.g.remove(); c.neck.remove(); c.gr.remove(); cells.splice(cells.indexOf(c), 1)
          if (alive) { o!.kick = 1; o!.flash = .7 }
          continue
        }
      } else if (c.mode === 'fling') {
        // Past the sidebar it fades; then it waits in the fold.
        const sr = options.side()?.getBoundingClientRect(), gx0 = fr.left + c.x, gy0 = fr.top + c.y
        const outBy = sr ? Math.max(gx0 - sr.right, sr.left - gx0, gy0 - sr.bottom, sr.top - gy0, 0) : 0
        c.alpha = clamp(1 - outBy / 90)
        if (c.alpha < .03 || c.age > 1.4) { c.mode = 'live'; c.aside = true; c.hidden = true; c.away = true; c.alpha = 1; c.scale = 0; c.vx = c.vy = 0; c.x = cx; c.y = cy; c.g.style.pointerEvents = ''; more.kick = 1; continue }
      } else if (c.mode === 'bud') c.scale = still ? 1 : ease(c.scale, .2 + c.age * .45, 5, dt)
      else c.scale = still ? (c.hidden ? 0 : 1) : ease(c.scale, c.hidden ? 0 : 1, c.hidden ? 5 : 2.5, dt)
      c.g.style.display = c.scale < .02 ? 'none' : ''
      c.g.style.pointerEvents = c.mode === 'live' && !c.hidden ? '' : 'none'
      if (c.scale < .02) { c.nf.setAttribute('d', ''); c.ne.setAttribute('d', ''); continue }
      c.heat = ease(c.heat, c.state === 'running' ? 1 : 0, 1.3, dt)
      c.solid = ease(c.solid, c.state === 'queued' ? 0 : 1, 2.2, dt)
      c.kick = Math.max(0, c.kick - dt / .9)
      c.flash = Math.max(0, c.flash - dt / 1.4)
      if (c.ask) c.flash = Math.max(c.flash, .25 + .15 * Math.sin(t * 3))

      const running = c.state === 'running', tt = running ? t : 0
      // Reading with the pointer: cells near it swell a little, like a magnifier, and their names surface.
      let near = 0
      if (c.mode === 'live' && c.kind === 'topic' && sz > .7) {
        if (drag) near = drag.cell === c || drag.rest?.cell === c || (target?.kind === 'cell' && target.cell === c) ? 1 : 0
        else if (ptr) { const d = Math.hypot(ptr.x - c.cx, ptr.y - c.cy) - c.R * .4; near = clamp(1 - d / 52); near = near * near * (3 - 2 * near) }
      }
      c.reveal = ease(c.reveal, near, near > c.reveal ? 9 : 4, dt)
      // Reduced motion: no swelling under the pointer, no stretching with speed and no breath when something arrives.
      const r0 = sizeOf(c) * sz * (1 + (still ? 0 : (named(c) ? .04 : .2) * c.reveal))
      c.svx = ease(c.svx, c.vx, 8, dt); c.svy = ease(c.svy, c.vy, 8, dt)
      const speed = Math.hypot(c.svx, c.svy), st = still ? 0 : Math.min(c.mode === 'fling' ? .2 : .12, speed / 1100), ux0 = c.svx / (speed || 1), uy0 = c.svy / (speed || 1)
      const sigh = still ? 1 : 1 + .1 * Math.sin(Math.PI * (1 - c.kick)) * (c.kick > 0 ? 1 : 0)
      let pts: number[][] = []
      for (let i = 0; i < N; i++) {
        const th = i / N * Math.PI * 2, ux = Math.cos(th), uy = Math.sin(th), along = ux * ux0 + uy * uy0
        let r = (c.R + (running ? (.35 * Math.sin(2 * th + tt * .5 + c.phase) + .25 * Math.sin(3 * th - tt * .37 + c.phase)) * sz : 0)) * c.scale * sigh
        r *= 1 + st * (2 * along * along - 1)
        if (c.mode === 'live') for (const o of live) {
          // The cell being dragged floats over the others: it does not dent them, so the one under the pointer keeps its shape.
          if (o === c || (drag?.started && o === drag.cell)) continue
          const ox = o.x - c.x, oy = o.y - c.y, D = Math.hypot(ox, oy)
          if (D < .01 || D > c.R + o.R + 4) continue
          const dot = (ux * ox + uy * oy) / D
          if (dot <= .05) continue
          r = smin(r, (D / 2 + (c.R * c.R - o.R * o.R) / (2 * D) - GAP / 2) / dot, SOFT * sz)
        }
        // A cell dragged right over another gives a negative cut; never let the outline turn inside out.
        r = Math.max(r, c.R * c.scale * .35)
        pts.push([c.x + r * ux, c.y + r * uy])
      }
      // The soft force alone cannot stop a current/running cell crossing the card. Constrain the final deformed curve,
      // including smoothing and 1px for the widest stroke. An intentional drag/throw is allowed to cross the card.
      const contour = foamContour(pts, c.mode === 'fling' || (drag?.started && drag.cell === c) ? -Infinity : TOP_GAP + 1)
      if (contour.offsetY) {
        pts = contour.points; c.y += contour.offsetY
        c.vy = Math.max(0, c.vy); c.svy = Math.max(0, c.svy)
      }
      // Keep each cell's volume: squeezed cells bulge on their free side. The dragged one keeps its size.
      if (c.mode === 'live' && !c.hidden && drag?.cell !== c) {
        const area = polygonArea(pts) / Math.max(.01, (c.scale * sigh) ** 2)
        c.R = Math.min(ease(c.R, r0 * Math.sqrt(Math.PI * r0 * r0 / Math.max(area, 1)), still ? 15 : 2, dt), r0 * 1.2)
      } else c.R = still ? r0 : ease(c.R, r0, 4, dt)
      let gx = 0, gy = 0
      for (const p of pts) { gx += p[0]; gy += p[1] }
      gx /= N; gy /= N; c.cx = gx; c.cy = gy
      c.vin = Infinity; c.vr = 0
      for (const p of pts) { const r = Math.hypot(p[0] - gx, p[1] - gy); c.vin = Math.min(c.vin, r); c.vr = Math.max(c.vr, r) }
      const d = contour.path
      c.b.setAttribute('d', d); c.h.setAttribute('d', d); c.m.setAttribute('d', d)
      c.b.style.fillOpacity = fx(c.solid); c.h.style.opacity = fx(Math.min(1, c.heat + c.flash))
      c.stop.setAttribute('stop-opacity', fx(.18 * (1 + 1.4 * c.flash)))
      if (c.solid < .985) c.m.setAttribute('stroke-dasharray', `2.5 ${fx(3.5 * (1 - c.solid))}`)
      else if (c.kind === 'topic' && !c.ask) c.m.removeAttribute('stroke-dasharray')
      if (c.heat + c.flash > .01) { c.gr.setAttribute('cx', fx(50 + 16 * Math.sin(t * .23 + c.phase)) + '%'); c.gr.setAttribute('cy', fx(46 + 13 * Math.sin(t * .19 + c.phase * 1.3)) + '%') }
      c.g.style.opacity = fx(c.alpha)

      // Nucleus and name as one centred block: nucleus on top, the name below on one or two lines.
      const rr = (c.mode === 'live' ? r0 : c.R) * c.scale
      let lay = c.kind === 'more' ? { lines: [c.title], font: 10, lh: 12 } : foamLabel(c.title, rr)
      // A title too long for the cell gives way to its short name; the full title stays in the hint and the keyboard list.
      if (!lay.lines.length && c.kind === 'topic') lay = foamLabel(foamShortName(c.title, c.short), rr)
      const key = lay.lines.join('\n') + '|' + lay.font
      if (key !== c.shownKey) {
        c.shownKey = key; c.lay = lay
        c.label.textContent = ''
        for (const line of lay.lines) { const span = document.createElementNS(NS, 'tspan'); span.setAttribute('x', '0'); span.textContent = line; c.label.appendChild(span) }
        c.label.setAttribute('font-size', String(lay.font))
      }
      c.want = ease(c.want, named(c) ? 1 : 0, 2.5, dt)
      // One name read at a time: the cell being read (or, in a drag, the dragged cell and where it would go) in full,
      // the others as hints. With no pointer the hints keep their level while they fade, so none flares up on the way out.
      const lit = drag ? c === drag.cell || c === drag.rest?.cell || (target?.kind === 'cell' && target.cell === c) : ptr ? c === reading : undefined
      const focusTo = lit === undefined ? (c.reveal < .01 ? 1 : c.focus) : lit ? 1 : NEIGHBOUR_NAME
      c.focus = ease(c.focus, focusTo, focusTo > c.focus ? 14 : 8, dt)
      const vis = words * clamp((c.scale - .6) / .4) * (lay.lines.length ? 1 : 0) * Math.max(c.want, c.reveal * c.focus)
      c.full = c.kind === 'more' || (vis > .5 && lay.lines.join('') === c.title)
      c.label.style.opacity = fx(vis)
      c.nx = ease(c.nx, running ? 1.4 * Math.sin(tt * .53 + c.phase) + .5 * Math.sin(tt * 1.1 + c.phase * 2) : 0, 3, dt)
      c.ny = ease(c.ny, running ? Math.sin(tt * .41 + c.phase * 1.7) : 0, 3, dt)
      const nr = c.kind === 'more' ? 0 : c.state === 'wait' ? 3.4 : c.state === 'done' ? 3.2 : c.cur ? 2.9 : running ? 2.6 + .15 * Math.sin(tt * .6 + c.phase) : c.state === 'queued' ? 2.4 : 1.8 + c.w * .8
      const lines = c.lay.lines.length, block = c.kind === 'more' ? 0 : lines ? 2 * nr + 4 + lines * c.lay.lh : 0, room = clamp(vis * 1.4)
      const top0 = gy - block / 2 * c.scale
      c.n.setAttribute('cx', fx(gx + c.nx * sz)); c.n.setAttribute('cy', fx(gy + ((lines ? top0 + nr * c.scale : gy) - gy) * room + c.ny * sz))
      c.n.setAttribute('r', fx(nr * c.scale * Math.max(.62, sz)))
      const ty = c.kind === 'more' ? gy : top0 + (2 * nr + 4 + c.lay.lh / 2) * c.scale
      c.label.setAttribute('transform', `translate(${fx(gx)} ${fx(ty)}) scale(${fx(Math.max(.01, c.scale))})`)
      Array.from(c.label.children).forEach((s, i) => s.setAttribute('y', fx(i * c.lay.lh)))

      // Necks: budding off the mark, fusing into another topic, a pending merge, or the preview while dragging onto a topic.
      let neck: ReturnType<typeof bridge> = null, other: Cell | undefined
      if (c.mode === 'bud') neck = bridge(L, markR, { x: gx, y: gy }, rr)
      else if (c.mode !== 'fling') {
        other = c.mode === 'leave' ? c.into : bonds.find(b => b[0] === c)?.[1] ?? (drag?.cell === c && target?.kind === 'cell' ? target.cell : undefined)
        if (other && cells.includes(other)) neck = bridge(pos(other), other.R * other.scale, { x: gx, y: gy }, rr, c.mode === 'leave' ? rr * 1.6 : rr + 6 * sz)
      }
      c.nf.setAttribute('d', neck ? neck.fill : ''); c.ne.setAttribute('d', neck ? neck.edge : '')
      if (neck) c.nf.style.fill = other?.state === 'done' ? 'var(--foam-done)' : other && other.state === 'idle' && !other.cur ? 'var(--foam-bg)' : 'var(--foam-tint)'
      c.neck.style.opacity = fx(c.alpha)
    }
    drawDups(dt, { w, h, top: TOP_GAP })

    // Hit areas: small cells get a steady 24px circle to press where there is room, split fairly between neighbours and kept
    // inside the box. The cell being dragged is left out, so the ones it may land on keep theirs while it passes over them.
    // The duplicate pores take part as points with no outline of their own, so the room around them is split with the cells.
    const pressable = cells.filter(c => c.mode === 'live' && !c.hidden && c.scale >= .02 && !(drag?.started && drag.cell === c))
    const porous = [...dups.values()].filter(d => d.px !== null)
    const hits = foamPoreHits(pressable.map(c => ({ x: c.cx, y: c.cy, r: c.R * c.scale, floor: c.vin, reach: c.vr })),
      porous.map(d => ({ x: d.px!, y: d.py, shown: d.room })), { w, h, top: TOP_GAP })
    for (const c of cells) {
      const i = pressable.indexOf(c), r = i < 0 ? 0 : hits.cells[i]
      if (r || c.hit) { c.hit = r; c.hc.setAttribute('cx', fx(c.cx)); c.hc.setAttribute('cy', fx(c.cy)); c.hc.setAttribute('r', fx(r)) }
    }
    placePores(porous, hits.pores)
    // A menu whose topic went away (merged, removed) closes rather than act on a cell that is no longer there.
    if (menuOf && menuOf.cell.kind === 'topic' && (menuOf.cell.mode === 'leave' || !cells.includes(menuOf.cell))) closeMenu('gone')

    // Vesicles: each message buds off one body, arcs over, and fuses into the other.
    for (const v of [...ves]) {
      v.t += dt / v.dur
      const p0 = v.from(), p2 = v.to(), k = v.t >= 1 ? 1 : v.t < .5 ? 2 * v.t * v.t : 1 - (-2 * v.t + 2) ** 2 / 2
      const mx = (p0.x + p2.x) / 2, my = (p0.y + p2.y) / 2, dx = p2.x - p0.x, dy = p2.y - p0.y
      const c1 = { x: mx - dy * .22, y: my + dx * .22 }
      let x = (1 - k) ** 2 * p0.x + 2 * (1 - k) * k * c1.x + k * k * p2.x, y = (1 - k) ** 2 * p0.y + 2 * (1 - k) * k * c1.y + k * k * p2.y
      const holding = typeof v.hold === 'function' ? !v.hold() : v.t < 1 + v.hold / v.dur
      if (v.t >= 1 && v.hold && holding) { x += 2.2 * Math.sin(t * 2.1); y += 1.6 * Math.sin(t * 2.9) }
      const grow = v.hold ? clamp(k / .15) : clamp(k / .15) * clamp((1 - k) / .2 + .25)
      v.el.setAttribute('transform', `translate(${fx(x)} ${fx(y)}) scale(${fx(grow * Math.max(.7, sz) * (v.el.hasAttribute('data-small') ? .7 : 1))})`)
      if (v.t >= 1 && !(v.hold && holding)) { v.el.remove(); ves.splice(ves.indexOf(v), 1); v.arrive() }
    }

    pulse = Math.max(0, pulse - dt * 1.4)
    options.onPulse?.(pulse * pulse)
    void T
  }

  // When frames come slowly (a busy machine, a throttled window), catch up in a few small steps so motion keeps its real pace.
  const frame = (n: number) => {
    let left = Math.min(4 / 30, Math.max(0, (n - last) / 1000)); last = n
    do {
      const dt = Math.min(1 / 30, left); left -= dt
      if (!reduced()) t += dt
      step(dt)
    } while (left > 1e-3)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return {
    update, event,
    setRail(on) { if (on !== rail) cancelDrag(); rail = on; host.classList.toggle('rail', on) },
    destroy() {
      cancelAnimationFrame(raf); clearInterval(tipTimer); clearTimeout(tipWait)
      window.removeEventListener('pointermove', move); document.documentElement.removeEventListener('pointerleave', away); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', blur); window.removeEventListener('lostpointercapture', blur); window.removeEventListener('scroll', scrolled, true); document.removeEventListener('visibilitychange', hiddenPage); window.removeEventListener('blur', blur)
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown, true); motion.removeEventListener('change', motionChanged)
      closeDup(false); document.removeEventListener('pointerdown', dupPointer, true); document.removeEventListener('keydown', dupKey, true)
      closeMenu(); closePop(); hideUndo(); undo.remove(); tip.remove(); svg.remove(); list.remove(); entry.remove(); host.classList.remove('theone-foam', 'rail')
    },
  }
}

/** Colours follow the main card: warm tint and accent in light, blue in dark; idle cells take the sidebar's own fill. */
export const foamCss = `
.theone-foam{position:fixed;left:0;top:0;width:0;height:8px;z-index:20;pointer-events:none;--foam-bg:var(--dsw-specific-sidebar-fill,#f7f7f5);--foam-tint:#fff5ec;--foam-accent:#a75b1e;--foam-heat:#ff7800;--foam-line:#c99267;--foam-done:#ffffff;--foam-idle-line:#d8d3ca;--foam-idle-dot:#cdb8a3;--foam-queue-line:#c4c1b8;--foam-queue-ink:#9a988f;--foam-fail:#b9785f;--foam-text:var(--dsw-alias-label-primary,#2b2b2b);--foam-muted:var(--dsw-alias-label-secondary,#8a8a86)}
[data-ds-dark-theme] .theone-foam{--foam-bg:var(--dsw-specific-sidebar-fill,#1f1f22);--foam-tint:#1d2a37;--foam-accent:#93c8f3;--foam-heat:#80caff;--foam-line:#5d87ab;--foam-done:#2b2b30;--foam-idle-line:#4a515a;--foam-idle-dot:#5a7086;--foam-queue-line:#4d555e;--foam-queue-ink:#7f8a94;--foam-fail:#c98a74}
.theone-foam>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.theone-foam-list{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.theone-cell{cursor:grab;pointer-events:auto}
.theone-cell.drag{cursor:grabbing}
.theone-cell [data-part=hit]{fill:transparent;stroke:none}
.theone-cell [data-part=body]{stroke:none;fill:var(--foam-bg);transition:fill .8s ease}
.theone-cell [data-part=membrane]{fill:none;stroke:var(--foam-idle-line);stroke-width:1.2;stroke-linejoin:round;stroke-linecap:round;transition:stroke .8s ease,stroke-width .4s ease}
.theone-cell [data-part=nucleus]{fill:var(--foam-idle-dot);transition:fill .6s ease,stroke .6s ease}
.theone-cell text{fill:var(--foam-muted);text-anchor:middle;dominant-baseline:middle;pointer-events:none;user-select:none;letter-spacing:.02em;transition:fill .6s ease}
.theone-cell.running [data-part=body],.theone-cell.queued [data-part=body]{fill:var(--foam-tint)}
.theone-cell.running [data-part=membrane]{stroke:var(--foam-line);stroke-width:1.3}
.theone-cell.running [data-part=nucleus],.theone-cell.done [data-part=nucleus]{fill:var(--foam-accent)}
.theone-cell.running text,.theone-cell.done text{fill:var(--foam-text)}
.theone-cell.done [data-part=body]{fill:var(--foam-done)}
.theone-cell.done [data-part=membrane]{stroke:var(--foam-line);stroke-width:1.3}
.theone-cell.queued [data-part=membrane]{stroke:var(--foam-queue-line)}
.theone-cell.queued [data-part=nucleus]{fill:transparent;stroke:var(--foam-queue-ink);stroke-width:1}
.theone-cell.queued text{fill:var(--foam-queue-ink)}
.theone-cell.wait [data-part=body]{fill:var(--foam-tint)}
.theone-cell.wait [data-part=membrane]{stroke:var(--foam-accent);stroke-width:1.4}
.theone-cell.wait [data-part=nucleus]{fill:transparent;stroke:var(--foam-accent);stroke-width:1.4}
.theone-cell.wait text{fill:var(--foam-text)}
.theone-cell.fail [data-part=membrane]{stroke:var(--foam-fail);stroke-dasharray:1.5 2.5}
.theone-cell.fail [data-part=nucleus]{fill:transparent;stroke:var(--foam-fail);stroke-width:1.2}
.theone-cell.fail text{fill:var(--foam-fail)}
.theone-cell.cur [data-part=body]{fill:var(--foam-tint)}
.theone-cell.cur [data-part=membrane]{stroke:var(--foam-accent);stroke-width:1.4}
.theone-cell.cur [data-part=nucleus]{fill:var(--foam-accent)}
.theone-cell.cur text{fill:var(--foam-accent)}
.theone-cell.lit [data-part=membrane]{stroke:var(--foam-accent);stroke-width:1.6;transition-duration:.15s}
.theone-cell.ask [data-part=membrane]{stroke:var(--foam-accent);stroke-dasharray:3 3}
.theone-cell.fuse [data-part=membrane]{stroke:var(--foam-accent);stroke-width:1.6}
.theone-cell.more{cursor:pointer}
.theone-cell.offer{cursor:pointer}
.theone-cell.offer [data-part=membrane]{stroke:var(--foam-line)}
.theone-cell.offer [data-part=nucleus]{fill:var(--foam-accent)}
.theone-cell.pending [data-part=membrane]{stroke:var(--foam-accent);stroke-dasharray:2 3;animation:theone-foam-march 1s linear infinite}
@keyframes theone-foam-march{to{stroke-dashoffset:-10}}
.theone-foam-undo{position:fixed;z-index:1000;transform:translate(-50%,3px);padding:3px 10px;border:.5px solid var(--dsw-alias-border-l2,#8885);border-radius:999px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#2b2b2b);font:inherit;font-size:12px;line-height:1.5;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .15s,transform .15s}
.theone-foam-undo.on{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
.theone-cell.more [data-part=membrane]{stroke-dasharray:1.2 3}
.theone-neck [data-part=edge]{fill:none;stroke:var(--foam-line);stroke-width:1.3;stroke-linecap:round}
.theone-dup-thread{fill:none;stroke:var(--foam-line);stroke-width:1.2;stroke-linecap:round;stroke-dasharray:0 3.4;pointer-events:none}
.theone-dup-thread.open{stroke:var(--foam-accent)}
.theone-dup{cursor:pointer}
.theone-dup [data-part=hit]{fill:none;stroke:none;pointer-events:all}
.theone-dup [data-part=ring]{fill:var(--foam-bg);stroke:var(--foam-line);stroke-width:1.1;stroke-linecap:round;stroke-dasharray:0 2.5;pointer-events:none;transition:stroke .2s ease}
.theone-dup:hover [data-part=ring],.theone-dup.open [data-part=ring]{stroke:var(--foam-accent)}
.theone-foam-dup{width:max-content;max-width:min(260px,calc(100vw - 16px))}
.theone-foam-dup-head{padding:6px 12px 4px}
.theone-foam-dup-title{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#8a8a86)}
.theone-foam-dup-name{font-size:13.5px;line-height:1.4;padding:2px 0;white-space:normal;overflow-wrap:anywhere}
.theone-foam-menu.theone-foam-dup button{height:auto;min-height:34px;padding:7px 12px;line-height:1.35;white-space:normal;overflow-wrap:anywhere}
.theone-vesicle [data-part=membrane]{fill:var(--foam-tint);stroke:var(--foam-accent);stroke-width:1.1}
.theone-vesicle [data-part=nucleus]{fill:var(--foam-accent)}
html[data-theone-foam] button:has(.theone-workspace-entry){display:none}
[data-row-key][data-theone-drop=true]{background:color-mix(in srgb,#ff7800 10%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,#a75b1e 40%,transparent);border-radius:10px}
.theone-foam-tip{position:fixed;z-index:1000;padding:4px 8px;border-radius:7px;background:var(--dsw-alias-label-primary,#2e2d2a);color:var(--dsw-alias-bg-base,#f4f3ef);font-size:11.5px;line-height:1.5;max-width:min(240px,calc(100vw - 16px));box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;pointer-events:none;opacity:0;transform:translateY(3px);transition:opacity .12s,transform .12s}
.theone-foam-tip[data-side=below]{transform:translateY(-3px)}
.theone-foam-tip.on{opacity:1;transform:none}
.theone-foam-menu{position:fixed;z-index:1000;box-sizing:border-box;min-width:168px;max-width:min(320px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow-y:auto;overscroll-behavior:contain;padding:4px;border:.5px solid var(--dsw-alias-border-l2,#8885);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#fff));backdrop-filter:blur(24px) saturate(1.4);box-shadow:var(--dsw-elevation-prominent,0 8px 30px #0003);color:var(--dsw-alias-label-primary)}
.theone-foam-menu button{display:flex;width:100%;min-height:34px;align-items:center;padding:7px 12px;line-height:1.4;white-space:normal;overflow-wrap:anywhere;border:0;border-radius:var(--dsw-radius-md,8px);background:none;color:inherit;font:inherit;font-size:13.5px;cursor:pointer;text-align:left}
.theone-foam-menu button:hover,.theone-foam-menu button:focus-visible{background:var(--dsw-alias-interactive-bg-hover,#0000000a);outline:none}
.theone-foam-menu button:disabled{cursor:default;background:none;color:var(--dsw-alias-label-secondary,#8a8a86)}
.theone-foam-menu hr{border:0;border-top:.5px solid var(--dsw-alias-border-l2,#8885);margin:4px 2px}
.theone-foam-all{position:absolute;right:6px;bottom:0;display:flex;align-items:center;gap:2px;height:18px;min-width:24px;padding:0 4px;border:0;border-radius:6px;background:none;color:var(--foam-idle-line);font:inherit;font-size:10.5px;line-height:1;font-variant-numeric:tabular-nums;cursor:pointer;pointer-events:auto;transition:color .3s ease}
.theone-foam-all[hidden]{display:none}
.theone-foam.rail .theone-foam-all{right:auto;left:50%;transform:translateX(-50%)}
.theone-foam-all svg{width:18px;height:12px;overflow:visible}
.theone-foam-all circle{fill:var(--foam-bg);stroke:currentColor;stroke-width:1.1}
.theone-foam-all:hover{color:var(--foam-line)}
.theone-foam-all:focus-visible{outline:1.5px solid var(--foam-accent);outline-offset:1px;color:var(--foam-line)}
.theone-foam-all.need{color:var(--foam-accent)}
.theone-foam-all span:empty{display:none}
.theone-foam-pop{--foam-accent:#a75b1e;width:max-content;max-width:min(280px,calc(100vw - 16px));overflow:auto;overscroll-behavior:contain;box-sizing:border-box}
[data-ds-dark-theme] .theone-foam-pop{--foam-accent:#93c8f3}
.theone-foam-pop button{height:auto;min-height:34px;padding-top:6px;padding-bottom:6px;line-height:1.35}
.theone-foam-head{padding:8px 12px 6px;display:flex;flex-direction:column;gap:2px}
.theone-foam-name{font-size:13.5px;line-height:1.4;white-space:normal;overflow-wrap:anywhere}
.theone-foam-head .theone-foam-name{font-weight:600}
.theone-foam-status{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary,#8a8a86)}
.theone-foam-status.need{color:var(--foam-accent)}
.theone-foam-pop .theone-foam-primary{color:var(--foam-accent);font-weight:600}
.theone-foam-all-list{width:min(280px,calc(100vw - 16px));display:flex;flex-direction:column;overflow:hidden}
.theone-foam-filter{flex:none;width:100%;box-sizing:border-box;height:30px;margin:0 0 4px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2,#8885);border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;font-size:13px;outline:none}
.theone-foam-filter:focus-visible{border-color:var(--foam-accent)}
.theone-foam-rows{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
.theone-foam-pop .theone-foam-row{flex-direction:column;align-items:flex-start;justify-content:center;gap:1px}
.theone-foam-row[aria-current=true] .theone-foam-name{color:var(--foam-accent)}
.theone-foam-empty{display:block;padding:6px 12px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#8a8a86)}
.theone-foam-empty[hidden]{display:none}
.theone-foam-all-list>hr,.theone-foam-all-list>button{flex:none}
@media(prefers-reduced-motion:reduce){.theone-foam-all{transition:none}.theone-cell [data-part=membrane],.theone-cell [data-part=body]{transition:none}.theone-cell.pending [data-part=membrane]{animation:none}.theone-foam-undo,.theone-foam-tip{transition:none}.theone-dup [data-part=ring]{transition:none}}
`
