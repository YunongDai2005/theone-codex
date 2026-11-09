import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './sqlite.ts'
import { randomUUID } from 'node:crypto'
import { uniqueSources, type LearningSource } from './learning-journal.ts'

/** Plugin input protocol, NOT additional fields invented on DSH's user source. */
export interface BindingInput { replyTo?: string; pendingResponse?: string; steeringOf?: string }
export interface BindingReference {
  id: string
  sessionId: string
  topicId: string
  kind: 'reply' | 'question' | 'approval'
  source: 'foreground' | 'background' | 'inferred'
  sources: LearningSource[]
  request?: { callId?: string; questionIds?: string[] }
  temporary?: TemporaryReturn
}
export interface SteeringOwner { inputId: string; topicId: string; sources: LearningSource[] }
export interface BindingResolution {
  status: 'none' | 'applied' | 'rejected'
  kind?: 'reply' | 'question' | 'approval' | 'steering'
  topicId?: string
  refs?: string[]
  sources?: LearningSource[]
  reason?: string
}
export interface TemporaryReturn { returnTopicId?: string; sources: LearningSource[] }
/** An inference from server observations, never an explicit reply or an approval grant. */
export interface ContinuationResolution {
  status: 'none' | 'applied' | 'conflict'
  kind?: 'pending' | 'foreground' | 'temporary-return'
  topicId?: string
  refs?: string[]
  sources?: LearningSource[]
}
export interface RoutingAttention {
  foreground?: { messageId: string; topicId: string; returnTopicId?: string }
  background: { messageId: string; topicId: string }[]
  pending?: { id: string; topicId: string; kind: 'question' | 'approval' }[]
  pendingOverflow?: boolean
  /** Receipt provenance only; buildPayload never sends these sources. */
  sources?: LearningSource[]
}

/** Server-owned provenance, separate from optional shadow observations. No text or grants.
 * Pending requests expire on runtime restart: an old UI answer must never revive a closed wait.
 * Registration is a trusted in-process producer seam; HTTP clients can only reference records.
 */
