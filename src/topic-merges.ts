import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeStore } from './runtime-store.ts'
import type { ContextStore } from './store.ts'
import type { MergeOperation, MergeSuggestion } from './desktop-events.ts'
import { mergeSimilarity, mergeCandidateSimilarity } from './routing-policy.ts'
import { MergeVetter, MERGE_VET_LIMITS, type MergePair, type MergeVetRecord } from './merge-vetting.ts'

const pending = (op: MergeOperation) => ['queued','executing'].includes(op.state)
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** DSH's explicit merge reservations and suggestion lifecycle, on Codex's shared runtime store. */
export class TopicMerges {
  private vetter?: MergeVetter
  private scans = new Map<string, string>()
  constructor(private runtime: RuntimeStore, private store: ContextStore, private host: {
    visible(id: string): boolean; busy(...ids: string[]): boolean; merge(source: string, target: string): void
    vettingEnabled?(gatewayId: string): boolean; idle?(): boolean; vet?(pairs: MergePair[], signal: AbortSignal): Promise<unknown>
  }) {
    if (host.vet) this.vetter = new MergeVetter(runtime, {
      idle: () => host.idle?.() ?? false,
      fingerprint: (gatewayId, pair) => host.vettingEnabled?.(gatewayId) && pair.every(id => !!this.describe(id) && host.visible(id) && !store.isPrivate(id)) &&
        !runtime.all<MergeSuggestion>('merge-suggestion').some(s => s.pair[0] === pair[0] && s.pair[1] === pair[1]) ? this.pairFingerprint(pair) : undefined,
      topics: pair => pair.map(id => { const t = this.describe(id)!; return { id, title: t.title, summary: t.summary, entities: t.entities } }),
      infer: host.vet,
      suggest: (row, verdict) => this.offer(row.gatewayId, row.pair, row.evidence, MERGE_VET_LIMITS.ttl, verdict.keepId),
    })
  }
  interrupt() { this.vetter?.interrupt() }
  tickVetting() { return this.vetter?.tick() ?? Promise.resolve() }
  close() { return this.vetter?.close() ?? Promise.resolve() }
  operations() { return this.runtime.all<MergeOperation>('merge-operation') }
  private validate(source: string, target: string) {
    if (source === target || !this.host.visible(source) || !this.host.visible(target) || ![source,target].every(id => this.store.lookupContext(id))) throw Error('TOPIC_UNAVAILABLE')
  }
  request(sourceId: string, targetId: string, requestId: string, suggestionId?: string): MergeOperation {
    const op = this.runtime.transaction(() => {
      const previous = this.operations().find(op => op.requestId === requestId)
      if (previous) {
        if (previous.sourceId !== sourceId || previous.targetId !== targetId || previous.suggestionId !== suggestionId) throw Error('REQUEST_ID_CONFLICT')
        return previous
      }
      this.validate(sourceId, targetId)
      if (this.operations().some(op => pending(op) && [op.sourceId,op.targetId].some(id => id === sourceId || id === targetId))) throw Error('MERGE_CONFLICT')
      const now = Date.now(), op: MergeOperation = { operationId: randomUUID(), requestId, sourceId, targetId, whenIdle: true,
        suggestionId, state: 'queued', createdAt: now, updatedAt: now, expiresAt: now + 300000 }
      if (suggestionId) {
        const suggestion = this.suggestion(suggestionId)
        if (!suggestion || suggestion.state !== 'pending' || !this.validSuggestion(suggestion)) throw Error('SUGGESTION_INVALID')
        this.saveSuggestion({ ...suggestion, state: 'accepted', operationId: op.operationId, sourceId, targetId })
      }
      this.change(op, 'queued'); return op
    })
    this.drain()
    return this.runtime.get<MergeOperation>('merge-operation', op.operationId)!
  }
  cancel(id: string) {
    return this.runtime.transaction(() => {
      const op = this.runtime.get<MergeOperation>('merge-operation', id)
      if (!op) throw Error('UNKNOWN_MERGE')
      if (op.state === 'cancelled') return op
      if (op.state !== 'queued') throw Error('MERGE_FINISHED')
      this.change(op, 'cancelled', 'MERGE_CANCELLED'); return op
    })
  }
  private change(op: MergeOperation, state: MergeOperation['state'], error?: string) {
    Object.assign(op, { state, updatedAt: Date.now(), error })
    if (state === 'succeeded' && op.suggestionId) this.store.recordMergePrompt(op.sourceId, op.targetId, 'merged')
    this.runtime.put('merge-operation', op.operationId, op)
    this.runtime.appendEvent({ type: 'merge.changed', ...op })
  }
  drain() {
    this.syncSuggestions()
    this.runtime.transaction(() => {
      for (const op of this.operations().filter(pending)) {
        // Recover a commit before the runtime receipt (the two SQLite files are independent).
        if (this.store.merges().some(m => m.sourceId === op.sourceId && m.targetId === op.targetId && m.at >= op.createdAt)) {
          this.runtime.put('merge', op.sourceId, { sourceId: op.sourceId, targetId: op.targetId })
          if (this.store.isPrivate(op.sourceId)) this.store.setPrivate(op.targetId, true)
          this.change(op, 'succeeded'); continue
        }
        if (Date.now() >= op.expiresAt) { this.change(op, 'expired', 'MERGE_EXPIRED'); continue }
        if (op.suggestionId && !this.validSuggestion(this.suggestion(op.suggestionId))) { this.change(op, 'failed', 'SUGGESTION_INVALID'); continue }
        if (this.host.busy(op.sourceId, op.targetId)) continue
        try { this.validate(op.sourceId, op.targetId); this.change(op, 'executing'); this.host.merge(op.sourceId, op.targetId); this.change(op, 'succeeded') }
        catch (e) { this.change(op, 'failed', e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'MERGE_FAILED') }
      }
    })
  }
  private describe(id: string) {
    const topic = this.store.lookupContext(id)
    return topic && { ...topic, names: this.store.names(id).get(id), cwd: this.store.origin(id)?.cwd }
  }
  private pairFingerprint(pair: string[]) {
    return fingerprint(pair.map(id => ({ topic: this.describe(id), private: this.store.isPrivate(id), visible: this.host.visible(id),
      group: this.store.groups().find(g => g.contextIds.includes(id))?.id })))
  }
  private validSuggestion(suggestion?: MergeSuggestion) {
    return !!suggestion && suggestion.pair.every(id => !!this.describe(id) && this.host.visible(id)) && suggestion.fingerprint === this.pairFingerprint(suggestion.pair)
  }
  suggestions(gatewayId: string) { return this.runtime.all<MergeSuggestion>('merge-suggestion').filter(s => s.gatewayId === gatewayId && s.state === 'pending' && s.expiresAt > Date.now() && this.validSuggestion(s)) }
  private suggestion(id: string) { return this.runtime.get<MergeSuggestion>('merge-suggestion', id) }
  private saveSuggestion(s: MergeSuggestion) { s.updatedAt = Date.now(); this.runtime.put('merge-suggestion', s.suggestionId, s); this.runtime.appendEvent({ type: 'suggestion.changed', suggestionId: s.suggestionId }, s.gatewayId) }
  private syncSuggestions() {
    for (const s of this.runtime.all<MergeSuggestion>('merge-suggestion')) if (s.state === 'pending') {
      if (Date.now() >= s.expiresAt) this.saveSuggestion({ ...s, state: 'expired' })
      else if (!this.validSuggestion(s)) this.saveSuggestion({ ...s, state: 'dismissed' })
    }
  }
  detect(gatewayId: string) {
    this.syncSuggestions()
    const names = this.store.names(), topics = this.store.contexts().filter(t => this.host.visible(t.id)).map(t => ({ ...t, names: names.get(t.id), cwd: this.store.origin(t.id)?.cwd, private: this.store.isPrivate(t.id) }))
    const vetted = !!this.vetter && !!this.host.vettingEnabled?.(gatewayId), signature = fingerprint([vetted, topics, this.store.groups()])
    if (this.scans.get(gatewayId) === signature) return
    this.scans.set(gatewayId, signature)
    const seen = new Set(this.runtime.all<MergeSuggestion>('merge-suggestion').map(s => fingerprint(s.pair)))
    for (const topic of topics) {
      const candidates = topics.flatMap(other => {
        const pair = [topic.id, other.id].sort() as [string,string], key = fingerprint(pair)
        if (topic.id === other.id || seen.has(key) || this.store.mergePrompt(...pair) || vetted && (topic.private || other.private)) return []
        const evidence = (vetted ? mergeCandidateSimilarity : mergeSimilarity)(topic, other)
        return evidence ? [{ pair, evidence, key }] : []
      }).sort((a,b) => b.evidence.sharedNames - a.evidence.sharedNames || b.evidence.titleSimilarity - a.evidence.titleSimilarity || a.key.localeCompare(b.key))
      for (const candidate of candidates.slice(0, vetted ? MERGE_VET_LIMITS.candidates : 1)) {
        seen.add(candidate.key)
        if (vetted) this.vetter!.enqueue(gatewayId, candidate.pair, candidate.evidence)
        else this.offer(gatewayId, candidate.pair, candidate.evidence, 300000, topic.id)
      }
    }
  }
  private offer(gatewayId: string, pair: [string,string], evidence: MergeVetRecord['evidence'], ttl: number, keepId: string) {
    const other = pair.find(id => id !== keepId)!, now = Date.now()
    const s: MergeSuggestion = { suggestionId: fingerprint(pair), gatewayId, pair,
      directions: [{ sourceId: other, targetId: keepId }, { sourceId: keepId, targetId: other }], evidence,
      fingerprint: this.pairFingerprint(pair), createdAt: now, updatedAt: now, expiresAt: now + ttl, state: 'pending' }
    this.runtime.transaction(() => { if (!this.suggestion(s.suggestionId)) this.saveSuggestion(s) })
  }
  answer(id: string, response: 'accept' | 'decline' | 'later', direction?: { sourceId: string; targetId: string }) {
    this.syncSuggestions()
    const s = this.suggestion(id)
    if (!s || ['expired','dismissed'].includes(s.state)) throw Error('SUGGESTION_INVALID')
    if (s.state === 'declined') { if (response !== 'decline') throw Error('SUGGESTION_FINISHED'); return { outcome: 'done' as const, suggestion: s } }
    const chosen = direction ?? (s.sourceId && s.targetId ? { sourceId: s.sourceId, targetId: s.targetId } : s.directions[0])
    if (response === 'accept') {
      if (!s.directions.some(d => d.sourceId === chosen.sourceId && d.targetId === chosen.targetId)) throw Error('SUGGESTION_DIRECTION_INVALID')
      const op = this.request(chosen.sourceId, chosen.targetId, 'suggestion:' + id, id)
      return { outcome: op.state === 'succeeded' ? 'merged' as const : pending(op) ? 'queued' as const : 'failed' as const, operation: op, suggestion: this.suggestion(id) }
    }
    if (s.state !== 'pending') throw Error('SUGGESTION_FINISHED')
    if (response === 'decline') { this.saveSuggestion({ ...s, state: 'declined' }); this.store.recordMergePrompt(...s.pair, 'declined') }
    return { outcome: 'done' as const, suggestion: this.suggestion(id) }
  }
}
