import { DatabaseSync, StatementSync } from 'node:sqlite'

/** Ownership is a revisable inference, never a confirmation inferred from silence. */
export interface LearningSource { messageId: string; contextId: string; revision: number }
export type LearningStage = 'proposed' | 'inferred' | 'confirmed' | 'excluded'
export const uniqueSources = (sources: readonly LearningSource[]): LearningSource[] =>
  [...new Map(sources.map(source => [JSON.stringify(source), source])).values()]

/** A small event journal for local, reversible projections. It never replays a Worker or a tool. */
export class LearningJournal {
  replaying = false
  private current: LearningSource[] = []
  // Prepared once: validity checks run for every turn of every message.
  private statements = new Map<string, StatementSync>()
  // The same few route stages are read over and over, so they are kept in memory. Our own writes and rolled-back
  // savepoints clear the copy (forget); a commit from another connection changes data_version, checked once per
  // event-loop turn so one synchronous pass reads one consistent picture.
  private stages = new Map<string, { revision: number; stage: LearningStage } | null>()
  private version: unknown
  private checked = false
  constructor(private db: DatabaseSync, private snapshot: (stream: string) => unknown,
    private restore: (stream: string, snapshot: unknown) => void,
    private execute: (kind: string, args: unknown[]) => unknown) {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_routes (
      message_id TEXT NOT NULL, context_id TEXT NOT NULL, revision INTEGER NOT NULL, stage TEXT NOT NULL,
      PRIMARY KEY(message_id,context_id));
      CREATE TABLE IF NOT EXISTS learning_bases (stream TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_events (id INTEGER PRIMARY KEY, stream TEXT NOT NULL, kind TEXT NOT NULL,
        args TEXT NOT NULL, sources TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS learning_events_active ON learning_events(active,stream);
      CREATE TABLE IF NOT EXISTS learning_turns (session_id TEXT NOT NULL, input_id TEXT NOT NULL, message_id TEXT NOT NULL,
        context_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, revision INTEGER NOT NULL, parents TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY(session_id,input_id));
      CREATE INDEX IF NOT EXISTS learning_turns_message ON learning_turns(message_id);
      CREATE TABLE IF NOT EXISTS learning_fact_aliases (fact_id TEXT NOT NULL, alias TEXT NOT NULL, sources TEXT NOT NULL,
        PRIMARY KEY(fact_id,alias,sources));
      CREATE TABLE IF NOT EXISTS learning_fact_versions (fact_id TEXT NOT NULL, version INTEGER NOT NULL,
        sources TEXT NOT NULL, aliases TEXT NOT NULL, intended TEXT NOT NULL DEFAULT 'proposed', invalid INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(fact_id,version));`)
  }
  private sql(query: string): StatementSync {
    let statement = this.statements.get(query)
    if (!statement) this.statements.set(query, statement = this.db.prepare(query))
    return statement
  }
  source(messageId: string, contextId: string): LearningSource {
    if (this.sql("INSERT OR IGNORE INTO learning_routes VALUES (?,?,0,'proposed')").run(messageId, contextId).changes) this.forget()
    const row = this.sql('SELECT revision FROM learning_routes WHERE message_id=? AND context_id=?').get(messageId, contextId)!
    return { messageId, contextId, revision: Number(row.revision) }
  }
  forget(): void { this.stages.clear() }
  private fresh(): void {
    if (this.checked) return
    this.checked = true
    setImmediate(() => { this.checked = false })
    const version = this.sql('PRAGMA data_version').get()?.data_version
    if (version !== this.version) { this.stages.clear(); this.version = version }
  }
  stage(source: LearningSource): LearningStage | undefined {
    const key = `${source.messageId} ${source.contextId}`
    let row = this.stages.get(key)
    if (row === undefined) {
      const found = this.sql('SELECT revision,stage FROM learning_routes WHERE message_id=? AND context_id=?').get(source.messageId, source.contextId)
      this.stages.set(key, row = found ? { revision: Number(found.revision), stage: found.stage as LearningStage } : null)
    }
    return row && row.revision === source.revision ? row.stage : undefined
  }
  valid(sources: readonly LearningSource[]): boolean { this.fresh(); return sources.every(source => { const stage = this.stage(source); return stage && stage !== 'excluded' }) }
  settle(messageId: string, contextId: string, confirmed = false): void {
    this.source(messageId, contextId)
    this.sql(`UPDATE learning_routes SET stage=? WHERE message_id=? AND context_id=? AND stage != 'excluded'
      AND (stage != 'confirmed' OR ?='confirmed')`).run(confirmed ? 'confirmed' : 'inferred', messageId, contextId, confirmed ? 'confirmed' : 'inferred')
    this.forget()
    // Normal completion examines only pending contributions, not the lifetime history.
    const streams = new Set<string>()
    for (const row of this.sql('SELECT id,stream,sources FROM learning_events WHERE active=2').all()) {
      const sources = JSON.parse(String(row.sources)) as LearningSource[]
      if (!this.valid(sources) || sources.some(source => this.stage(source) === 'proposed')) continue
      this.sql('UPDATE learning_events SET active=1 WHERE id=?').run(Number(row.id))
      streams.add(String(row.stream))
    }
    this.project(streams)
  }
  move(messageId: string, contextId: string): void {
    this.sql("UPDATE learning_routes SET stage='excluded',revision=revision+1 WHERE message_id=? AND context_id!=? AND stage!='excluded'").run(messageId, contextId)
    this.forget()
    this.source(messageId, contextId)
    this.sql("UPDATE learning_routes SET stage='confirmed' WHERE message_id=? AND context_id=?").run(messageId, contextId)
    this.forget()
    this.rebuild()
  }
  bind(sessionId: string, inputId: string, messageId: string, contextId: string, startSeq: number, parents: LearningSource[] = []): void {
    const source = this.source(messageId, contextId)
    this.sql('INSERT OR IGNORE INTO learning_turns VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, inputId, messageId, contextId, startSeq, Number.MAX_SAFE_INTEGER, source.revision, JSON.stringify(parents))
  }
  depend(sessionId: string, messageId: string, sources: LearningSource[]): void {
    for (const row of this.sql('SELECT input_id,parents FROM learning_turns WHERE session_id=? AND message_id=?').all(sessionId, messageId))
      this.sql('UPDATE learning_turns SET parents=? WHERE session_id=? AND input_id=?')
        .run(JSON.stringify(uniqueSources([...JSON.parse(String(row.parents)), ...sources])), sessionId, String(row.input_id))
  }
  excludedMessage(messageId: string): boolean {
    return this.sql('SELECT context_id,revision,parents FROM learning_turns WHERE message_id=?').all(messageId).some(row =>
      !this.valid([{ messageId, contextId: String(row.context_id), revision: Number(row.revision) }, ...JSON.parse(String(row.parents))]))
  }
  end(sessionId: string, inputId: string, endSeq: number): void {
    this.sql('UPDATE learning_turns SET end_seq=? WHERE session_id=? AND input_id=?').run(endSeq, sessionId, inputId)
  }
  turns(sessionId: string): { inputId: string; sources: LearningSource[]; source: LearningSource; startSeq: number; endSeq: number }[] {
    return this.sql('SELECT * FROM learning_turns WHERE session_id=? ORDER BY start_seq').all(sessionId).map(row => ({
      sources: [{ messageId: String(row.message_id), contextId: String(row.context_id), revision: Number(row.revision) }, ...JSON.parse(String(row.parents))],
      inputId: String(row.input_id), source: { messageId: String(row.message_id), contextId: String(row.context_id), revision: Number(row.revision) },
      startSeq: Number(row.start_seq), endSeq: Number(row.end_seq) }))
  }
  sources(sessionId: string, throughSeq: number, fromSeq = 0): LearningSource[] {
    return uniqueSources(this.turns(sessionId).filter(turn => turn.startSeq <= throughSeq && turn.endSeq >= fromSeq).flatMap(turn => turn.sources))
  }
  using<T>(sources: readonly LearningSource[], work: () => T): T {
    const before = this.current
    this.current = uniqueSources([...before, ...sources])
    try { return work() } finally { this.current = before }
  }
  get activeSources(): LearningSource[] { return this.current }
  dependencies(stream: string): LearningSource[] {
    return uniqueSources(this.sql('SELECT sources FROM learning_events WHERE stream=? AND active=1').all(stream)
      .flatMap(row => JSON.parse(String(row.sources)) as LearningSource[]))
  }
  record<T>(stream: string, kind: string, args: unknown[], work: () => T, refused: T): T {
    if (this.replaying) return work()
    if (!this.valid(this.current)) return refused
    this.db.exec('SAVEPOINT learning_write')
    try {
      this.sql('INSERT OR IGNORE INTO learning_bases VALUES (?,?)').run(stream, JSON.stringify(this.snapshot(stream)))
      const pending = kind === 'learnLink' && this.current.some(source => this.stage(source) === 'proposed')
      const result = pending ? refused : work()
      this.sql('INSERT INTO learning_events(stream,kind,args,sources,active) VALUES (?,?,?,?,?)')
        .run(stream, kind, JSON.stringify(args), JSON.stringify(this.current), pending ? 2 : 1)
      this.db.exec('RELEASE learning_write')
      return result
    } catch (error) { this.db.exec('ROLLBACK TO learning_write; RELEASE learning_write'); this.forget(); throw error }
  }
  /** Invalidation and replay share the caller's correction transaction. */
  rebuild(streams: readonly string[] = []): void {
    const affected = new Set(streams)
    for (const row of this.sql('SELECT id,stream,sources,active FROM learning_events WHERE active!=0').all()) {
      const sources = JSON.parse(String(row.sources)) as LearningSource[]
      if (!this.valid(sources)) {
        this.sql('UPDATE learning_events SET active=0 WHERE id=?').run(Number(row.id))
      } else if (row.active === 2 && sources.every(source => this.stage(source) !== 'proposed')) {
        this.sql('UPDATE learning_events SET active=1 WHERE id=?').run(Number(row.id))
      } else continue
      affected.add(String(row.stream))
    }
    this.project(affected)
  }
  private project(streams: Iterable<string>): void {
    this.replaying = true
    try {
      for (const stream of streams) {
        const base = this.sql('SELECT snapshot FROM learning_bases WHERE stream=?').get(stream)
        if (!base) continue
        this.restore(stream, JSON.parse(String(base.snapshot)))
        for (const row of this.sql('SELECT kind,args FROM learning_events WHERE stream=? AND active=1 ORDER BY id').all(stream))
          this.execute(String(row.kind), JSON.parse(String(row.args)))
      }
    } finally { this.replaying = false }
  }
  audit() { return this.sql('SELECT id,stream,kind,sources,active FROM learning_events ORDER BY id').all().map(row => ({
    id: Number(row.id), stream: String(row.stream), kind: String(row.kind), sources: JSON.parse(String(row.sources)) as LearningSource[], active: row.active === 1, pending: row.active === 2 })) }
}
