import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeStore } from './runtime-store.ts'
import type { RouteResult } from './service.ts'

export interface PrerouteInput { gatewayId: string; inputId?: string; text: string }
export interface PrerouteEntry extends PrerouteInput {
  key: string; generation: string; textHash: string; at: number; expiresAt: number; state: 'queued' | 'running' | 'done' | 'discarded'
  owner?: string; pid?: number; startedAt?: number; consumedBy?: string; result?: RouteResult
  shadow?: { inputId: string; decision: RouteResult['decision'] }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const normalizedTextHash = (text: string) => digest(text.normalize('NFKC').trim().replace(/\s+/gu, ' '))
const cacheKey = (input: PrerouteInput) => digest([input.gatewayId, input.inputId ? 'id' : 'text', input.inputId ?? normalizedTextHash(input.text)])
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' } }
export const PREROUTE_TTL_MS = 180000
export const PREROUTE_LIMIT = 200

/** Shared by the short-lived hook and MCP servers. No inference and no network. */
export function enqueuePreroute(runtime: RuntimeStore, input: PrerouteInput): PrerouteEntry {
  if (!input.gatewayId?.trim() || input.gatewayId.length > 200 || input.inputId !== undefined && (!input.inputId.trim() || input.inputId.length > 200) || !input.text?.trim() || input.text.length > 100000) throw Error('PREROUTE_INPUT_INVALID')
  const key = cacheKey(input), textHash = normalizedTextHash(input.text), now = Date.now()
  return runtime.transaction(() => {
    const records = runtime.all<PrerouteEntry>('preroute')
    for (const entry of records) if (entry.expiresAt <= now) runtime.remove('preroute', entry.key)
    const old = runtime.get<PrerouteEntry>('preroute', key)
    if (old) {
      if (old.textHash !== textHash) throw Error('INPUT_CONFLICT')
      return old
    }
    // A renderer without a turn id and a hook with it must share the same work.
    const alias = runtime.get<PrerouteEntry>('preroute', cacheKey({ gatewayId: input.gatewayId, text: input.text }))
    if (input.inputId && alias && alias.expiresAt > now && (!alias.consumedBy || alias.consumedBy === input.inputId)) {
      alias.consumedBy = input.inputId; runtime.put('preroute', alias.key, alias); return alias
    }
    const same = !input.inputId && records.findLast(e => e.inputId && e.gatewayId === input.gatewayId && e.textHash === textHash && e.expiresAt > now)
    if (same) return same
    const live = runtime.all<PrerouteEntry>('preroute')
    if (live.length >= PREROUTE_LIMIT) {
      const evict = live.find(e => e.state === 'done' || e.state === 'discarded')
      if (!evict) throw Error('PREROUTE_CAPACITY')
      runtime.remove('preroute', evict.key)
    }
    const entry: PrerouteEntry = { ...input, key, generation: randomUUID(), textHash, at: now, expiresAt: now + PREROUTE_TTL_MS, state: 'queued' }
    runtime.put('preroute', key, entry)
    return entry
  })
}

/** Persistent, bounded speculation with cross-connection claims and one original deadline. */
export class Preroutes {
  private owner = randomUUID()
  private active = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  constructor(private runtime: RuntimeStore, private compute: (entry: PrerouteEntry, signal: AbortSignal) => Promise<RouteResult>, private signal: AbortSignal, private timeoutMs = 30000) {}
  enqueue(input: PrerouteInput) { const entry = enqueuePreroute(this.runtime, input); this.start(entry); return { key: entry.key, state: entry.state, expiresAt: entry.expiresAt } }
  pending() { return this.runtime.all<PrerouteEntry>('preroute').some(e => e.expiresAt > Date.now() && ['queued','running'].includes(e.state)) }
  invalidate(gatewayId: string) { for (const entry of this.runtime.all<PrerouteEntry>('preroute')) if (entry.gatewayId === gatewayId) this.discard(entry) }
  drain() {
    for (const entry of this.runtime.all<PrerouteEntry>('preroute')) {
      if (entry.expiresAt <= Date.now()) { this.active.get(entry.key)?.controller.abort(); this.runtime.remove('preroute', entry.key) }
      else if (entry.state === 'queued' || entry.state === 'running' && !alive(entry.pid)) this.start(entry)
    }
  }
  take(input: PrerouteInput & { inputId: string }) {
    return this.runtime.transaction(() => {
      const exact = this.runtime.get<PrerouteEntry>('preroute', cacheKey(input))
      const entry = exact ?? this.runtime.get<PrerouteEntry>('preroute', cacheKey({ gatewayId: input.gatewayId, text: input.text }))
      if (!entry || entry.expiresAt <= Date.now() || entry.state === 'discarded' || entry.consumedBy && entry.consumedBy !== input.inputId) return
      if (entry.textHash !== normalizedTextHash(input.text)) throw Error('INPUT_CONFLICT')
      entry.consumedBy = input.inputId; this.runtime.put('preroute', entry.key, entry)
      return entry
    })
  }
  discard(entry: PrerouteEntry) {
    this.active.get(entry.key)?.controller.abort()
    this.runtime.put('preroute', entry.key, { ...entry, state: 'discarded', result: undefined, shadow: undefined })
  }
  shadow(entry: PrerouteEntry, inputId: string, decision: RouteResult['decision']) {
    const current = this.runtime.get<PrerouteEntry>('preroute', entry.key)
    if (current) { current.shadow = { inputId, decision }; this.runtime.put('preroute', entry.key, current); if (current.result) this.recordShadow(current) }
    this.start(entry)
  }
  private recordShadow(entry: PrerouteEntry) {
    if (!entry.shadow || !entry.result) return
    const a = entry.shadow.decision, b = entry.result.decision
    this.runtime.put('preroute-shadow', entry.key, { gatewayId: entry.gatewayId, inputId: entry.shadow.inputId, at: Date.now(),
      proposed: a, observed: b, agreed: a.contextId ? a.contextId === b.contextId : a.action === b.action && a.title === b.title })
    this.runtime.trim('preroute-shadow', PREROUTE_LIMIT)
  }
  private start(entry: PrerouteEntry) {
    if (this.signal.aborted || this.active.has(entry.key)) return
    const claimed = this.runtime.transaction(() => {
      const current = this.runtime.get<PrerouteEntry>('preroute', entry.key)
      if (!current || current.expiresAt <= Date.now() || ['done','discarded'].includes(current.state) || current.state === 'running' && alive(current.pid)) return
      current.state = 'running'; current.owner = this.owner; current.pid = process.pid; current.startedAt = Date.now()
      this.runtime.put('preroute', current.key, current); return current
    })
    if (!claimed) return
    const controller = new AbortController(), signal = AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(this.timeoutMs)])
    const promise = this.compute(claimed, signal).then(result => {
      const current = this.runtime.get<PrerouteEntry>('preroute', entry.key)
      if (current?.owner !== this.owner || current.generation !== claimed.generation || current.state !== 'running' || current.expiresAt <= Date.now()) return
      current.state = 'done'; current.result = result; this.runtime.put('preroute', entry.key, current); this.recordShadow(current)
    }).catch(() => {
      const current = this.runtime.get<PrerouteEntry>('preroute', entry.key)
      if (current?.owner === this.owner && current.generation === claimed.generation && current.state === 'running') this.runtime.put('preroute', entry.key, { ...current, state: 'discarded' })
    }).finally(() => this.active.delete(entry.key))
    this.active.set(entry.key, { promise, controller })
  }
  async wait(entry: PrerouteEntry) {
    this.start(entry)
    const until = (entry.startedAt ?? Date.now()) + this.timeoutMs
    while (!this.signal.aborted) {
      const current = this.runtime.get<PrerouteEntry>('preroute', entry.key)
      if (current?.result) return current.result
      if (!current || current.state === 'discarded' || Date.now() >= until) throw Error('ROUTER_TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    this.signal.throwIfAborted()
    throw Error('ROUTER_UNAVAILABLE')
  }
  async close() { for (const task of this.active.values()) task.controller.abort(); await Promise.allSettled([...this.active.values()].map(task => task.promise)) }
}
