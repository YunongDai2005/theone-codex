import { createHash, randomUUID } from 'node:crypto'
import type { ContextStore } from './store.ts'
import type { RuntimeStore } from './runtime-store.ts'
import type { HistoryPart } from './catalog-types.ts'
import { CATALOG_MAX_TURNS, catalogSessionExcluded, validateCatalog, validateCatalogMatches } from './history-classification.ts'
import { redactRoutingText } from './llm-router.ts'
import { recommendedHistoryModel, validateHistoryModel, type HistoryModelChoice, type HistoryModelSettings } from './history-model-settings.ts'

export interface HistorySession { id: string; title: string; cwd?: string; updatedAt: number; busy?: boolean }
export interface HistoryConversation { turns: { id: string; status: string; items: any[] }[] }
export interface HistorySource { list(signal: AbortSignal): Promise<HistorySession[]>; read(id: string, signal: AbortSignal): Promise<HistoryConversation>; close(): Promise<void> }
export interface CatalogModel { models?(): Promise<HistoryModelChoice[]>; classify(input: any, signal: AbortSignal, settings?: HistoryModelSettings): Promise<unknown>;
  reconcile?(input: any, signal: AbortSignal, settings?: HistoryModelSettings): Promise<unknown>; close(): Promise<void> }
export interface CatalogOptions { source: HistorySource; model: CatalogModel; intervalMs?: number; batchBudget?: number }
type Status = { running: boolean; indexed: number; scanned: number; failed: number; pending: number; excluded: number; currentTitle?: string; error?: string; lastCompletedAt?: number; batches: number }
type Lease = { owner: string; pid: number }
type NativePart = HistoryPart & { turnId: string; position: number; messages: { id: string; role: 'user' | 'assistant'; text: string }[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const initial = (): Status => ({ running: false, indexed: 0, scanned: 0, failed: 0, pending: 0, excluded: 0, batches: 0 })

/** Reads native history through the host API; writes only TheOne's own databases. */
export class HistoryCatalog {
  private owner = randomUUID()
  private task?: Promise<void>
  private abort?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private backlog = false
  constructor(private store: ContextStore, private runtime: RuntimeStore, private options: CatalogOptions) { this.schedule(1500) }
  private permission() { return this.runtime.get<'granted' | 'declined'>('catalog-native-consent', 'main') ?? 'ask' }
  private schedule(ms = this.options.intervalMs ?? 60000) {
    clearTimeout(this.timer)
    if (!this.closed) { this.timer = setTimeout(() => { void this.refresh() }, ms); this.timer.unref() }
  }
  status() {
    const saved = this.runtime.get<Status>('catalog-status', 'main') ?? initial()
    const lease = this.runtime.get<Lease>('catalog-lease', 'main')
    return { ...saved, running: !!lease && alive(lease.pid), paused: !!this.runtime.get('catalog-paused', 'main'), consent: this.permission(), available: true,
      modelSettings: this.runtime.get<HistoryModelSettings>('catalog-model-settings', 'main') ?? null }
  }
  async models() {
    if (!this.options.model.models) throw Error('当前历史整理服务不支持模型选择，请更新插件。')
    const models = await this.options.model.models(), recommended = recommendedHistoryModel(models)
    return { models, recommendedModel: recommended?.model ?? null,
      selection: this.runtime.get<HistoryModelSettings>('catalog-model-settings', 'main') ?? recommended }
  }
  async configureModel(selection: HistoryModelSettings) {
    const { models } = await this.models(), { settings } = validateHistoryModel(selection, models)
    const previous = this.runtime.get<HistoryModelSettings>('catalog-model-settings', 'main')
    if (JSON.stringify(previous) !== JSON.stringify(settings)) {
      this.runtime.put('catalog-model-settings', 'main', settings); this.changed()
    }
    return settings
  }
  private gateways() { return new Set(this.runtime.all<{ gatewayId: string }>('gateway').map(g => g.gatewayId)) }
  private owned() { return new Map(this.runtime.all<{ topicId: string; threadId: string }>('binding').map(b => [b.threadId, b.topicId])) }
  private excluded(s: HistorySession) { return catalogSessionExcluded(s.id, s.cwd, this.store.catalogExclusions()) }
  private changed() { this.runtime.put('catalog-generation', 'main', randomUUID()); this.abort?.abort(); this.schedule(1000) }
  async consent(value: boolean) { this.runtime.put('catalog-native-consent', 'main', value ? 'granted' : 'declined'); this.changed(); return this.status() }
  async sessions() {
    const signal = new AbortController().signal
    const gateways = this.gateways(), own = this.owned()
    const sessions = (await this.options.source.list(signal)).filter(s => !gateways.has(s.id) && !own.has(s.id))
      .map(s => ({ ...s, excluded: this.excluded(s) }))
    const folders = [...new Set(sessions.flatMap(s => s.cwd ? [s.cwd] : []))].map(path => ({ path, excluded: catalogSessionExcluded('', path, this.store.catalogExclusions()) }))
    return { sessions, folders }
  }
  async exclude(kind: 'session' | 'folder', value: string, excluded: boolean) {
    const choices = await this.sessions()
    if (!(kind === 'session' ? choices.sessions.some(s => s.id === value) : choices.folders.some(f => f.path === value))) throw Error('CATALOG_CHOICE_UNKNOWN')
    this.store.setCatalogExcluded(kind, value, excluded); this.changed(); this.reconcile()
    return this.sessions()
  }
  start() { void this.refresh(); return this.status() }
  pause() { this.runtime.put('catalog-paused', 'main', true); this.changed(); return this.status() }
  resume() { this.runtime.remove('catalog-paused', 'main'); return this.start() }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.task) return this.task
    const claimed = this.runtime.transaction(() => {
      const lease = this.runtime.get<Lease>('catalog-lease', 'main')
      if (lease && alive(lease.pid)) return false
      this.runtime.put('catalog-lease', 'main', { owner: this.owner, pid: process.pid }); return true
    })
    if (!claimed) return Promise.resolve()
    clearTimeout(this.timer)
    this.abort = new AbortController()
    const generation = this.runtime.get('catalog-generation', 'main')
    this.backlog = false
    this.task = this.scan(this.abort.signal).catch(error => {
      if (!this.abort?.signal.aborted) this.runtime.put('catalog-status', 'main', { ...this.status(), failed: this.status().failed + 1, error: String(error.message).slice(0, 300) })
    }).finally(() => {
      if (this.runtime.get<Lease>('catalog-lease', 'main')?.owner === this.owner) this.runtime.remove('catalog-lease', 'main')
      this.task = undefined; this.abort = undefined; this.schedule(this.backlog || generation !== this.runtime.get('catalog-generation', 'main') ? 1000 : undefined)
    })
    return this.task
  }
  private async scan(signal: AbortSignal) {
    const state = initial(), generation = this.runtime.get<string>('catalog-generation', 'main')
    const interrupted = () => signal.aborted || generation !== this.runtime.get('catalog-generation', 'main') || !!this.runtime.get('catalog-paused', 'main')
    const timer = setInterval(() => { if (interrupted()) this.abort?.abort() }, 250); timer.unref()
    const save = () => this.runtime.put('catalog-status', 'main', { ...state, running: true })
    const budget = Math.max(1, this.options.batchBudget ?? 64)
    const selection = this.runtime.get<HistoryModelSettings>('catalog-model-settings', 'main') ?? undefined
    type Work = { session: HistorySession; own?: string; blocked: () => boolean; parts: NativePart[]; changed: NativePart[]; offset: number }
    const fail = (session: HistorySession, error: unknown) => {
      state.failed++; state.pending--; state.error = (error as Error).message.slice(0, 300)
      this.store.markIndex(session.id, -1, 'failed', 'CATALOG_FAILED'); save()
    }
    const finish = (work: Work) => {
      this.finishProjection(work.session, work.parts)
      this.store.markIndex(work.session.id, work.parts.length, 'ready'); state.indexed++; state.pending--; save()
    }
    save()
    try {
      if (interrupted()) return
      const sessions = await this.options.source.list(signal), gateways = this.gateways(), owned = this.owned()
      signal.throwIfAborted()
      this.runtime.put('catalog-live-sessions', 'main', sessions.map(s => s.id))
      const candidates = sessions.filter(s => !gateways.has(s.id))
      for (const session of candidates) this.runtime.put('catalog-session', session.id, session)
      state.pending = candidates.length
      const blocked = (s: HistorySession) => interrupted() || !owned.has(s.id) && (this.permission() !== 'granted' || this.excluded(s))
      const ready = (s: HistorySession) => this.runtime.get<number>('catalog-updated', s.id) === s.updatedAt && this.store.indexState(s.id)?.status === 'ready'
      const queue = candidates.filter(s => {
        if (blocked(s)) { if (this.excluded(s)) state.excluded++; state.pending--; return false }
        return !s.busy
      })
      let cursor = 0
      const active: Work[] = []
      while (!interrupted() && (cursor < queue.length || active.length)) {
        const remaining = budget - state.batches
        if (remaining <= 0) {
          // Busy, failed, unchanged and excluded chats do not trigger a tight retry loop.
          this.backlog = active.some(w => !w.blocked()) || queue.slice(cursor).some(s => !blocked(s) && !ready(s))
          break
        }
        const width = remaining >= 3 ? 2 : 1 // Reserve one request for concurrent proposal reconciliation.
        while (!interrupted() && active.length < width && cursor < queue.length) {
          const session = queue[cursor++], own = owned.get(session.id)
          if (blocked(session)) continue
          state.scanned++; state.currentTitle = session.title; save()
          if (ready(session)) { state.indexed++; state.pending--; continue }
          try {
            const conversation = await this.options.source.read(session.id, signal)
            if (blocked(session)) continue
            const parts = this.nativeParts(conversation)
            const changed = parts.filter(p => this.store.dismissedTurn(session.id, p.seq) !== p.fingerprint && this.store.indexedTurn(session.id, p.seq)?.fingerprint !== p.fingerprint)
            const work: Work = { session, own, parts, changed, offset: 0, blocked: () => blocked(session) }
            if (changed.length) active.push(work); else finish(work)
          } catch (error) { if (!blocked(session)) fail(session, error) }
        }
        if (interrupted()) break
        const wave = active.slice(0, width).map(work => {
          const batch: NativePart[] = []
          let characters = 0
          while (work.offset < work.changed.length && batch.length < CATALOG_MAX_TURNS) {
            const part = work.changed[work.offset]
            if (batch.length && characters + part.text.length > 9600) break
            batch.push(part); characters += part.text.length; work.offset++
          }
          const input = this.classificationInput(work.session, batch, work.own)
          state.batches++; save()
          // Capture rejection immediately; the other result may commit before this one is awaited.
          const result = Promise.resolve().then(() => this.options.model.classify(input, signal, selection))
            .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
          return { work, batch, input, result }
        })
        const fresh: { id: string; title: string; summary: string; lastState: string; cwd?: string; sourceTitle: string; excerpts: string[] }[] = []
        for (const job of wave) {
          const { work, batch, input } = job
          const remove = () => { const i = active.indexOf(work); if (i >= 0) active.splice(i, 1) }
          const outcome = await job.result
          if (work.blocked()) { remove(); continue }
          try {
            if (!outcome.ok) throw outcome.error
            let topics = validateCatalog(outcome.value, batch, input.contexts.map(c => c.id), input.groups.map(g => g.id), work.own, id => this.store.lookupContext(id))
            const resolveOwnership = (rows: typeof topics) => rows.flatMap(topic => {
              const buckets = new Map<string | null, number[]>()
              for (const seq of topic.turns) {
                const id = topic.contextId ?? this.store.indexedTurn(work.session.id, seq)?.contextId ?? null
                buckets.set(id, [...buckets.get(id) ?? [], seq])
              }
              return [...buckets].map(([contextId, turns]) => ({ ...topic, contextId, turns }))
            })
            topics = resolveOwnership(topics)
            const proposals = topics.flatMap((t, proposal) => t.contextId ? [] : [{
              proposal, title: t.title, summary: t.summary, lastState: t.lastState, entities: t.entities, keywords: t.keywords,
              sourceTitle: work.session.title, cwd: work.session.cwd,
              excerpts: batch.filter(p => t.turns.includes(p.seq)).slice(0, 3).map(p => p.text.slice(0, 240)),
            }])
            const currentFresh = fresh.filter(c => this.store.lookupContext(c.id) && !this.store.unreachable().has(c.id))
            if (proposals.length && currentFresh.length) {
              if (state.batches >= budget) throw Error('CATALOG_RECONCILE_BUDGET')
              state.batches++; save()
              if (this.options.model.reconcile) {
                const result = await this.options.model.reconcile({ proposals, contexts: currentFresh }, signal, selection)
                if (work.blocked()) { remove(); continue }
                const matches = validateCatalogMatches(result, proposals.map(p => p.proposal), currentFresh.map(c => c.id))
                topics = topics.map((t, i) => matches.get(i) ? { ...t, contextId: matches.get(i)!, metadataPatch: {} } : t)
              } else {
                // Compatibility with older classifier implementations: reclassify against the fresh catalog.
                const latest = this.classificationInput(work.session, batch, work.own)
                latest.contexts = [...currentFresh, ...latest.contexts.filter(c => !currentFresh.some(f => f.id === c.id))]
                const result = await this.options.model.classify(latest, signal, selection)
                if (work.blocked()) { remove(); continue }
                topics = resolveOwnership(validateCatalog(result, batch, latest.contexts.map(c => c.id), latest.groups.map(g => g.id), work.own, id => this.store.lookupContext(id)))
              }
            }
            if (work.blocked()) { remove(); continue }
            // Deleting a topic during an in-flight request must not resurrect it.
            const unreachable = this.store.unreachable()
            if (batch.some(p => this.store.dismissedTurn(work.session.id, p.seq) === p.fingerprint) ||
              topics.some(t => t.contextId && (!this.store.lookupContext(t.contextId) || unreachable.has(t.contextId)))) throw Error('CATALOG_CONTEXT_CHANGED')
            this.store.importTopics(work.session.id, work.session.cwd, batch, topics)
            this.projectMessages(work.session, batch)
            for (const topic of topics) if (!topic.contextId) {
              const id = this.store.indexedTurn(work.session.id, topic.turns[0])!.contextId
              const stored = this.store.lookupContext(id)!
              fresh.push({ id, title: stored.title, summary: stored.summary.slice(0, 240), lastState: stored.lastState.slice(0, 120),
                cwd: work.session.cwd, sourceTitle: work.session.title,
                excerpts: batch.filter(p => topic.turns.includes(p.seq)).slice(0, 3).map(p => p.text.slice(0, 240)) })
            }
            if (work.offset === work.changed.length) { finish(work); remove() }
            save()
          } catch (error) { remove(); if (!work.blocked()) fail(work.session, error) }
        }
      }
      this.reconcile(); state.currentTitle = undefined; state.lastCompletedAt = Date.now(); save()
    } finally { clearInterval(timer) }
  }
  private nativeParts(conversation: HistoryConversation): NativePart[] {
    // Stable IDs survive pagination and rollbacks; numeric keys satisfy DSH's original range/index schema.
    return conversation.turns.filter(t => t.status !== 'inProgress').flatMap((turn, position) => {
      const messages = turn.items.flatMap<{ id: string; role: 'user' | 'assistant'; text: string }>(item => item.type === 'userMessage'
        ? [{ id: item.id, role: 'user' as const, text: (item.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('\n') }]
        : item.type === 'agentMessage' ? [{ id: item.id, role: 'assistant' as const, text: item.text ?? '' }] : [])
        .filter(m => m.text.trim()).map(m => ({ ...m, text: redactRoutingText(m.text).slice(0, 100000) }))
      if (!messages.some(m => m.role === 'user')) return []
      const seq = parseInt(hash(turn.id).slice(0, 12), 16)
      const text = messages.filter(m => m.role === 'user').map(m => m.text.slice(0, 500)).join('\n') + '\n回答摘录：' + messages.filter(m => m.role === 'assistant').slice(-2).map(m => m.text.slice(0, 350)).join('\n')
      return [{ seq, endSeq: seq, text, fingerprint: hash(messages), turnId: turn.id, position, messages }]
    })
  }
  private classificationInput(session: HistorySession, batch: NativePart[], own?: string) {
    const known = new Set(batch.flatMap(p => this.store.indexedTurn(session.id, p.seq)?.contextId ?? []))
    if (own) known.add(own)
    const contexts = this.store.catalogContexts([...known], session.cwd)
      .map(c => ({ id: c.id, title: c.title, summary: c.summary.slice(0, 240), lastState: c.lastState.slice(0, 120) }))
    return { title: session.title, ownedContextId: own ?? null, compactionSummaries: [],
      turns: batch.map(p => ({ seq: p.seq, text: p.text, contextId: this.store.indexedTurn(session.id, p.seq)?.contextId ?? null })),
      contexts, groups: this.store.catalogGroups() }
  }
  private finishProjection(session: HistorySession, parts: NativePart[]) {
    // Recover an interrupted cross-database commit, writing only missing/stale projections.
    this.runtime.transaction(() => {
      const present = new Set<string>(), refs = new Map(this.runtime.nativeMessageRefs(session.id).map(m => [m.id, m]))
      const missing = new Set<NativePart>()
      for (const part of parts) {
        const entry = this.store.indexedTurn(session.id, part.seq)
        if (!entry || this.store.dismissedTurn(session.id, part.seq) === part.fingerprint) continue
        for (const m of part.messages) {
          const id = 'native-' + hash([session.id, part.turnId, m.id]); present.add(id)
          const ref = refs.get(id)
          if (!ref || ref.fingerprint !== part.fingerprint || ref.topicId !== entry.contextId) missing.add(part)
        }
      }
      for (const id of refs.keys()) if (!present.has(id)) this.runtime.remove('message', id)
      this.projectMessages(session, [...missing], false)
      this.runtime.put('catalog-updated', session.id, session.updatedAt)
    })
  }
  private projectMessages(session: HistorySession, batch: NativePart[], transaction = true) {
    const write = () => {
      for (const part of batch) {
        const entry = this.store.indexedTurn(session.id, part.seq)
        if (!entry || this.store.dismissedTurn(session.id, part.seq) === part.fingerprint) continue
        for (const m of part.messages) {
          const id = 'native-' + hash([session.id, part.turnId, m.id])
          this.runtime.put('message', id, { ...m, id, topicId: entry.contextId, source: 'import', hostThreadId: session.id, hostTurnId: part.turnId,
            at: session.updatedAt * 1000 + part.position, nativeHistory: true, historyFingerprint: part.fingerprint })
        }
      }
    }
    if (transaction) this.runtime.transaction(write); else write()
  }
  messageAllowed(message: { nativeHistory?: boolean; hostThreadId?: string }) {
    if (!message.nativeHistory || !message.hostThreadId) return true
    const live = this.runtime.get<string[]>('catalog-live-sessions', 'main')
    if (live && !live.includes(message.hostThreadId)) return false
    if (this.owned().has(message.hostThreadId)) return true
    const session = this.runtime.get<HistorySession>('catalog-session', message.hostThreadId)
    return !!session && !this.excluded(session)
  }
  private reconcile() {
    const hidden = this.store.hiddenReasons(), own = this.owned(), live = new Set(this.runtime.get<string[]>('catalog-live-sessions', 'main') ?? [])
    for (const topic of this.store.contexts()) {
      const sources = this.store.sources(topic.id).filter(id => this.runtime.get('catalog-session', id))
      if (!sources.length) continue
      const excluded = sources.every(id => !own.has(id) && this.excluded(this.runtime.get<HistorySession>('catalog-session', id)!))
      if (excluded) hidden.set(topic.id, 'excluded')
      else if (sources.every(id => !live.has(id)) && !own.has(this.runtime.get<any>('binding', topic.id)?.threadId)) hidden.set(topic.id, 'orphaned')
      else if (!this.runtime.get('excluded', topic.id) && ['excluded','orphaned'].includes(hidden.get(topic.id) ?? '')) hidden.delete(topic.id)
    }
    this.store.replaceHidden([...hidden].map(([id, reason]) => ({ id, reason })))
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.abort?.abort(); await this.task
    await Promise.allSettled([this.options.source.close(), this.options.model.close()])
  }
}