export class RoutingBindings {
  private readonly db: DatabaseSync
  private readonly runtime = randomUUID()
  constructor(path: string, private gateway: string, private valid: (sources: LearningSource[]) => boolean) {
    this.db = openDatabase(path, 100)
    this.db.exec('CREATE TABLE IF NOT EXISTS routing_refs (' +
      'n INTEGER PRIMARY KEY, gateway TEXT, id TEXT, topic TEXT, kind TEXT, origin TEXT, value TEXT, runtime TEXT, closed INTEGER DEFAULT 0,' +
      'UNIQUE(gateway,id,topic)); CREATE INDEX IF NOT EXISTS routing_refs_recent ON routing_refs(gateway,origin,n);' +
      'CREATE INDEX IF NOT EXISTS routing_refs_pending ON routing_refs(gateway,runtime,origin,closed,n);' +
      'CREATE TABLE IF NOT EXISTS routing_inputs (gateway TEXT, session TEXT, message TEXT, value TEXT, PRIMARY KEY(gateway,session,message));')
  }
  close(): void { this.db.close() }
  record(reference: BindingReference): void {
    this.db.prepare('INSERT OR IGNORE INTO routing_refs(gateway,id,topic,kind,origin,value,runtime) VALUES (?,?,?,?,?,?,?)')
      .run(this.gateway, reference.id, reference.topicId, reference.kind, reference.source, JSON.stringify(reference),
        reference.kind === 'reply' ? null : this.runtime)
  }
  closeReference(id: string): void {
    this.db.prepare('UPDATE routing_refs SET closed=1 WHERE gateway=? AND id=?').run(this.gateway, id)
  }
  rememberInput(session: string, message: string, input: BindingInput): void {
    this.db.prepare('INSERT OR IGNORE INTO routing_inputs VALUES (?,?,?,?)').run(this.gateway, session, message, JSON.stringify(input))
  }
  input(session: string, message: string): BindingInput {
    const row = this.db.prepare('SELECT value FROM routing_inputs WHERE gateway=? AND session=? AND message=?').get(this.gateway, session, message)
    return row ? JSON.parse(String(row.value)) : {}
  }
  resolve(input: BindingInput, topics: ReadonlySet<string>, steering?: SteeringOwner): BindingResolution {
    const refs: string[] = [], owners: { kind: NonNullable<BindingResolution['kind']>; topicId: string; sources: LearningSource[] }[] = []
    const rejected = (reason: string): BindingResolution => ({ status: 'rejected', refs, reason })
    for (const [key, id] of Object.entries(input)) {
      refs.push(id)
      if (key === 'steeringOf') {
        if (!steering || steering.inputId !== id || !topics.has(steering.topicId) || !this.valid(steering.sources)) return rejected('stale-steering')
        owners.push({ ...steering, kind: 'steering' })
        continue
      }
      const rows = this.db.prepare('SELECT value,runtime,closed FROM routing_refs WHERE gateway=? AND id=?').all(this.gateway, id)
      if (rows.length !== 1) return rejected(rows.length ? 'conflicting-owners' : 'unknown-reference')
      const row = rows[0], ref: BindingReference = JSON.parse(String(row.value))
      if (row.closed || row.runtime && row.runtime !== this.runtime) return rejected('expired-reference')
      if (ref.source !== 'foreground') return rejected('unreliable-source')
      if (key === 'replyTo' ? ref.kind !== 'reply' : key !== 'pendingResponse' || ref.kind === 'reply') return rejected('reference-kind')
      if (!topics.has(ref.topicId) || !this.valid(ref.sources)) return rejected('invalid-target')
      owners.push(ref)
    }
    if (!owners.length) return { status: 'none' }
    if (new Set(owners.map(owner => owner.topicId)).size !== 1) return rejected('conflicting-owners')
    return { status: 'applied', kind: owners.at(-1)!.kind, topicId: owners[0].topicId, refs,
      sources: uniqueSources(owners.flatMap(owner => owner.sources)) }
  }
  /** Bounded reads; validity always uses LearningJournal's existing stage cache. */
  private observations(topics: ReadonlySet<string>) {
    const valid = (ref: BindingReference) => topics.has(ref.topicId) && this.valid(ref.sources)
    const latest = (origin: 'foreground' | 'background', limit: number) =>
      this.db.prepare('SELECT value FROM routing_refs r WHERE gateway=? AND origin=? AND kind=? AND closed=0 ' +
        'AND (SELECT COUNT(*) FROM routing_refs d WHERE d.gateway=r.gateway AND d.id=r.id)=1 ORDER BY n DESC LIMIT 32')
        .all(this.gateway, origin, 'reply').map(row => JSON.parse(String(row.value)) as BindingReference).filter(valid).slice(0, limit)
    // Read one sentinel beyond the cap. Truncation must never look like a unique live wait.
    const rows = this.db.prepare('SELECT value FROM routing_refs WHERE gateway=? AND origin=? AND kind!=? AND closed=0 AND runtime=? ORDER BY n DESC LIMIT 33')
      .all(this.gateway, 'foreground', 'reply', this.runtime)
    const pending = rows.slice(0, 32).map(row => JSON.parse(String(row.value)) as BindingReference).filter(valid)
    return { foreground: latest('foreground', 1)[0], background: latest('background', 3), pending, overflow: rows.length > 32 }
  }
  temporaryReturn(topics: ReadonlySet<string>, currentId?: string): TemporaryReturn {
    const { foreground } = this.observations(topics)
    const sources = foreground && foreground.topicId === currentId ? foreground.sources
      : foreground?.temporary && foreground.temporary.returnTopicId === currentId ? foreground.temporary.sources : []
    return { ...(currentId && topics.has(currentId) ? { returnTopicId: currentId } : {}), sources: this.valid(sources ?? []) ? sources ?? [] : [] }
  }
  continuation(topics: ReadonlySet<string>, currentId: string | undefined, resume: boolean): ContinuationResolution {
    const { foreground, pending, overflow } = this.observations(topics)
    const returning = resume && !!currentId && foreground?.temporary && foreground.temporary.returnTopicId === currentId && topics.has(currentId)
      && this.valid(foreground.temporary.sources)
    if (resume && foreground?.temporary?.returnTopicId && !returning) return { status: 'conflict' }
    const frontId = returning ? currentId : foreground?.topicId
    const frontSources = returning ? foreground!.temporary!.sources : foreground?.sources ?? []
    if (overflow || pending.length > 1 || pending.length && (!resume || frontId && frontId !== pending[0].topicId))
      return { status: 'conflict' }
    const owner = pending[0]
    if (owner) return { status: 'applied', kind: 'pending', topicId: owner.topicId,
      refs: [owner.id, ...(foreground ? [foreground.id] : [])], sources: uniqueSources([...owner.sources, ...frontSources]) }
    if (frontId && (frontId !== currentId || returning)) return { status: 'applied', kind: returning ? 'temporary-return' : 'foreground',
      topicId: frontId, refs: [foreground!.id], sources: frontSources }
    return { status: 'none' }
  }
  attention(topics: ReadonlySet<string>): RoutingAttention | undefined {
    const { foreground, background, pending, overflow } = this.observations(topics)
    const brief = (ref: BindingReference) => ({ messageId: ref.id, topicId: ref.topicId })
    const temporary = foreground?.temporary
    const returnTopicId = temporary?.returnTopicId && topics.has(temporary.returnTopicId) && this.valid(temporary.sources) ? temporary.returnTopicId : undefined
    return foreground || background.length || pending.length || overflow ? {
      ...(foreground ? { foreground: { ...brief(foreground), ...(returnTopicId ? { returnTopicId } : {}) } } : {}),
      background: background.map(brief),
      ...(pending.length ? { pending: pending.slice(0, 8).map(ref => ({ id: ref.id, topicId: ref.topicId, kind: ref.kind as 'question' | 'approval' })) } : {}),
      ...(overflow || pending.length > 8 ? { pendingOverflow: true } : {}),
      sources: uniqueSources([...foreground?.sources ?? [], ...(returnTopicId ? temporary!.sources : []), ...background.flatMap(ref => ref.sources), ...pending.flatMap(ref => ref.sources)]),
    } : undefined
  }
  references(topics: ReadonlySet<string>): BindingReference[] {
    return this.db.prepare('SELECT value FROM routing_refs WHERE gateway=? ORDER BY n DESC LIMIT 64').all(this.gateway)
      .map(row => JSON.parse(String(row.value)) as BindingReference)
      .filter(ref => this.resolve(ref.kind === 'reply' ? { replyTo: ref.id } : { pendingResponse: ref.id }, topics).status === 'applied')
  }
}

export function parseBindingInput(value: unknown): BindingInput {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid binding')
  const input: BindingInput = {}
  for (const [key, id] of Object.entries(value)) {
    if (!['replyTo', 'pendingResponse', 'steeringOf'].includes(key) || typeof id !== 'string' || !id.trim() || id.length > 300)
      throw new Error('Invalid binding reference')
    input[key as keyof BindingInput] = id
  }
  return input
}
