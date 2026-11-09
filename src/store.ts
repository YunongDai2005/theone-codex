import type { ModelSelection } from './host-types.ts'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './sqlite.ts'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { ExtractedTopic, HiddenReason, HistoryPart, TopicGroup } from './catalog-types.ts'
import type { ContextDescriptor, ContextUsage, Decision, Progress, RouteRecord, RouteView, StoredContext, SourceRange, TopicLink } from './types.ts'
import { FACT_KINDS, FACT_LIMITS, factKey, safe, type FactEvidence, type FactKind, type FactStatus, type FactView } from './facts.ts'
import { LearningJournal, uniqueSources, type LearningSource } from './learning-journal.ts'
import { mergeSettled, type Settled, type TopicCard } from './topic-memory.ts'

/** A write to a topic's facts, after its evidence was checked against the session. */
export interface FactWrite {
  factId?: string
  label: string
  kind: FactKind
  value: string
  aliases?: string[]
  status: 'confirmed' | 'proposed'
  evidence: FactEvidence
  origin: FactView['origin']
  /** The version the writer last saw; the write is refused if the fact has moved on since. */
  expectedVersion?: number
}

export type MergePromptAnswer = 'merged' | 'declined' | 'dismissed'

export type FactOutcome = 'created' | 'updated' | 'unchanged' | 'retracted' | 'rejected'
export interface FactResult {
  outcome: FactOutcome
  /** Why a write was refused: stale (the fact changed since `expectedVersion`), older-evidence,
   * keeps-confirmed (a proposal never replaces a confirmed value), unknown-fact, invalid. */
  reason?: string
  fact?: FactView
  previous?: FactView
}

/** Terms learned from corrections fade by half every 30 days unless they are confirmed again. */
export const TERM_HALF_LIFE_MS = 30 * 86400000

/** A whole session attached by hand counts as reviewed from its first event to its last. */
export const WHOLE_SESSION = { startSeq: 0, endSeq: Number.MAX_SAFE_INTEGER }

/** Tables keyed by topic that removing a topic clears. */
const PURGED_TABLES = ['topic_group_members', 'history_turns', 'context_origins', 'context_sources', 'context_source_ranges',
  'gateway_state', 'context_state_updates', 'context_summary_updates', 'topic_flags', 'compaction_digests', 'learned_terms',
  'topic_runs', 'topic_status', 'topic_names', 'topic_settled', 'topic_open', 'correction_terms']

/** What a merge did, so it can be taken apart: rows moved or added (by rowid), and the source as it was. */
interface MergeJournal {
  at: number
  moved: Record<string, number[]>
  added: Record<string, number[]>
  purged: Record<string, Record<string, unknown>[]>
  terms: { entities: string[]; keywords: string[] }
  corrected: string[]
  facts: { id: string; key: string; label: string; mergedFrom: string | null }[]
  removedDependencies: Record<string, unknown>[]
  links: { a: string; b: string; row: Record<string, unknown> | null }[]
  constraints?: { before: string | null; after: string }
  index?: { sessionId: string; row: Record<string, unknown> | null }
}

/** A topic's progress as one note: the three parts with labels in the language they were written in. */
export function progressText(progress: Progress): string {
  const english = !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(progress.goal + progress.done + progress.next)
  const labels = english ? ['Goal', 'Done', 'Next'] : ['目标', '进度', '下一步']
  return [progress.goal, progress.done, progress.next].flatMap((part, index) => part ? [`${labels[index]}${english ? ': ' : '：'}${part}`] : []).join('\n')
}

/** Stores descriptors and routing metadata. Original conversation stays in DSH. */
/** Run records a topic keeps; older ones are dropped as new ones start. */
export const RUNS_KEPT = 20

/** One message a topic worked on, and how that ended. */
export interface TopicRun {
  messageId: string
  contextId: string
  sessionId: string
  outcome: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'moved'
  startedAt: number
  endedAt?: number
}

const runOf = (row: Record<string, unknown>): TopicRun => ({ messageId: String(row.message_id), contextId: String(row.context_id),
  sessionId: String(row.session_id), outcome: String(row.outcome) as TopicRun['outcome'], startedAt: Number(row.started_at),
  ...(row.ended_at == null ? {} : { endedAt: Number(row.ended_at) }) })

export class ContextStore {
  private readonly db: DatabaseSync
  readonly learningJournal: LearningJournal

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path, 5000)
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS topic_groups (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, normalized_title TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS topic_group_members (
        context_id TEXT PRIMARY KEY REFERENCES contexts(id), group_id TEXT NOT NULL REFERENCES topic_groups(id)
      );
      CREATE INDEX IF NOT EXISTS topic_group_members_group ON topic_group_members(group_id, context_id);
      CREATE TABLE IF NOT EXISTS catalog_consent (
        id INTEGER PRIMARY KEY CHECK (id = 1), consent TEXT NOT NULL CHECK (consent IN ('granted','declined')), at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_exclusions (
        kind TEXT NOT NULL CHECK (kind IN ('session','folder')), value TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
      );
      CREATE TABLE IF NOT EXISTS history_index (
        session_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL, status TEXT NOT NULL, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS history_turns (
        session_id TEXT NOT NULL, user_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, context_id TEXT NOT NULL REFERENCES contexts(id),
        PRIMARY KEY(session_id, user_seq)
      );
      CREATE TABLE IF NOT EXISTS context_origins (
        context_id TEXT PRIMARY KEY REFERENCES contexts(id), session_id TEXT NOT NULL, cwd TEXT
      );
      CREATE TABLE IF NOT EXISTS model_binding (
        gateway_key TEXT PRIMARY KEY, selection TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_settings (
        gateway_key TEXT PRIMARY KEY, settings TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY, descriptor TEXT NOT NULL, working_session_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS context_sources (
        context_id TEXT NOT NULL REFERENCES contexts(id), session_id TEXT NOT NULL,
        PRIMARY KEY(context_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS context_source_ranges (
        context_id TEXT NOT NULL REFERENCES contexts(id), session_id TEXT NOT NULL,
        start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
        PRIMARY KEY(context_id, session_id, start_seq, end_seq)
      );
      CREATE TABLE IF NOT EXISTS gateway_state (
        gateway_key TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id)
      );
      CREATE TABLE IF NOT EXISTS context_state_updates (
        id INTEGER PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id),
        session_id TEXT NOT NULL, through_seq INTEGER NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS context_summary_updates (
        context_id TEXT NOT NULL REFERENCES contexts(id), session_id TEXT NOT NULL,
        summary_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(context_id, session_id, summary_seq)
      );
      CREATE TABLE IF NOT EXISTS routing_events (
        message_id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL, decision TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS gateway_sessions (
        gateway_key TEXT NOT NULL, gateway_id TEXT NOT NULL,
        PRIMARY KEY(gateway_key, gateway_id)
      );
      CREATE TABLE IF NOT EXISTS pinned_gateways (gateway_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS topic_links (
        a TEXT NOT NULL, b TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(a, b)
      );
      CREATE TABLE IF NOT EXISTS topic_flags (
        context_id TEXT PRIMARY KEY, private INTEGER NOT NULL DEFAULT 0, constraints TEXT, constraints_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS compaction_digests (
        context_id TEXT PRIMARY KEY, summary TEXT NOT NULL, through_seq INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS briefing_seen (
        reader TEXT NOT NULL, source TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(reader, source)
      );
      CREATE TABLE IF NOT EXISTS dismissed_turns (
        session_id TEXT NOT NULL, user_seq INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(session_id, user_seq)
      );
      CREATE TABLE IF NOT EXISTS learned_terms (
        context_id TEXT NOT NULL, term TEXT NOT NULL, weight REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(context_id, term)
      );
      CREATE TABLE IF NOT EXISTS merge_prompts (
        a TEXT NOT NULL, b TEXT NOT NULL, answer TEXT NOT NULL CHECK (answer IN ('merged', 'declined', 'dismissed')),
        at INTEGER NOT NULL, PRIMARY KEY (a, b), CHECK (a < b)
      );
      CREATE TABLE IF NOT EXISTS topic_merges (
        source_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, at INTEGER NOT NULL, journal TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS correction_terms (
        message_id TEXT NOT NULL, context_id TEXT NOT NULL, term TEXT NOT NULL, delta REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_runs (
        message_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, session_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('running', 'completed', 'failed', 'stopped', 'interrupted', 'moved')),
        started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS topic_runs_by_topic ON topic_runs(context_id, started_at);
      CREATE TABLE IF NOT EXISTS topic_status (context_id TEXT PRIMARY KEY, declared TEXT NOT NULL CHECK (declared IN ('done')), declared_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS change_links (
        gateway_id TEXT NOT NULL, seq INTEGER NOT NULL, session_id TEXT NOT NULL, source_seq INTEGER NOT NULL, turn INTEGER NOT NULL, PRIMARY KEY(gateway_id, seq)
      );
      CREATE TABLE IF NOT EXISTS dismissed_notices (id TEXT PRIMARY KEY, dismissed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_flags (name TEXT PRIMARY KEY, set_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_links (channel TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS misrouted_turns (
        message_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, session_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
        moved_to TEXT NOT NULL, request TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS misroute_effects (message_id TEXT NOT NULL, context_id TEXT NOT NULL, changes TEXT NOT NULL, PRIMARY KEY(message_id,context_id));
      CREATE TABLE IF NOT EXISTS stowed_sessions (session_id TEXT PRIMARY KEY, stowed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_names (
        context_id TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        PRIMARY KEY (context_id, name_key)
      );
      CREATE TABLE IF NOT EXISTS topic_settled (
        context_id TEXT NOT NULL, label_key TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, since INTEGER NOT NULL,
        previous TEXT, previous_since INTEGER, PRIMARY KEY (context_id, label_key)
      );
      CREATE TABLE IF NOT EXISTS topic_open (context_id TEXT PRIMARY KEY, items TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS route_details (
        message_id TEXT PRIMARY KEY, excerpt TEXT NOT NULL, receipt TEXT, corrected_to TEXT, corrected_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY, context_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'artifact')),
        current_version INTEGER NOT NULL, merged_from TEXT, deleted_at INTEGER, last_used_at INTEGER,
        UNIQUE (context_id, key)
      );
      CREATE TABLE IF NOT EXISTS fact_versions (
        fact_id TEXT NOT NULL REFERENCES facts(id), version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('confirmed', 'proposed', 'retracted')),
        value TEXT, evidence TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('worker', 'extractor')),
        created_at INTEGER NOT NULL, PRIMARY KEY (fact_id, version)
      );
      CREATE TABLE IF NOT EXISTS fact_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, fact_id TEXT NOT NULL, version INTEGER NOT NULL,
        input_id TEXT, via TEXT NOT NULL CHECK (via IN ('route', 'lookup', 'notice')), at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fact_dependencies (
        context_id TEXT NOT NULL, fact_id TEXT NOT NULL, version_seen INTEGER NOT NULL,
        first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (context_id, fact_id)
      );
      CREATE TABLE IF NOT EXISTS hidden_contexts (
        context_id TEXT PRIMARY KEY REFERENCES contexts(id), reason TEXT NOT NULL, detected_at INTEGER NOT NULL
      );
    `)
    this.learningJournal = new LearningJournal(this.db, stream => this.learningSnapshot(stream),
      (stream, snapshot) => this.restoreLearning(stream, snapshot),
      (kind, args) => {
        if (!['learnLink', 'setManualLink', 'markSeen'].includes(kind) && !this.contexts().some(topic => topic.id === args[0])) return
        return (this as unknown as Record<string, (...args: unknown[]) => unknown>)[kind](...args)
      })
  }

  settings(gatewayKey: string): { values: unknown; revision: number } | undefined {
    const row = this.db.prepare('SELECT settings, revision FROM plugin_settings WHERE gateway_key = ?').get(gatewayKey) as { settings: string; revision: number } | undefined
    if (!row) return
    let values: unknown
    try { values = JSON.parse(row.settings) } catch { /* A fresh save can repair malformed preferences. */ }
    return { values, revision: row.revision }
  }

  saveSettings(gatewayKey: string, values: unknown, revision: number): boolean {
    const result = this.db.prepare(`INSERT INTO plugin_settings(gateway_key, settings, revision)
      SELECT ?, ?, 1 WHERE ? = 0 OR EXISTS(SELECT 1 FROM plugin_settings WHERE gateway_key = ? AND revision = ?)
      ON CONFLICT(gateway_key) DO UPDATE SET settings = excluded.settings, revision = plugin_settings.revision + 1
      WHERE plugin_settings.revision = ?`).run(gatewayKey, JSON.stringify(values), revision, gatewayKey, revision, revision)
    return result.changes === 1
  }

  /** Only model identity is persisted. API credentials remain owned by DSH. */
  rememberModel(gatewayKey: string, selection: ModelSelection): void {
    if (!selection.provider || !selection.model || selection.provider === 'theone') throw new Error('Invalid backing model')
    const value = { provider: selection.provider, model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    this.db.prepare('INSERT OR REPLACE INTO model_binding VALUES (?, ?)').run(gatewayKey, JSON.stringify(value))
  }

  rememberedModel(gatewayKey: string): ModelSelection | undefined {
    const row = this.db.prepare('SELECT selection FROM model_binding WHERE gateway_key = ?').get(gatewayKey)
    return row ? JSON.parse(String(row.selection)) as ModelSelection : undefined
  }

  seed(contexts: ContextDescriptor[]): void {
    for (const context of contexts) {
      this.db.prepare('INSERT OR IGNORE INTO contexts VALUES (?, ?, ?)')
        .run(context.id, JSON.stringify(context), randomUUID())
    }
  }

  contexts(): StoredContext[] {
    return this.db.prepare('SELECT * FROM contexts ORDER BY id').all().map(row => ({
      ...JSON.parse(String(row.descriptor)) as ContextDescriptor,
      workingSessionId: String(row.working_session_id),
    }))
  }

  lookupContext(id: string): StoredContext | undefined {
    const row = this.db.prepare('SELECT descriptor, working_session_id FROM contexts WHERE id=?').get(id)
    return row ? { ...JSON.parse(String(row.descriptor)) as ContextDescriptor, workingSessionId: String(row.working_session_id) } : undefined
  }

  /** Bound decoding to the small candidate set, prioritizing prior ownership and workspace. */
  catalogContexts(known: string[], cwd?: string): StoredContext[] {
    return this.db.prepare(`SELECT c.descriptor, c.working_session_id FROM contexts c
      LEFT JOIN context_origins o ON o.context_id=c.id
      WHERE NOT EXISTS (SELECT 1 FROM hidden_contexts h WHERE h.context_id=c.id AND h.reason IN ('orphaned','excluded'))
      ORDER BY c.id IN (SELECT value FROM json_each(?)) DESC, o.cwd IS ? DESC, c.id LIMIT 24`)
      .all(JSON.stringify(known), cwd ?? null).map(row => ({ ...JSON.parse(String(row.descriptor)) as ContextDescriptor, workingSessionId: String(row.working_session_id) }))
  }

  catalogGroups(): Pick<TopicGroup, 'id' | 'title' | 'summary'>[] {
    return this.db.prepare(`SELECT id,title,summary FROM topic_groups g
      WHERE EXISTS (SELECT 1 FROM topic_group_members m WHERE m.group_id=g.id) ORDER BY title DESC LIMIT 24`)
      .all().reverse().map(row => ({ id: String(row.id), title: String(row.title), summary: String(row.summary).slice(0, 120) }))
  }

  /** Context ids, newest first. contexts() is ordered by id, and generated ids are random. */
  contextIdsByRecency(): string[] {
    return this.db.prepare('SELECT id FROM contexts ORDER BY rowid DESC').all().map(row => String(row.id))
  }

  current(gatewayKey: string): string | undefined {
    const row = this.db.prepare('SELECT context_id FROM gateway_state WHERE gateway_key = ?').get(gatewayKey)
    return row ? String(row.context_id) : undefined
  }

  /** Successful uses only: retries, failed work and clarification never heat a topic. */
  contextUsage(gatewayKey: string, now = Date.now()): ContextUsage[] {
    const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    return this.db.prepare(`SELECT COALESCE(d.corrected_to, json_extract(r.decision, '$.contextId')) AS context_id,
      COUNT(*) AS calls, SUM(r.created_at >= ?) AS recent_calls, MAX(r.created_at) AS last_used
      FROM routing_events r JOIN gateway_sessions gs ON gs.gateway_id = r.gateway_id
      LEFT JOIN route_details d ON d.message_id = r.message_id
      WHERE gs.gateway_key = ? AND r.status = 'completed'
        AND json_extract(r.decision, '$.action') != 'CLARIFY'
        AND json_extract(r.decision, '$.contextId') IS NOT NULL
      GROUP BY context_id`).all(cutoff, gatewayKey).map(row => ({
        contextId: String(row.context_id), completedCalls: Number(row.calls),
        recentCalls: Number(row.recent_calls), lastUsedAt: Date.parse(String(row.last_used).replace(' ', 'T') + 'Z'),
      }))
  }

  /** Every completed route of this entry, oldest first, to the topic it really belonged to (after corrections). */
  routeTimeline(gatewayKey: string): { contextId: string; at: number }[] {
    return this.db.prepare(`SELECT COALESCE(d.corrected_to, json_extract(r.decision, '$.contextId')) AS context_id, r.created_at
      FROM routing_events r JOIN gateway_sessions gs ON gs.gateway_id = r.gateway_id
      LEFT JOIN route_details d ON d.message_id = r.message_id
      WHERE gs.gateway_key = ? AND r.status = 'completed' AND json_extract(r.decision, '$.action') != 'CLARIFY'
      ORDER BY r.rowid`).all(gatewayKey).flatMap(row => row.context_id == null ? [] : [{
        contextId: String(row.context_id), at: Date.parse(String(row.created_at).replace(' ', 'T') + 'Z') }])
  }

  /**
   * A topic's routing card. Other names are added, never pushed out by newer ones; settled values
   * keep the value they replaced and when; what is open is replaced. The card's summary replaces a
   * placeholder summary, not a compaction summary (written from the whole session); either way
   * routing reads the current settled values and open items beside it (see routingSummary).
   */
  applyCard(contextId: string, card: TopicCard, now = Date.now()): boolean {
    return this.learningJournal.record(`topic:${contextId}`, 'applyCard', [contextId, card, now], () => this.applyCardValue(contextId, card, now), false)
  }

  private applyCardValue(contextId: string, card: TopicCard, now = Date.now()): boolean {
    this.db.exec('SAVEPOINT store_write')
    try {
      const context = this.contexts().find(item => item.id === contextId)
      if (!context) { this.db.exec('RELEASE store_write'); return false }
      const first = !this.db.prepare('SELECT 1 FROM topic_open WHERE context_id = ?').get(contextId)
      const { workingSessionId: _, ...descriptor } = context
      for (const name of card.aliases) this.db.prepare(`INSERT INTO topic_names VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(context_id, name_key) DO UPDATE SET last_at = excluded.last_at`).run(contextId, name.toLowerCase(), name, now, now)
      for (const item of mergeSettled(this.settled(contextId), card.settled, now))
        this.db.prepare(`INSERT OR REPLACE INTO topic_settled VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(contextId, item.label.toLowerCase(), item.label, item.value, item.since, item.previous ?? null, item.previousSince ?? null)
      this.db.prepare('INSERT OR REPLACE INTO topic_open VALUES (?, ?, ?)').run(contextId, JSON.stringify(card.open), now)
      const seen = new Set<string>()
      const entities = [...card.entities, ...descriptor.entities].filter(term => { const key = term.toLowerCase(); return term && !seen.has(key) && seen.add(key) }).slice(0, 48)
      const compacted = this.summaryUpdates(contextId).length > 0
      this.db.prepare('UPDATE contexts SET descriptor = ? WHERE id = ?').run(JSON.stringify({ ...descriptor, summary: compacted ? descriptor.summary : card.summary, entities }), contextId)
      this.db.exec('RELEASE store_write')
      return first
    } catch (error) { this.rollbackWrite(); throw error }
  }

  /** A route-created topic, never manually moved or already involved in a merge; use its latest main chat. */
  mergeSuggestionGateway(contextId: string): string | undefined {
    if (!this.contexts().some(topic => topic.id === contextId) || this.unreachable().has(contextId) ||
      this.hasFlag(`merge-moved:${contextId}`) || this.hasFlag(`merge-handled:${contextId}`)) return undefined
    const created = this.db.prepare("SELECT 1 FROM routing_events WHERE json_extract(decision, '$.contextId') = ? AND json_extract(decision, '$.action') = 'CREATE' LIMIT 1").get(contextId)
    if (!created) return undefined
    const row = this.db.prepare(`SELECT r.gateway_id FROM routing_events r LEFT JOIN route_details d ON d.message_id = r.message_id
      WHERE COALESCE(d.corrected_to, json_extract(r.decision, '$.contextId')) = ? ORDER BY r.rowid DESC LIMIT 1`).get(contextId)
    return row ? String(row.gateway_id) : undefined
  }

  mergePrompt(a: string, b: string): { answer: MergePromptAnswer; at: number } | undefined {
    const row = this.db.prepare('SELECT answer, at FROM merge_prompts WHERE a = ? AND b = ?').get(...[a, b].sort())
    return row ? { answer: row.answer as MergePromptAnswer, at: Number(row.at) } : undefined
  }

  /** A dismissed reservation also prevents two background cards (or a restart) asking the same pair. */
  recordMergePrompt(a: string, b: string, answer: MergePromptAnswer, now = Date.now()): void {
    if (a === b) return
    const known = this.db.prepare('SELECT 1 FROM contexts WHERE id = ? UNION ALL SELECT 1 FROM topic_merges WHERE source_id = ? LIMIT 1')
    if (!known.get(a, a) || !known.get(b, b)) return
    this.db.prepare('INSERT INTO merge_prompts VALUES (?, ?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET answer = excluded.answer, at = excluded.at')
      .run(...[a, b].sort(), answer, now)
  }

  /** Other names cards gave a topic (or every topic), most recently confirmed first. */
  names(contextId?: string): Map<string, string[]> {
    const rows = (contextId === undefined ? this.db.prepare('SELECT context_id, name FROM topic_names ORDER BY last_at DESC, rowid ASC').all()
      : this.db.prepare('SELECT context_id, name FROM topic_names WHERE context_id = ? ORDER BY last_at DESC, rowid ASC').all(contextId))
    const out = new Map<string, string[]>()
    for (const row of rows) out.set(String(row.context_id), [...out.get(String(row.context_id)) ?? [], String(row.name)])
    return out
  }

  /** Values a topic settled on, most recently recorded first, each with the value it replaced. */
  settled(contextId: string): Settled[] {
    return this.db.prepare('SELECT * FROM topic_settled WHERE context_id = ? ORDER BY since DESC, rowid ASC').all(contextId).map(row => ({
      label: String(row.label), value: String(row.value), since: Number(row.since),
      ...(row.previous == null ? {} : { previous: String(row.previous), previousSince: Number(row.previous_since) }) }))
  }

  /** What the topic's latest card says is still open. */
  openItems(contextId: string): string[] {
    const row = this.db.prepare('SELECT items FROM topic_open WHERE context_id = ?').get(contextId)
    return row ? JSON.parse(String(row.items)) as string[] : []
  }

  groups(): TopicGroup[] {
    return this.db.prepare('SELECT * FROM topic_groups ORDER BY title').all().map(row => ({
      id: String(row.id), title: String(row.title), summary: String(row.summary),
      contextIds: this.db.prepare('SELECT context_id FROM topic_group_members WHERE group_id = ? ORDER BY context_id').all(String(row.id)).map(r => String(r.context_id)),
    })).filter(group => group.contextIds.length > 0)
  }

  isGateway(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM gateway_sessions WHERE gateway_id = ? LIMIT 1').get(sessionId)
  }

  /** Record the fixed "TheOne · Main chat" entry; other sessions may also use TheOne and switch away. */
  rememberGateway(gatewayKey: string, sessionId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO gateway_sessions VALUES (?, ?)').run(gatewayKey, sessionId)
    this.db.prepare('INSERT OR IGNORE INTO pinned_gateways VALUES (?)').run(sessionId)
  }

  /**
   * Sessions TheOne made for itself: every fixed main chat and each topic's background session.
   * Sessions the user made, including ones that once chose TheOne as their model, are not among them.
   */
  ownedSessionIds(): string[] {
    return this.db.prepare('SELECT gateway_id AS id FROM pinned_gateways UNION SELECT working_session_id AS id FROM contexts').all().map(row => String(row.id))
  }

  /** TheOne's own sessions it put in DSH's archive when it stopped; only these are taken out again. */
  stowedSessionIds(): string[] {
    return this.db.prepare('SELECT session_id FROM stowed_sessions').all().map(row => String(row.session_id))
  }
  markStowed(sessionId: string, stowed: boolean, now = Date.now()): void {
    if (stowed) this.db.prepare('INSERT OR REPLACE INTO stowed_sessions VALUES (?, ?)').run(sessionId, now)
    else this.db.prepare('DELETE FROM stowed_sessions WHERE session_id = ?').run(sessionId)
  }

  isPinnedGateway(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM pinned_gateways WHERE gateway_id = ?').get(sessionId)
  }

  origin(contextId: string): { sessionId: string; cwd?: string } | undefined {
    const row = this.db.prepare('SELECT * FROM context_origins WHERE context_id = ?').get(contextId)
    return row ? { sessionId: String(row.session_id), ...(row.cwd ? { cwd: String(row.cwd) } : {}) } : undefined
  }

  catalogConsent(): 'granted' | 'declined' | undefined {
    return this.db.prepare('SELECT consent FROM catalog_consent WHERE id = 1').get()?.consent as 'granted' | 'declined' | undefined
  }

  setCatalogConsent(value: 'granted' | 'declined'): void {
    this.db.prepare('INSERT OR REPLACE INTO catalog_consent VALUES (1, ?, ?)').run(value, Date.now())
  }

  catalogExclusions(): { sessions: Set<string>; folders: string[] } {
    const rows = this.db.prepare('SELECT kind, value FROM catalog_exclusions ORDER BY value').all()
    return { sessions: new Set(rows.filter(row => row.kind === 'session').map(row => String(row.value))),
      folders: rows.filter(row => row.kind === 'folder').map(row => String(row.value)) }
  }

  setCatalogExcluded(kind: 'session' | 'folder', value: string, excluded: boolean): void {
    if (excluded) this.db.prepare('INSERT OR REPLACE INTO catalog_exclusions VALUES (?, ?, ?)').run(kind, value, Date.now())
    else this.db.prepare('DELETE FROM catalog_exclusions WHERE kind = ? AND value = ?').run(kind, value)
  }

  /** An earlier chat of the user's was catalogued: TheOne's own sessions are indexed without asking. */
  hasIndexedHistory(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM history_index WHERE status = 'ready'
      AND session_id NOT IN (SELECT gateway_id FROM pinned_gateways UNION SELECT working_session_id FROM contexts) LIMIT 1`).get()
  }

  indexState(sessionId: string): { throughSeq: number; status: string } | undefined {
    const row = this.db.prepare('SELECT * FROM history_index WHERE session_id = ?').get(sessionId)
    return row ? { throughSeq: Number(row.through_seq), status: String(row.status) } : undefined
  }

  markIndex(sessionId: string, throughSeq: number, status: 'ready' | 'failed' | 'skipped' | 'excluded', errorCode?: string): void {
    this.db.prepare('INSERT OR REPLACE INTO history_index VALUES (?, ?, ?, ?)').run(sessionId, throughSeq, status, errorCode ?? null)
  }

  /** A turn of a topic the user deleted; the catalog must not extract it again while it is unchanged. */
  dismissedTurn(sessionId: string, seq: number): string | undefined {
    const row = this.db.prepare('SELECT fingerprint FROM dismissed_turns WHERE session_id = ? AND user_seq = ?').get(sessionId, seq)
    return row ? String(row.fingerprint) : undefined
  }

  indexedTurn(sessionId: string, seq: number): { fingerprint: string; contextId: string } | undefined {
    const row = this.db.prepare('SELECT fingerprint, context_id FROM history_turns WHERE session_id = ? AND user_seq = ?').get(sessionId, seq)
    return row ? { fingerprint: String(row.fingerprint), contextId: String(row.context_id) } : undefined
  }

  /** One validated batch commits descriptors, groups and exact source ranges atomically. */
  importTopics(sessionId: string, cwd: string | undefined, parts: HistoryPart[], topics: ExtractedTopic[]): void {
    this.db.exec('SAVEPOINT store_write')
    try {
      for (const topic of topics) {
        const id = topic.contextId ?? randomUUID()
        const existing = this.lookupContext(id)
        if (topic.contextId && !existing) throw new Error('CATALOG_CONTEXT_REMOVED')
        const metadata = existing && topic.metadataPatch ? { ...existing, ...topic.metadataPatch } : topic
        // The Worker's own progress note and DSH compaction summary outrank a catalog re-extraction, which only
        // sees short excerpts; otherwise every re-index after a turn would overwrite them.
        const stated = existing && this.db.prepare('SELECT 1 FROM context_state_updates WHERE context_id = ? LIMIT 1').get(id)
        const summarized = existing && this.db.prepare('SELECT 1 FROM context_summary_updates WHERE context_id = ? LIMIT 1').get(id)
        const descriptor: ContextDescriptor = { id, title: existing?.title ?? topic.title,
          summary: summarized ? existing.summary : metadata.summary, entities: metadata.entities, keywords: metadata.keywords,
          lastState: stated ? existing.lastState : metadata.lastState, ...(stated && existing.progress ? { progress: existing.progress } : {}) }
        if (existing) this.catalogDescriptor(id, descriptor)
        else {
          this.seed([descriptor])
          this.db.prepare('INSERT INTO context_origins VALUES (?, ?, ?)').run(id, sessionId, cwd ?? null)
        }
        if (!topic.metadataPatch) {
          let groupId = topic.groupId
          if (!groupId) {
            const title = topic.groupTitle || '待归类'
            const normalized = title.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
            groupId = 'group-' + createHash('sha256').update(normalized).digest('hex').slice(0, 20)
            this.db.prepare('INSERT OR IGNORE INTO topic_groups VALUES (?, ?, ?, ?)').run(groupId, title, topic.groupSummary, normalized)
          }
          this.assignGroup(id, groupId)
        }
        for (const seq of topic.turns) {
          const part = parts.find(part => part.seq === seq)!
          const old = this.db.prepare('SELECT * FROM history_turns WHERE session_id = ? AND user_seq = ?').get(sessionId, seq)
          if (old) this.db.prepare('DELETE FROM context_source_ranges WHERE context_id = ? AND session_id = ? AND start_seq = ? AND end_seq = ?')
            .run(String(old.context_id), sessionId, seq, Number(old.end_seq))
          this.addSource(id, sessionId, { startSeq: seq, endSeq: part.endSeq })
          this.db.prepare('INSERT OR REPLACE INTO history_turns VALUES (?, ?, ?, ?, ?)').run(sessionId, seq, part.endSeq, part.fingerprint, id)
        }
      }
      this.db.exec('RELEASE store_write')
    } catch (error) { this.rollbackWrite(); throw error }
  }

  private catalogDescriptor(id: string, descriptor: ContextDescriptor): void {
    this.learningJournal.record(`topic:${id}`, 'catalogDescriptor', [id, descriptor], () => {
      this.db.prepare('UPDATE contexts SET descriptor=? WHERE id=?').run(JSON.stringify(descriptor), id)
    }, undefined)
  }

  mount(gatewayKey: string, contextId: string): void {
    if (!this.contexts().some(context => context.id === contextId)) throw new Error('Unknown Context')
    this.db.prepare('INSERT INTO gateway_state VALUES (?, ?) ON CONFLICT(gateway_key) DO UPDATE SET context_id = excluded.context_id').run(gatewayKey, contextId)
  }
  unmount(gatewayKey: string): void {
    this.db.prepare('DELETE FROM gateway_state WHERE gateway_key = ?').run(gatewayKey)
  }

  contextsForSessions(sessionIds: string[]): string[] {
    const wanted = new Set(sessionIds)
    return this.contexts().filter(context => wanted.has(context.workingSessionId) || this.sources(context.id).some(id => wanted.has(id))).map(context => context.id)
  }

  /**
   * Model-maintained progress is bounded and auditable; stable project identity remains unchanged.
   * Given in three parts, it is kept as such and `lastState` is written from it; a free note replaces both.
   */
  updateState(contextId: string, state: string | Progress, sessionId: string, throughSeq: number): void {
    return this.learningJournal.record(`topic:${contextId}`, 'updateState', [contextId, state, sessionId, throughSeq], () => this.updateStateValue(contextId, state, sessionId, throughSeq), undefined)
  }

  private updateStateValue(contextId: string, state: string | Progress, sessionId: string, throughSeq: number): void {
    const context = this.contexts().find(item => item.id === contextId)
    if (!context || context.workingSessionId !== sessionId) throw new Error('State requires the owned Worker')
    let progress: Progress | undefined
    if (typeof state !== 'string') {
      progress = { goal: state.goal.trim(), done: state.done.trim(), next: state.next.trim() }
      if (!progress.goal && !progress.done && !progress.next || [progress.goal, progress.done, progress.next].some(part => part.length > 300)) throw new Error('Invalid project state')
    }
    const text = progress ? progressText(progress) : (state as string).trim()
    if (!text || (!progress && text.length > 800) || !Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new Error('Invalid project state')
    if (/\bsk-[a-zA-Z0-9_-]{16,}|\bBearer\s+\S+|(?:api[_ -]?key|password|密码|密钥)\s*[:=：]\s*\S+/i.test(text)) throw new Error('Project state must not contain credentials')
    const { workingSessionId: _, progress: __, ...descriptor } = context
    this.db.exec('SAVEPOINT store_write')
    try {
      this.db.prepare('UPDATE contexts SET descriptor = ? WHERE id = ?').run(JSON.stringify({ ...descriptor, lastState: text, ...(progress ? { progress } : {}) }), contextId)
      this.db.prepare('INSERT INTO context_state_updates(context_id, session_id, through_seq, state) VALUES (?, ?, ?, ?)')
        .run(contextId, sessionId, throughSeq, text)
      this.db.exec('RELEASE store_write')
    } catch (error) { this.rollbackWrite(); throw error }
  }

  stateUpdates(contextId: string) {
    return this.db.prepare('SELECT session_id AS sessionId, through_seq AS throughSeq, state, created_at AS createdAt FROM context_state_updates WHERE context_id = ? ORDER BY id').all(contextId)
  }

  /** Reuse a completed DSH compaction checkpoint once, without another model call. */
  updateSummary(contextId: string, summary: string, sessionId: string, summarySeq: number, endSeq: number): void {
    return this.learningJournal.record(`topic:${contextId}`, 'updateSummary', [contextId, summary, sessionId, summarySeq, endSeq], () => this.updateSummaryValue(contextId, summary, sessionId, summarySeq, endSeq), undefined)
  }

  private updateSummaryValue(contextId: string, summary: string, sessionId: string, summarySeq: number, endSeq: number): void {
    const context = this.contexts().find(item => item.id === contextId)
    if (!context || context.workingSessionId !== sessionId) throw new Error('Summary requires the owned Worker')
    if (!summary.trim() || summary.length > 1200 || !Number.isSafeInteger(summarySeq) || summarySeq < 0 || !Number.isSafeInteger(endSeq) || endSeq <= summarySeq) throw new Error('Invalid compaction reference')
    const { workingSessionId: _, ...descriptor } = context
    this.db.exec('SAVEPOINT store_write')
    try {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO context_summary_updates(context_id, session_id, summary_seq, end_seq, summary) VALUES (?, ?, ?, ?, ?)')
        .run(contextId, sessionId, summarySeq, endSeq, summary.trim())
      if (inserted.changes) this.db.prepare('UPDATE contexts SET descriptor = ? WHERE id = ?')
        .run(JSON.stringify({ ...descriptor, summary: summary.trim() }), contextId)
      this.db.exec('RELEASE store_write')
    } catch (error) { this.rollbackWrite(); throw error }
  }

  summaryUpdates(contextId: string) {
    return this.db.prepare('SELECT session_id AS sessionId, summary_seq AS summarySeq, end_seq AS endSeq, summary FROM context_summary_updates WHERE context_id = ? ORDER BY rowid').all(contextId)
  }

  /** Learned relatedness halves every two weeks without new evidence. */
  static readonly LINK_HALF_LIFE_MS = 14 * 86400000

  private pair(a: string, b: string): [string, string] { return a < b ? [a, b] : [b, a] }

  /** Link rows touching one topic (or all), with learned weight decayed to `now`. */
  links(contextId?: string, now = Date.now()): TopicLink[] {
    const rows = contextId === undefined ? this.db.prepare('SELECT * FROM topic_links').all()
      : this.db.prepare('SELECT * FROM topic_links WHERE a = ? OR b = ?').all(contextId, contextId)
    return rows.map(row => ({ a: String(row.a), b: String(row.b), manual: Number(row.manual) as TopicLink['manual'],
      weight: Number(row.weight) * 0.5 ** (Math.max(0, now - Number(row.updated_at)) / ContextStore.LINK_HALF_LIFE_MS) }))
  }

  /** Add learned evidence; a pair the user unlinked never learns back. */
  learnLink(a: string, b: string, delta: number, now = Date.now()): void {
    return this.learningJournal.record(`link:${JSON.stringify(this.pair(a, b))}`, 'learnLink', [a, b, delta, now], () => this.learnLinkValue(a, b, delta, now), undefined)
  }

  private learnLinkValue(a: string, b: string, delta: number, now = Date.now()): void {
    if (a === b) return
    const [x, y] = this.pair(a, b)
    const existing = this.links(x, now).find(link => link.a === x && link.b === y)
    if (existing?.manual === -1) return
    const weight = Math.min(5, Math.max(0, (existing?.weight ?? 0) + delta))
    this.db.prepare(`INSERT INTO topic_links(a, b, weight, manual, updated_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(a, b) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`).run(x, y, weight, now)
  }

  /** 1 links a pair permanently, -1 keeps it apart, 0 returns it to learning. */
  setManualLink(a: string, b: string, manual: TopicLink['manual'], now = Date.now()): void {
    return this.learningJournal.record(`link:${JSON.stringify(this.pair(a, b))}`, 'setManualLink', [a, b, manual, now], () => this.setManualLinkValue(a, b, manual, now), undefined)
  }

  private setManualLinkValue(a: string, b: string, manual: TopicLink['manual'], now = Date.now()): void {
    if (a === b) throw new Error('A topic cannot link to itself')
    const [x, y] = this.pair(a, b)
    this.db.prepare(`INSERT INTO topic_links(a, b, weight, manual, updated_at) VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(a, b) DO UPDATE SET manual = excluded.manual, weight = CASE WHEN excluded.manual = -1 THEN 0 ELSE topic_links.weight END`).run(x, y, manual, now)
  }

  /** Forget learned relatedness; the user's own links and separations stay. */
  clearLearnedLinks(): void {
    this.db.exec("DELETE FROM topic_links WHERE manual = 0; UPDATE topic_links SET weight = 0; DELETE FROM learning_events WHERE stream LIKE 'link:%'; DELETE FROM learning_bases WHERE stream LIKE 'link:%'")
  }

  setPrivate(contextId: string, value: boolean): void {
    this.db.prepare(`INSERT INTO topic_flags(context_id, private) VALUES (?, ?)
      ON CONFLICT(context_id) DO UPDATE SET private = excluded.private`).run(contextId, value ? 1 : 0)
  }

  privateIds(): Set<string> {
    return new Set(this.db.prepare('SELECT context_id FROM topic_flags WHERE private = 1').all().map(row => String(row.context_id)))
  }

  /** Project directory of every topic that came from an existing session. */
  origins(): Map<string, string | undefined> {
    return new Map(this.db.prepare('SELECT context_id, cwd FROM context_origins').all().map(row => [String(row.context_id), row.cwd ? String(row.cwd) : undefined]))
  }

  isPrivate(contextId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM topic_flags WHERE context_id = ? AND private = 1').get(contextId)
  }

  /** Standing rules for a topic, kept apart from summaries so compaction cannot drop them. */
  setConstraints(contextId: string, text: string | null, now = Date.now()): void {
    return this.learningJournal.record(`topic:${contextId}`, 'setConstraints', [contextId, text, now], () => this.setConstraintsValue(contextId, text, now), undefined)
  }

  private setConstraintsValue(contextId: string, text: string | null, now = Date.now()): void {
    const value = text?.trim() || null
    if (value && (value.length > 400 || /\bsk-[a-zA-Z0-9_-]{16,}|\bBearer\s+\S+/i.test(value))) throw new Error('Invalid topic constraints')
    this.db.prepare(`INSERT INTO topic_flags(context_id, constraints, constraints_at) VALUES (?, ?, ?)
      ON CONFLICT(context_id) DO UPDATE SET constraints = excluded.constraints, constraints_at = excluded.constraints_at`).run(contextId, value, now)
  }

  constraints(contextId: string): { text: string; at: number } | undefined {
    const row = this.db.prepare('SELECT constraints, constraints_at FROM topic_flags WHERE context_id = ? AND constraints IS NOT NULL').get(contextId)
    return row ? { text: String(row.constraints), at: Number(row.constraints_at) } : undefined
  }

  /** The latest full compaction summary of a topic's Worker and how far it covers. */
  saveDigest(contextId: string, summary: string, throughSeq: number, now = Date.now()): void {
    return this.learningJournal.record(`topic:${contextId}`, 'saveDigest', [contextId, summary, throughSeq, now], () => this.saveDigestValue(contextId, summary, throughSeq, now), undefined)
  }

  private saveDigestValue(contextId: string, summary: string, throughSeq: number, now = Date.now()): void {
    this.db.prepare(`INSERT INTO compaction_digests VALUES (?, ?, ?, ?) ON CONFLICT(context_id) DO UPDATE SET
      summary = excluded.summary, through_seq = excluded.through_seq, created_at = excluded.created_at
      WHERE excluded.through_seq > compaction_digests.through_seq`).run(contextId, summary.slice(0, 16000), throughSeq, now)
  }

  digest(contextId: string): { summary: string; throughSeq: number; at: number } | undefined {
    const row = this.db.prepare('SELECT * FROM compaction_digests WHERE context_id = ?').get(contextId)
    return row ? { summary: String(row.summary), throughSeq: Number(row.through_seq), at: Number(row.created_at) } : undefined
  }

  /** When `reader` last received `source`'s state in a briefing. */
  seen(reader: string, source: string): number | undefined {
    const row = this.db.prepare('SELECT seen_at FROM briefing_seen WHERE reader = ? AND source = ?').get(reader, source)
    return row ? Number(row.seen_at) : undefined
  }

  markSeen(reader: string, source: string, at: number): void {
    return this.learningJournal.record(`seen:${JSON.stringify([reader, source])}`, 'markSeen', [reader, source, at], () => this.markSeenValue(reader, source, at), undefined)
  }

  private markSeenValue(reader: string, source: string, at: number): void {
    this.db.prepare(`INSERT INTO briefing_seen VALUES (?, ?, ?) ON CONFLICT(reader, source) DO UPDATE SET seen_at = excluded.seen_at`).run(reader, source, at)
  }

  route(messageId: string): RouteRecord | undefined {
    const row = this.db.prepare('SELECT * FROM routing_events WHERE message_id = ?').get(messageId)
    return row ? {
      messageId: String(row.message_id), gatewayId: String(row.gateway_id),
      decision: JSON.parse(String(row.decision)) as Decision,
      status: String(row.status) as RouteRecord['status'],
    } : undefined
  }

  /** The main chat used last (by its latest routed message), else the newest one; shared by every browser. */
  latestGateway(gatewayKey: string): string | undefined {
    const row = this.db.prepare(`SELECT gs.gateway_id FROM gateway_sessions gs
      LEFT JOIN routing_events r ON r.gateway_id = gs.gateway_id
      WHERE gs.gateway_key = ? GROUP BY gs.gateway_id
      ORDER BY MAX(r.rowid) IS NULL, MAX(r.rowid) DESC, MAX(gs.rowid) DESC LIMIT 1`).get(gatewayKey)
    return row ? String(row.gateway_id) : undefined
  }

  recentGatewayIds(gatewayKey: string, excludingId: string): string[] {
    return this.db.prepare(`SELECT gs.gateway_id FROM gateway_sessions gs
      JOIN routing_events r ON r.gateway_id = gs.gateway_id
      WHERE gs.gateway_key = ? AND gs.gateway_id != ? AND r.status = 'completed'
      GROUP BY gs.gateway_id ORDER BY MAX(r.rowid) DESC LIMIT 2`)
      .all(gatewayKey, excludingId).map(row => String(row.gateway_id))
  }

  /**
   * Idempotent planning reserves a worker ID before any DSH creation. A message planned while another
   * reply runs (`mount` false) leaves the topic in use as it is until main chat gets to it.
   */
  plan(messageId: string, gatewayId: string, gatewayKey: string, proposed: Decision, mount = true): RouteRecord {
    this.db.exec('SAVEPOINT store_write')
    try {
      const existing = this.route(messageId)
      if (existing) {
        this.db.exec('RELEASE store_write')
        return existing
      }
      const decision = this.topicFor(proposed, messageId)
      if (decision.contextId && mount) {
        this.db.prepare('INSERT INTO gateway_state VALUES (?, ?) ON CONFLICT(gateway_key) DO UPDATE SET context_id = excluded.context_id')
          .run(gatewayKey, decision.contextId)
      }
      this.db.prepare('INSERT INTO routing_events(message_id, gateway_id, decision, status) VALUES (?, ?, ?, ?)')
        .run(messageId, gatewayId, JSON.stringify(decision), 'planned')
      this.db.prepare('INSERT OR IGNORE INTO gateway_sessions VALUES (?, ?)').run(gatewayKey, gatewayId)
      if (decision.contextId) this.learningJournal.source(messageId, decision.contextId)
      this.db.exec('RELEASE store_write')
      return { messageId, gatewayId, decision, status: 'planned' }
    } catch (error) {
      this.rollbackWrite()
      throw error
    }
  }

  /** A decision with its topic: a CREATE makes the topic (in its project's folder, when it has one). */
  private topicFor(proposed: Decision, messageId: string): Decision {
    if (proposed.action !== 'CREATE') return { ...proposed }
    const context: ContextDescriptor = {
      id: randomUUID(), title: proposed.title!, summary: '新话题，尚无历史摘要。',
      entities: [], keywords: [proposed.title!], lastState: '等待首次执行',
    }
    this.seed([{ ...context, title: '待整理话题', keywords: [] }])
    this.withLearning([this.learningJournal.source(messageId, context.id)], () => this.catalogDescriptor(context.id, context))
    // A new topic about one of the user's projects works in that project's folder.
    if (proposed.folder) {
      const working = this.db.prepare('SELECT working_session_id FROM contexts WHERE id = ?').get(context.id)
      this.db.prepare('INSERT OR IGNORE INTO context_origins VALUES (?, ?, ?)').run(context.id, String(working?.working_session_id), proposed.folder)
    }
    const group = this.groupForNew(proposed)
    if (group) this.withLearning([this.learningJournal.source(messageId, context.id)], () => this.assignGroup(context.id, group))
    return { ...proposed, contextId: context.id }
  }

  /**
   * The topic workspace a new topic joins by itself, so the user need not file it: that of a topic it
   * draws on, else the one most topics in its project folder are in. Only a placement; the user can
   * move it, and nothing is merged.
   */
  private groupForNew(proposed: Decision): string | undefined {
    const groupOf = (id: string) => this.db.prepare('SELECT group_id FROM topic_group_members WHERE context_id = ?').get(id)?.group_id
    for (const id of proposed.relatedIds ?? []) {
      const group = groupOf(id)
      if (group) return String(group)
    }
    if (!proposed.folder) return undefined
    const row = this.db.prepare(`SELECT m.group_id, COUNT(*) AS n FROM context_origins o JOIN topic_group_members m ON m.context_id = o.context_id
      WHERE o.cwd = ? GROUP BY m.group_id ORDER BY n DESC, m.group_id LIMIT 1`).get(proposed.folder)
    return row ? String(row.group_id) : undefined
  }

  /**
   * Give a message being answered to another topic (its first topic handed it back), and make that
   * topic the one in use. Returns the decision it now has, or undefined when the message has no route.
   */
  moveRoute(messageId: string, gatewayKey: string, proposed: Decision, commitLearning = true): Decision | undefined {
    this.db.exec('SAVEPOINT store_write')
    try {
      if (!this.route(messageId)) { this.db.exec('RELEASE store_write'); return undefined }
      const decision = this.topicFor(proposed, messageId)
      this.db.prepare('UPDATE routing_events SET decision = ? WHERE message_id = ?').run(JSON.stringify(decision), messageId)
      if (decision.contextId) this.db.prepare('INSERT INTO gateway_state VALUES (?, ?) ON CONFLICT(gateway_key) DO UPDATE SET context_id = excluded.context_id')
        .run(gatewayKey, decision.contextId)
      if (commitLearning && decision.contextId) this.reassignLearning(messageId, decision.contextId)
      this.db.exec('RELEASE store_write')
      return decision
    } catch (error) {
      this.rollbackWrite()
      throw error
    }
  }

  /** Only a planned route may execute. Ambiguous interrupted work is never replayed automatically. */
  claim(messageId: string): void {
    const result = this.db.prepare("UPDATE routing_events SET status = 'running' WHERE message_id = ? AND status = 'planned'").run(messageId)
    if (result.changes !== 1) throw new Error('This input has already started. Inspect its DSH session before resubmitting; automatic replay is disabled.')
  }

  /** Drop the route of a message main chat never got to (the user deleted it from the queue). */
  forget(messageId: string): void {
    this.db.prepare("DELETE FROM routing_events WHERE message_id = ? AND status IN ('planned', 'running')").run(messageId)
  }

  finish(messageId: string, status: 'completed' | 'failed'): void {
    this.db.prepare('UPDATE routing_events SET status = ? WHERE message_id = ?').run(status, messageId)
    const contextId = this.route(messageId)?.decision.contextId
    if (status === 'completed' && contextId) this.learningJournal.settle(messageId, contextId)
  }

  /** Whole-session access is allowed only for this Context's dedicated worker. */
  addSource(contextId: string, sessionId: string, range?: { startSeq: number; endSeq: number }): void {
    const context = this.lookupContext(contextId)
    if (!context) throw new Error('Unknown Context')
    if (range) {
      if (!Number.isSafeInteger(range.startSeq) || !Number.isSafeInteger(range.endSeq) ||
        range.startSeq < 0 || range.endSeq < range.startSeq) throw new Error('Invalid history event range')
      this.db.prepare('INSERT OR IGNORE INTO context_source_ranges VALUES (?, ?, ?, ?)')
        .run(contextId, sessionId, range.startSeq, range.endSeq)
    } else {
      if (sessionId !== context.workingSessionId) throw new Error('Historical sources require an explicit event range')
      this.db.prepare('INSERT OR IGNORE INTO context_sources VALUES (?, ?)').run(contextId, sessionId)
    }
  }

  /** Old unscoped historical mappings remain visible, but cannot be searched. */
  sourceRanges(contextId: string): SourceRange[] {
    const worker = this.lookupContext(contextId)?.workingSessionId
    const ranges: SourceRange[] = this.db.prepare('SELECT * FROM context_source_ranges WHERE context_id = ? ORDER BY session_id, start_seq')
      .all(contextId).map(row => ({ sessionId: String(row.session_id), kind: 'bounded', startSeq: Number(row.start_seq), endSeq: Number(row.end_seq) }))
    for (const row of this.db.prepare('SELECT session_id FROM context_sources WHERE context_id = ? ORDER BY session_id').all(contextId)) {
      const sessionId = String(row.session_id)
      if (ranges.some(range => range.sessionId === sessionId)) continue
      ranges.push({ sessionId, kind: sessionId === worker ? 'worker' : 'unscoped' })
    }
    return ranges
  }

  sources(contextId: string): string[] {
    return [...new Set(this.sourceRanges(contextId).map(source => source.sessionId))]
  }

  routeReceipt(messageId: string): import('./llm-router.ts').RouterReceipt | undefined {
    const row = this.db.prepare('SELECT receipt FROM route_details WHERE message_id=?').get(messageId)
    return row?.receipt ? JSON.parse(String(row.receipt)) : undefined
  }

  /** What a route was decided from: a short redacted excerpt and the classifier's receipt. */
  recordRouteDetail(messageId: string, excerpt: string, receipt: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO route_details(message_id, excerpt, receipt) VALUES (?, ?, ?)').run(messageId, excerpt, JSON.stringify(receipt))
  }

  /** What each topic has been sent in this entry: the newest excerpts of the messages routed to it (after corrections). */
  routedExcerpts(gatewayKey: string, perTopic = 200): Map<string, string[]> {
    const rows = this.db.prepare(`SELECT COALESCE(d.corrected_to, json_extract(r.decision, '$.contextId')) AS context_id, d.excerpt
      FROM routing_events r JOIN gateway_sessions gs ON gs.gateway_id = r.gateway_id
      JOIN route_details d ON d.message_id = r.message_id
      WHERE gs.gateway_key = ? AND r.status = 'completed' AND json_extract(r.decision, '$.action') != 'CLARIFY' AND d.excerpt != ''
      ORDER BY r.rowid DESC`).all(gatewayKey)
    const out = new Map<string, string[]>()
    for (const row of rows) {
      if (row.context_id == null) continue
      const list = out.get(String(row.context_id)) ?? []
      if (list.length < perTopic) out.set(String(row.context_id), [...list, String(row.excerpt)])
    }
    return out
  }

  /** This entry's latest routes, newest first. */
  recentRoutes(gatewayKey: string, limit = 20): RouteView[] {
    return this.db.prepare(`SELECT r.message_id, r.decision, r.status, r.created_at, d.excerpt, d.receipt, d.corrected_to
      FROM routing_events r JOIN gateway_sessions gs ON gs.gateway_id = r.gateway_id
      LEFT JOIN route_details d ON d.message_id = r.message_id
      WHERE gs.gateway_key = ? ORDER BY r.rowid DESC LIMIT ?`).all(gatewayKey, limit).map(row => ({
        messageId: String(row.message_id), decision: JSON.parse(String(row.decision)) as Decision, status: String(row.status) as RouteView['status'],
        at: Date.parse(String(row.created_at).replace(' ', 'T') + 'Z'), excerpt: row.excerpt == null ? '' : String(row.excerpt),
        ...(row.receipt ? { receipt: JSON.parse(String(row.receipt)) } : {}), ...(row.corrected_to ? { correctedTo: String(row.corrected_to) } : {}),
      }))
  }

  /** Record that a message belonged to another topic; later routing learns from it. */
  correctRoute(messageId: string, contextId: string, now = Date.now()): void {
    if (!this.route(messageId)) throw new Error('Unknown route')
    if (!this.contexts().some(context => context.id === contextId)) throw new Error('Unknown Context')
    this.inTransaction(() => {
    this.db.prepare(`INSERT INTO route_details(message_id, excerpt, corrected_to, corrected_at) VALUES (?, '', ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET corrected_to = excluded.corrected_to, corrected_at = excluded.corrected_at`).run(messageId, contextId, now)
      this.reassignLearning(messageId, contextId)
    })
  }

  /**
   * Terms a correction showed belong to a topic (positive delta) or not (negative). Weights fade
   * over time, stay within 0–5, and a term that falls to nothing is forgotten.
   */
  learnTerms(contextId: string, terms: string[], delta: number, now = Date.now()): void {
    return this.learningJournal.record(`topic:${contextId}`, 'learnTerms', [contextId, terms, delta, now], () => this.learnTermsValue(contextId, terms, delta, now), undefined)
  }

  private learnTermsValue(contextId: string, terms: string[], delta: number, now = Date.now()): void {
    if (!this.contexts().some(context => context.id === contextId)) return
    for (const raw of new Set(terms.map(term => term.trim()).filter(term => term.length >= 2 && term.length <= 24))) {
      const row = this.db.prepare('SELECT weight, updated_at FROM learned_terms WHERE context_id = ? AND term = ?').get(contextId, raw) as { weight: number; updated_at: number } | undefined
      const current = row ? row.weight * 0.5 ** ((now - row.updated_at) / TERM_HALF_LIFE_MS) : 0
      const weight = Math.min(5, current + delta)
      if (weight <= 0.05) this.db.prepare('DELETE FROM learned_terms WHERE context_id = ? AND term = ?').run(contextId, raw)
      else this.db.prepare('INSERT OR REPLACE INTO learned_terms VALUES (?, ?, ?, ?)').run(contextId, raw, weight, now)
    }
  }

  /** Each topic's learned terms that still count (weight > 0.5 after fading), strongest first. */
  learnedTerms(now = Date.now(), limit = 20): Map<string, string[]> {
    const result = new Map<string, { term: string; weight: number }[]>()
    for (const row of this.db.prepare('SELECT * FROM learned_terms').all() as { context_id: string; term: string; weight: number; updated_at: number }[]) {
      const weight = row.weight * 0.5 ** ((now - row.updated_at) / TERM_HALF_LIFE_MS)
      if (weight <= 0.5) continue
      result.set(row.context_id, [...result.get(row.context_id) ?? [], { term: row.term, weight }])
    }
    return new Map([...result].map(([id, terms]) => [id, terms.sort((a, b) => b.weight - a.weight).slice(0, limit).map(item => item.term)]))
  }

  /** How routing has gone lately: of the last `limit` messages, how many were moved, asked about or routed by rules after a failure. */
  routeStats(gatewayKey: string, limit = 100): { total: number; corrected: number; clarified: number; fallback: number } {
    const routes = this.recentRoutes(gatewayKey, limit)
    return { total: routes.length,
      corrected: routes.filter(route => route.correctedTo && route.correctedTo !== route.decision.contextId).length,
      clarified: routes.filter(route => route.decision.action === 'CLARIFY').length,
      fallback: routes.filter(route => route.decision.reason.startsWith('router-fallback:')).length }
  }

  /** Corrections as examples for the classifier: this text belonged there, not here. Newest first. */
  corrections(gatewayKey: string, limit = 50): { text: string; wrongId?: string; rightId: string }[] {
    const known = new Set(this.contexts().map(context => context.id))
    return this.db.prepare(`SELECT d.excerpt, d.corrected_to, r.decision FROM route_details d
      JOIN routing_events r ON r.message_id = d.message_id JOIN gateway_sessions gs ON gs.gateway_id = r.gateway_id
      WHERE gs.gateway_key = ? AND d.corrected_to IS NOT NULL AND d.excerpt != '' ORDER BY d.corrected_at DESC LIMIT ?`).all(gatewayKey, limit * 2)
      .flatMap(row => {
        const wrongId = (JSON.parse(String(row.decision)) as Decision).contextId
        const rightId = String(row.corrected_to)
        // A message moved back where it first went teaches nothing.
        return known.has(rightId) && wrongId !== rightId ? [{ text: String(row.excerpt), ...(wrongId && known.has(wrongId) ? { wrongId } : {}), rightId }] : []
      }).slice(0, limit)
  }

  private writeDescriptor(context: StoredContext): void {
    const { workingSessionId: _, ...descriptor } = context
    this.db.prepare('UPDATE contexts SET descriptor = ? WHERE id = ?').run(JSON.stringify(descriptor), context.id)
  }

  private context(contextId: string): StoredContext {
    const context = this.lookupContext(contextId)
    if (!context) throw new Error('Unknown Context')
    return context
  }

  /** Terms a correction showed belong to this topic, newest kept first. */
  addKeywords(contextId: string, terms: string[]): void {
    return this.learningJournal.record(`topic:${contextId}`, 'addKeywords', [contextId, terms], () => this.addKeywordsValue(contextId, terms), undefined)
  }

  private addKeywordsValue(contextId: string, terms: string[]): void {
    const context = this.context(contextId)
    const seen = new Set<string>()
    const keywords = [...terms, ...context.keywords].filter(term => {
      const key = term.toLowerCase()
      if (!term.trim() || seen.has(key)) return false
      seen.add(key); return true
    }).slice(0, 40)
    this.writeDescriptor({ ...context, keywords })
  }

  /** The user's own wording for a topic outranks what the catalog extracted. */
  editTopic(contextId: string, change: { title?: string; summary?: string; lastState?: string }): void {
    return this.learningJournal.record(`topic:${contextId}`, 'editTopic', [contextId, change], () => this.editTopicValue(contextId, change), undefined)
  }

  private editTopicValue(contextId: string, change: { title?: string; summary?: string; lastState?: string }): void {
    const context = this.context(contextId)
    const title = change.title?.trim()
    if (title !== undefined && (!title || title.length > 80 || this.contexts().some(other => other.id !== contextId && other.title.toLowerCase() === title.toLowerCase())))
      throw new Error('Invalid topic title')
    const summary = change.summary?.trim()
    if (summary !== undefined && (!summary || summary.length > 2000)) throw new Error('Invalid topic summary')
    this.writeDescriptor({ ...context, ...(title ? { title } : {}), ...(summary ? { summary } : {}) })
    // A hand-written summary is kept like a compaction summary: re-indexing will not overwrite it.
    if (summary) this.db.prepare("INSERT OR REPLACE INTO context_summary_updates(context_id, session_id, summary_seq, end_seq, summary) VALUES (?, 'user', 0, 0, ?)").run(contextId, summary)
  }

  createTopic(title: string, summary?: string): string {
    const name = title.trim()
    if (!name || name.length > 80 || this.contexts().some(context => context.title.toLowerCase() === name.toLowerCase())) throw new Error('Invalid topic title')
    const id = randomUUID()
    this.seed([{ id, title: name, summary: summary?.trim() || '新话题，尚无历史摘要。', entities: [], keywords: [name], lastState: '等待首次执行' }])
    return id
  }

  /**
   * A branch of a topic: a new topic with the same descriptor, constraints, privacy, workspace and
   * folder, whose work continues in `workingSessionId` (a fork of the topic's session).
   */
  branchTopic(sourceId: string, title: string, workingSessionId: string, cwd?: string): string {
    const source = this.context(sourceId)
    const id = randomUUID()
    this.db.prepare('INSERT INTO contexts VALUES (?, ?, ?)').run(id, JSON.stringify({ id, title, summary: '新话题，尚无历史摘要。', entities: [], keywords: [title], lastState: '' }), workingSessionId)
    this.db.prepare('INSERT INTO context_origins VALUES (?, ?, ?)').run(id, workingSessionId, cwd ?? this.origin(sourceId)?.cwd ?? null)
    const group = this.db.prepare('SELECT group_id FROM topic_group_members WHERE context_id = ?').get(sourceId)
    if (group) this.db.prepare('INSERT OR REPLACE INTO topic_group_members VALUES (?, ?)').run(id, String(group.group_id))
    const inherited = this.learningJournal.dependencies(`topic:${sourceId}`)
    this.withLearning(inherited, () => {
      const { workingSessionId: _, ...descriptor } = source
      this.catalogDescriptor(id, { ...descriptor, id, title })
      const constraints = this.constraints(sourceId)
      if (constraints) this.setConstraints(id, constraints.text)
    })
    this.db.prepare(`INSERT OR IGNORE INTO learning_turns SELECT ?,input_id,message_id,context_id,start_seq,end_seq,revision,parents
      FROM learning_turns WHERE session_id=?`).run(workingSessionId, source.workingSessionId)
    if (this.isPrivate(sourceId)) this.setPrivate(id, true)
    return id
  }

  /** Put a topic in another topic workspace, or a new one named `title`; null leaves it unassigned. */
  moveTopic(contextId: string, target: { groupId: string } | { title: string } | null): void {
    this.context(contextId)
    if (target === null) { this.assignGroup(contextId, null); this.markOnce(`merge-moved:${contextId}`); return }
    let groupId: string
    if ('groupId' in target) {
      if (!this.db.prepare('SELECT 1 FROM topic_groups WHERE id = ?').get(target.groupId)) throw new Error('Unknown topic workspace')
      groupId = target.groupId
    } else {
      const title = target.title.trim()
      if (!title || title.length > 80) throw new Error('Invalid topic workspace title')
      const normalized = title.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
      groupId = 'group-' + createHash('sha256').update(normalized).digest('hex').slice(0, 20)
      this.db.prepare('INSERT OR IGNORE INTO topic_groups VALUES (?, ?, ?, ?)').run(groupId, title, '', normalized)
    }
    this.assignGroup(contextId, groupId)
    this.markOnce(`merge-moved:${contextId}`)
  }

  private assignGroup(contextId: string, groupId: string | null): void {
    this.learningJournal.record(`group:${contextId}`, 'assignGroup', [contextId, groupId], () => {
      if (groupId === null) this.db.prepare('DELETE FROM topic_group_members WHERE context_id=?').run(contextId)
      else this.db.prepare('INSERT OR REPLACE INTO topic_group_members VALUES (?,?)').run(contextId, groupId)
    }, undefined)
  }

  /** Attach a whole existing session to a topic as reviewed history its Worker may search. */
  attachSession(contextId: string, sessionId: string): void {
    this.addSource(contextId, sessionId, WHOLE_SESSION)
  }

  /**
   * Fold `sourceId` into `targetId`: its history, progress, summaries and links move over, and its
   * own Worker session becomes searchable history of the target. The source topic leaves the
   * directory, but everything the merge did is written down so `unmergeTopic` can take it apart.
   */
  mergeTopics(sourceId: string, targetId: string, now = Date.now()): void {
    const sources = this.learningJournal.dependencies(`topic:${sourceId}`)
    const projection = this.learningSnapshot(`topic:${sourceId}`)
    this.withLearning(sources, () => this.learningJournal.record(`topic:${targetId}`, 'mergeLearning', [targetId, sourceId, projection],
      () => this.mergeTopicsValue(sourceId, targetId, now), undefined))
  }

  private mergeTopicsValue(sourceId: string, targetId: string, now = Date.now()): void {
    if (sourceId === targetId) throw new Error('Cannot merge a topic into itself')
    const source = this.context(sourceId), target = this.context(targetId)
    const journal: MergeJournal = { at: now, moved: {}, added: {}, purged: {}, terms: { entities: [], keywords: [] }, corrected: [], facts: [], removedDependencies: [], links: [] }
    const rowids = (table: string, where: string, ...params: string[]) => this.db.prepare(`SELECT rowid AS id FROM ${table} WHERE ${where}`).all(...params).map(row => Number(row.id))
    // Rows that move to the target keep their rowid; rows copied into it are new ones.
    const move = (table: string, ignore = false) => {
      const before = rowids(table, 'context_id = ?', sourceId)
      this.db.prepare(`UPDATE ${ignore ? 'OR IGNORE ' : ''}${table} SET context_id = ? WHERE context_id = ?`).run(targetId, sourceId)
      const moved = new Set(rowids(table, 'context_id = ?', targetId))
      journal.moved[table] = before.filter(id => moved.has(id))
    }
    const copy = (table: string, sql: string, ...params: string[]) => {
      const before = new Set(rowids(table, 'context_id = ?', targetId))
      this.db.prepare(sql).run(...params)
      journal.added[table] = rowids(table, 'context_id = ?', targetId).filter(id => !before.has(id))
    }
    this.db.exec('SAVEPOINT store_write')
    try {
      this.markOnce(`merge-handled:${sourceId}`); this.markOnce(`merge-handled:${targetId}`)
      const merged = (a: string[], b: string[]) => [...new Map([...a, ...b].map(term => [term.toLowerCase(), term])).values()].slice(0, 40)
      const entities = merged(target.entities, source.entities), keywords = merged(target.keywords, source.keywords)
      journal.terms = { entities: entities.filter(term => !target.entities.includes(term)), keywords: keywords.filter(term => !target.keywords.includes(term)) }
      this.writeDescriptor({ ...target, entities, keywords })
      copy('context_source_ranges', 'INSERT OR IGNORE INTO context_source_ranges SELECT ?, session_id, start_seq, end_seq FROM context_source_ranges WHERE context_id = ?', targetId, sourceId)
      // The source's own Worker conversation is now reviewed history of the target, not a new catalog source.
      journal.index = { sessionId: source.workingSessionId, row: this.db.prepare('SELECT * FROM history_index WHERE session_id = ?').get(source.workingSessionId) ?? null }
      this.markIndex(source.workingSessionId, Number.MAX_SAFE_INTEGER, 'excluded')
      const ranges = new Set(rowids('context_source_ranges', 'context_id = ?', targetId))
      this.db.prepare('INSERT OR IGNORE INTO context_source_ranges VALUES (?, ?, ?, ?)').run(targetId, source.workingSessionId, WHOLE_SESSION.startSeq, WHOLE_SESSION.endSeq)
      journal.added.context_source_ranges.push(...rowids('context_source_ranges', 'context_id = ?', targetId).filter(id => !ranges.has(id)))
      for (const table of ['history_turns', 'context_state_updates', 'topic_runs', 'correction_terms']) move(table)
      move('context_summary_updates', true)
      this.db.prepare('UPDATE gateway_state SET context_id = ? WHERE context_id = ?').run(targetId, sourceId)
      journal.corrected = this.db.prepare('SELECT message_id FROM route_details WHERE corrected_to = ?').all(sourceId).map(row => String(row.message_id))
      this.db.prepare('UPDATE route_details SET corrected_to = ? WHERE corrected_to = ?').run(targetId, sourceId)
      copy('learned_terms', 'INSERT OR IGNORE INTO learned_terms SELECT ?, term, weight, updated_at FROM learned_terms WHERE context_id = ?', targetId, sourceId)
      // The merged topic keeps both topics' names; its own settled values win over the source's.
      copy('topic_names', 'INSERT OR IGNORE INTO topic_names SELECT ?, name_key, name, first_at, last_at FROM topic_names WHERE context_id = ?', targetId, sourceId)
      copy('topic_settled', 'INSERT OR IGNORE INTO topic_settled SELECT ?, label_key, label, value, since, previous, previous_since FROM topic_settled WHERE context_id = ?', targetId, sourceId)
      const before = this.constraints(targetId)?.text
      const rules = [before, this.constraints(sourceId)?.text].filter(Boolean)
      if (rules.length) {
        const joined = rules.join('\n').slice(0, 400)
        if (joined !== before) { journal.constraints = { before: before ?? null, after: joined }; this.setConstraints(targetId, joined) }
      }
      for (const link of this.links(sourceId)) {
        const other = link.a === sourceId ? link.b : link.a
        if (other === targetId) continue
        const [a, b] = targetId < other ? [targetId, other] : [other, targetId]
        journal.links.push({ a, b, row: this.db.prepare('SELECT * FROM topic_links WHERE a = ? AND b = ?').get(a, b) ?? null })
        this.withLearning(this.learningJournal.dependencies(`link:${JSON.stringify(this.pair(sourceId, other))}`), () =>
          this.mergeLink(targetId, sourceId, other, link.weight, link.manual, now))
      }
      this.mergeFacts(sourceId, targetId, source.title, journal)
      // What is left of the source is kept in the journal before it goes.
      journal.purged = { ...this.snapshot(sourceId), fact_dependencies: journal.purged.fact_dependencies ?? [] }
      this.purge(sourceId)
      this.db.prepare('INSERT OR REPLACE INTO topic_merges VALUES (?, ?, ?, ?)').run(sourceId, targetId, now, JSON.stringify(journal))
      this.db.exec('RELEASE store_write')
    } catch (error) { this.rollbackWrite(); throw error }
  }

  private mergeLink(targetId: string, sourceId: string, other: string, weight: number, manual: -1 | 0 | 1, now: number): void {
    this.learningJournal.record(`link:${JSON.stringify(this.pair(targetId, other))}`, 'mergeLink', [targetId, sourceId, other, weight, manual, now], () => {
      if (manual) this.setManualLinkValue(targetId, other, manual, now)
      if (weight > 0) this.learnLinkValue(targetId, other, weight, now)
    }, undefined)
  }

  /** Topics merged into others that can still be taken apart, newest first. */
  merges(): { sourceId: string; targetId: string; title: string; at: number }[] {
    const live = new Set(this.contexts().map(context => context.id))
    return this.db.prepare('SELECT * FROM topic_merges ORDER BY at DESC, rowid DESC').all().flatMap(row => {
      const journal = JSON.parse(String(row.journal)) as MergeJournal
      const descriptor = journal.purged.contexts?.[0]?.descriptor
      const title = descriptor ? (JSON.parse(String(descriptor)) as ContextDescriptor).title : String(row.source_id)
      return live.has(String(row.target_id)) && !live.has(String(row.source_id))
        ? [{ sourceId: String(row.source_id), targetId: String(row.target_id), title, at: Number(row.at) }] : []
    })
  }

  /**
   * Take a merge apart: the source topic comes back with what it had, and what came from it leaves
   * the target. What either topic did since stays where it happened.
   */
  unmergeTopic(sourceId: string): string {
    const row = this.db.prepare('SELECT * FROM topic_merges WHERE source_id = ?').get(sourceId)
    if (!row) throw new Error('Not a merged topic')
    const targetId = String(row.target_id)
    if (!this.contexts().some(context => context.id === targetId)) throw new Error('The topic it was merged into is gone')
    if (this.contexts().some(context => context.id === sourceId)) throw new Error('The topic is already back')
    const journal = JSON.parse(String(row.journal)) as MergeJournal
    const target = this.context(targetId)
    const insert = (table: string, rows: readonly Record<string, unknown>[] = []) => {
      for (const item of rows) {
        const columns = Object.keys(item)
        this.db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => item[column] as never))
      }
    }
    const ids = (list: readonly number[]) => list.length ? list.join(', ') : 'NULL'
    this.db.exec('SAVEPOINT store_write')
    try {
      insert('contexts', journal.purged.contexts)
      for (const [table, rows] of Object.entries(journal.purged)) if (table !== 'contexts') insert(table, rows)
      for (const [table, list] of Object.entries(journal.moved))
        this.db.prepare(`UPDATE OR IGNORE ${table} SET context_id = ? WHERE context_id = ? AND rowid IN (${ids(list)})`).run(sourceId, targetId)
      for (const [table, list] of Object.entries(journal.added)) this.db.prepare(`DELETE FROM ${table} WHERE context_id = ? AND rowid IN (${ids(list)})`).run(targetId)
      const added = new Set(journal.added.fact_dependencies ?? [])
      insert('fact_dependencies', journal.removedDependencies.filter(item => !added.has(Number(item.rowid))).map(({ rowid: _, ...item }) => item))
      for (const fact of journal.facts)
        this.db.prepare('UPDATE OR IGNORE facts SET context_id = ?, key = ?, label = ?, merged_from = ? WHERE id = ? AND context_id = ?').run(sourceId, fact.key, fact.label, fact.mergedFrom, fact.id, targetId)
      const drop = (list: string[], gone: string[]) => list.filter(term => !gone.includes(term))
      this.writeDescriptor({ ...target, entities: drop(target.entities, journal.terms.entities), keywords: drop(target.keywords, journal.terms.keywords) })
      for (const messageId of journal.corrected) this.db.prepare('UPDATE route_details SET corrected_to = ? WHERE message_id = ? AND corrected_to = ?').run(sourceId, messageId, targetId)
      if (journal.constraints && this.constraints(targetId)?.text === journal.constraints.after) this.setConstraints(targetId, journal.constraints.before)
      for (const link of journal.links) {
        this.db.prepare('DELETE FROM topic_links WHERE a = ? AND b = ?').run(link.a, link.b)
        if (link.row) insert('topic_links', [link.row])
      }
      if (journal.index) {
        this.db.prepare('DELETE FROM history_index WHERE session_id = ?').run(journal.index.sessionId)
        if (journal.index.row) insert('history_index', [journal.index.row])
      }
      this.db.prepare('DELETE FROM topic_merges WHERE source_id = ?').run(sourceId)
      this.db.prepare("UPDATE learning_events SET active=0 WHERE kind IN ('mergeLearning','mergeLink') AND json_extract(args,'$[1]')=?").run(sourceId)
      const linkStreams = this.db.prepare("SELECT stream FROM learning_bases WHERE stream LIKE 'link:%'").all()
        .map(row => String(row.stream)).filter(stream => (JSON.parse(stream.slice(5)) as string[]).some(id => id === sourceId || id === targetId))
      this.learningJournal.rebuild([`topic:${sourceId}`, `topic:${targetId}`, ...linkStreams])
      this.db.exec('RELEASE store_write')
    } catch (error) { this.rollbackWrite(); throw error }
    return targetId
  }

  /** Every row TheOne keeps about a topic, by table, as `purge` would remove them. */
  private snapshot(contextId: string): Record<string, Record<string, unknown>[]> {
    const rows = (table: string, where: string, ...params: string[]) => this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params) as Record<string, unknown>[]
    const out: Record<string, Record<string, unknown>[]> = { contexts: rows('contexts', 'id = ?', contextId) }
    for (const table of PURGED_TABLES) out[table] = rows(table, 'context_id = ?', contextId)
    out.topic_links = rows('topic_links', 'a = ? OR b = ?', contextId, contextId)
    out.hidden_contexts = rows('hidden_contexts', 'context_id = ?', contextId)
    out.briefing_seen = rows('briefing_seen', 'reader = ? OR source = ?', contextId, contextId)
    out.facts = rows('facts', 'context_id = ?', contextId)
    out.fact_versions = rows('fact_versions', 'fact_id IN (SELECT id FROM facts WHERE context_id = ?)', contextId)
    out.fact_dependencies = rows('fact_dependencies', 'context_id = ?', contextId)
    out.fact_deliveries = rows('fact_deliveries', 'context_id = ?', contextId).map(({ id: _, ...item }) => item)
    return out
  }

  /** Remove a topic and everything TheOne kept about it. DSH keeps the conversations themselves. */
  deleteTopic(contextId: string): void {
    const context = this.context(contextId)
    this.db.exec('SAVEPOINT store_write')
    try {
      // The catalog would otherwise find the same conversation again and bring the topic back.
      this.db.prepare('INSERT OR REPLACE INTO dismissed_turns SELECT session_id, user_seq, fingerprint FROM history_turns WHERE context_id = ?').run(contextId)
      this.markIndex(context.workingSessionId, Number.MAX_SAFE_INTEGER, 'excluded')
      // Topics merged into it can no longer be taken apart from it.
      this.db.prepare('DELETE FROM topic_merges WHERE target_id = ? OR source_id = ?').run(contextId, contextId)
      this.db.prepare('DELETE FROM merge_prompts WHERE a = ? OR b = ?').run(contextId, contextId)
      this.db.prepare('DELETE FROM plugin_flags WHERE name IN (?, ?)').run(`merge-moved:${contextId}`, `merge-handled:${contextId}`)
      this.purge(contextId); this.db.exec('RELEASE store_write')
    }
    catch (error) { this.rollbackWrite(); throw error }
  }

  private purge(contextId: string): void {
    for (const table of PURGED_TABLES)
      this.db.prepare(`DELETE FROM ${table} WHERE context_id = ?`).run(contextId)
    this.db.prepare('DELETE FROM topic_links WHERE a = ? OR b = ?').run(contextId, contextId)
    this.db.prepare('DELETE FROM hidden_contexts WHERE context_id = ?').run(contextId)
    this.db.prepare('DELETE FROM briefing_seen WHERE reader = ? OR source = ?').run(contextId, contextId)
    this.db.prepare('UPDATE route_details SET corrected_to = NULL, corrected_at = NULL WHERE corrected_to = ?').run(contextId)
    this.purgeFacts(contextId)
    this.db.prepare('DELETE FROM contexts WHERE id = ?').run(contextId)
  }

  // ---- Facts: a topic's settled items, versioned, with evidence. Runs inside the caller's transaction where one is open.

  private factQuery(where: string): string {
    return `SELECT f.*, v.status, v.value, v.evidence, v.origin, v.created_at FROM facts f
      LEFT JOIN fact_versions v ON v.fact_id = f.id AND v.version = f.current_version WHERE ${where}`
  }

  private factFrom(row: Record<string, unknown>): FactView {
    return { id: String(row.id), contextId: String(row.context_id), key: String(row.key), label: String(row.label),
      aliases: JSON.parse(String(row.aliases)) as string[], kind: String(row.kind) as FactKind, version: Number(row.current_version),
      status: (row.status ? String(row.status) : 'retracted') as FactStatus, value: row.value == null ? null : String(row.value),
      evidence: row.evidence ? JSON.parse(String(row.evidence)) as FactEvidence : { sessionId: '', seq: null, speaker: 'unverified', quote: '' },
      origin: (row.origin ? String(row.origin) : 'worker') as FactView['origin'], createdAt: Number(row.created_at ?? 0),
      ...(row.deleted_at != null ? { deletedAt: Number(row.deleted_at) } : {}), ...(row.merged_from ? { mergedFrom: String(row.merged_from) } : {}) }
  }

  /** A fact's current state, also when its topic was deleted (then it has no value). */
  fact(factId: string): (FactView & { lastUsedAt?: number }) | undefined {
    const row = this.db.prepare(this.factQuery('f.id = ?')).get(factId) as Record<string, unknown> | undefined
    return row && { ...this.factFrom(row), ...(row.last_used_at != null ? { lastUsedAt: Number(row.last_used_at) } : {}) }
  }

  /** One earlier version of a fact. */
  factVersion(factId: string, version: number): FactView | undefined {
    const row = this.db.prepare(`SELECT f.*, v.status, v.value, v.evidence, v.origin, v.created_at, v.version AS current_version FROM facts f
      JOIN fact_versions v ON v.fact_id = f.id WHERE f.id = ? AND v.version = ?`).get(factId, version) as Record<string, unknown> | undefined
    return row && this.factFrom(row)
  }

  /** A topic's live facts; include withdrawn identities when taking a write/extraction baseline. */
  facts(contextId: string, includeRetracted = false): FactView[] {
    return (this.db.prepare(this.factQuery(`f.context_id = ? AND f.deleted_at IS NULL ${includeRetracted ? '' : "AND v.status != 'retracted'"} ORDER BY COALESCE(f.last_used_at, v.created_at) DESC`)).all(contextId) as Record<string, unknown>[])
      .map(row => this.factFrom(row)).filter(fact => fact.status !== 'retracted' || !this.db.prepare(`SELECT 1 FROM learning_fact_versions
        WHERE fact_id=? AND invalid=1 AND NOT EXISTS (SELECT 1 FROM fact_versions v LEFT JOIN learning_fact_versions p
          ON p.fact_id=v.fact_id AND p.version=v.version WHERE v.fact_id=? AND v.status!='retracted' AND COALESCE(p.invalid,0)=0)`).get(fact.id, fact.id))
  }

  /** Confirmed facts of every other live topic, the pool other topics may draw from. */
  sharedFacts(excludeContextId?: string): (FactView & { lastUsedAt?: number })[] {
    return (this.db.prepare(this.factQuery("f.deleted_at IS NULL AND v.status = 'confirmed' AND f.context_id != ?")).all(excludeContextId ?? '') as Record<string, unknown>[])
      .map(row => ({ ...this.factFrom(row), ...(row.last_used_at != null ? { lastUsedAt: Number(row.last_used_at) } : {}) }))
  }

  private factByName(contextId: string, key: string): FactView | undefined {
    const exact = this.db.prepare(this.factQuery('f.context_id = ? AND f.key = ? AND f.deleted_at IS NULL')).get(contextId, key) as Record<string, unknown> | undefined
    if (exact) return this.factFrom(exact)
    return this.facts(contextId).find(fact => fact.aliases.includes(key))
      ?? (this.db.prepare(this.factQuery("f.context_id = ? AND f.deleted_at IS NULL AND v.status = 'retracted'")).all(contextId) as Record<string, unknown>[])
        .map(row => this.factFrom(row)).find(fact => fact.aliases.includes(key))
  }

  /** Refuse a write that is older than what the fact already holds. */
  private staleWrite(current: FactView, evidence: FactEvidence, expectedVersion?: number): string | undefined {
    if (expectedVersion !== undefined && expectedVersion !== current.version) return 'stale'
    // Within one session, evidence only moves forward: a slow write from an earlier turn cannot win.
    if (current.evidence.sessionId === evidence.sessionId && current.evidence.seq != null && evidence.seq != null && evidence.seq < current.evidence.seq) return 'older-evidence'
    return undefined
  }

  private newerEvidence(current: FactView, evidence: FactEvidence): boolean {
    return evidence.sessionId !== current.evidence.sessionId ||
      (evidence.seq != null && (current.evidence.seq == null || evidence.seq > current.evidence.seq))
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT store_write')
    try { const result = work(); this.db.exec('RELEASE store_write'); return result }
    catch (error) { this.rollbackWrite(); throw error }
  }

  private addVersion(factId: string, version: number, status: FactStatus, value: string | null, evidence: FactEvidence, origin: FactView['origin'], now: number, intended: FactStatus = status): void {
    this.db.prepare('INSERT INTO fact_versions VALUES (?, ?, ?, ?, ?, ?, ?)').run(factId, version, status, value, JSON.stringify(evidence), origin, now)
    this.db.prepare('UPDATE facts SET current_version = ? WHERE id = ?').run(version, factId)
    const aliases = this.db.prepare('SELECT aliases FROM facts WHERE id=?').get(factId)!.aliases
    this.db.prepare('INSERT INTO learning_fact_versions(fact_id,version,sources,aliases,intended) VALUES (?,?,?,?,?)')
      .run(factId, version, JSON.stringify(this.factSources(evidence)), String(aliases), intended)
  }

  /**
   * Record a fact or a new value of it. Same fact means the given id, or the same folded name or alias
   * within the topic; names are never matched loosely. The write is refused when it is stale, when its
   * evidence is older than the current version's, or when a proposal would replace a confirmed value.
   */
  recordFact(contextId: string, write: FactWrite, now = Date.now()): FactResult {
    this.context(contextId)
    if (!this.learningJournal.valid(this.factSources(write.evidence))) return { outcome: 'rejected', reason: 'excluded-route' }
    const label = safe(write.label, FACT_LIMITS.label), key = factKey(label), value = safe(write.value, FACT_LIMITS.value)
    if (!key || !value || !FACT_KINDS.includes(write.kind)) return { outcome: 'rejected', reason: 'invalid' }
    const evidence = { ...write.evidence, quote: safe(write.evidence.quote, FACT_LIMITS.quote) }
    const status = write.status === 'confirmed' && !this.canShareLearning(this.factSources(evidence)) ? 'proposed' : write.status
    const aliasKeys = (names: string[], exclude = key) => [...new Set(names.map(name => factKey(safe(name, FACT_LIMITS.alias))).filter(alias => alias && alias !== exclude))].slice(0, FACT_LIMITS.aliases)
    return this.inTransaction(() => {
      const current = write.factId ? this.fact(write.factId) : this.factByName(contextId, key)
      if (write.factId && (!current || current.contextId !== contextId || current.deletedAt !== undefined)) return { outcome: 'rejected', reason: 'unknown-fact' } as FactResult
      if (!current) {
        if (this.db.prepare('SELECT 1 FROM facts WHERE context_id = ? AND key = ?').get(contextId, key)) return { outcome: 'rejected', reason: 'invalid' } as FactResult
        const id = 'fact_' + randomUUID().replaceAll('-', '').slice(0, 20)
        this.db.prepare('INSERT INTO facts (id, context_id, key, label, aliases, kind, current_version) VALUES (?, ?, ?, ?, ?, ?, 0)')
          .run(id, contextId, key, label, JSON.stringify(aliasKeys(write.aliases ?? [])), write.kind)
        this.recordFactAliases(id, aliasKeys(write.aliases ?? []), this.factSources(evidence))
        this.addVersion(id, 1, status, value, evidence, write.origin, now, write.status)
        return { outcome: 'created', fact: this.fact(id)! } as FactResult
      }
      const refused = this.staleWrite(current, evidence, write.expectedVersion)
        ?? (current.status === 'confirmed' && status === 'proposed' ? 'keeps-confirmed' : undefined)
      if (refused) return { outcome: 'rejected', reason: refused, fact: current } as FactResult
      // Pre-upgrade aliases are an unsourced baseline; new contributions retain their own evidence.
      if (!this.db.prepare('SELECT 1 FROM learning_fact_versions WHERE fact_id=?').get(current.id)) this.recordFactAliases(current.id, current.aliases, [])
      this.recordFactAliases(current.id, aliasKeys([...(write.aliases ?? []), ...(key !== current.key ? [label] : [])], current.key), this.factSources(evidence))
      const aliases = [...new Set([...current.aliases, ...aliasKeys([...(write.aliases ?? []), ...(key !== current.key ? [label] : [])], current.key)])]
        .filter(alias => alias !== current.key).slice(0, FACT_LIMITS.aliases)
      this.db.prepare('UPDATE facts SET aliases = ? WHERE id = ?').run(JSON.stringify(aliases), current.id)
      // A later reaffirmation is a new version too: delayed writes must not undo the user's latest words.
      if (current.status === status && current.value === value && !this.newerEvidence(current, evidence) && JSON.stringify(aliases) === JSON.stringify(current.aliases)) return { outcome: 'unchanged', fact: this.fact(current.id)! } as FactResult
      this.addVersion(current.id, current.version + 1, status, value, evidence, write.origin, now, write.status)
      return { outcome: 'updated', fact: this.fact(current.id)!, previous: current } as FactResult
    })
  }

  /** The user said a fact no longer holds (or is not decided yet): a new version without a value. */
  retractFact(contextId: string, factId: string, evidence: FactEvidence, origin: FactView['origin'], expectedVersion?: number, now = Date.now()): FactResult {
    if (!this.learningJournal.valid(this.factSources(evidence))) return { outcome: 'rejected', reason: 'excluded-route' }
    return this.inTransaction(() => {
      const current = this.fact(factId)
      if (!current || current.contextId !== contextId || current.deletedAt !== undefined) return { outcome: 'rejected', reason: 'unknown-fact' } as FactResult
      const quoted = { ...evidence, quote: safe(evidence.quote, FACT_LIMITS.quote) }
      const refused = this.staleWrite(current, quoted, expectedVersion)
      if (refused) return { outcome: 'rejected', reason: refused, fact: current } as FactResult
      if (current.status === 'retracted' && !this.newerEvidence(current, quoted)) return { outcome: 'unchanged', fact: current } as FactResult
      this.addVersion(current.id, current.version + 1, 'retracted', null, quoted, origin, now)
      return { outcome: 'retracted', fact: this.fact(current.id)!, previous: current } as FactResult
    })
  }

  /** A fact reached a topic (by routing, a lookup or a change notice): log it and note the version seen. */
  recordDelivery(contextId: string, fact: Pick<FactView, 'id' | 'version'>, via: 'route' | 'lookup' | 'notice', inputId?: string, now = Date.now()): void {
    this.db.prepare('INSERT INTO fact_deliveries (context_id, fact_id, version, input_id, via, at) VALUES (?, ?, ?, ?, ?, ?)').run(contextId, fact.id, fact.version, inputId ?? null, via, now)
    this.db.prepare(`INSERT INTO fact_dependencies VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(context_id, fact_id) DO UPDATE SET version_seen = excluded.version_seen, last_at = excluded.last_at`).run(contextId, fact.id, fact.version, now, now)
    if (via !== 'notice') this.db.prepare('UPDATE facts SET last_used_at = ? WHERE id = ?').run(now, fact.id)
  }

  /** The facts a topic has been given, with the version it last saw. */
  dependencies(contextId: string): { factId: string; versionSeen: number }[] {
    return this.db.prepare('SELECT fact_id, version_seen FROM fact_dependencies WHERE context_id = ? ORDER BY first_at').all(contextId)
      .map(row => ({ factId: String(row.fact_id), versionSeen: Number(row.version_seen) }))
  }

  forgetDependency(contextId: string, factId: string): void {
    this.db.prepare('DELETE FROM fact_dependencies WHERE context_id = ? AND fact_id = ?').run(contextId, factId)
  }

  /** Delivery log of a topic, oldest first. */
  deliveries(contextId: string): { factId: string; version: number; via: string; inputId?: string }[] {
    return this.db.prepare('SELECT * FROM fact_deliveries WHERE context_id = ? ORDER BY id').all(contextId)
      .map(row => ({ factId: String(row.fact_id), version: Number(row.version), via: String(row.via), ...(row.input_id ? { inputId: String(row.input_id) } : {}) }))
  }

  /**
   * Facts of a merged topic move with their identity, so whoever depends on them keeps doing so. A name
   * both topics use stays two facts: the incoming one is renamed after its topic; values never merge.
   */
  private mergeFacts(sourceId: string, targetId: string, sourceTitle: string, journal: MergeJournal): void {
    for (const fact of this.db.prepare('SELECT id, key, label, merged_from FROM facts WHERE context_id = ? AND deleted_at IS NULL').all(sourceId)) {
      journal.facts.push({ id: String(fact.id), key: String(fact.key), label: String(fact.label), mergedFrom: fact.merged_from == null ? null : String(fact.merged_from) })
      let key = String(fact.key), label = String(fact.label)
      if (this.db.prepare('SELECT 1 FROM facts WHERE context_id = ? AND key = ?').get(targetId, key)) {
        label = `${label}（来自 ${sourceTitle}）`.slice(0, FACT_LIMITS.label + 30)
        key = factKey(label)
        for (let n = 2; this.db.prepare('SELECT 1 FROM facts WHERE context_id = ? AND key = ?').get(targetId, key); n++) key = `${factKey(label)} ${n}`
      }
      this.db.prepare('UPDATE facts SET context_id = ?, key = ?, label = ?, merged_from = ? WHERE id = ?').run(targetId, key, label, sourceId, String(fact.id))
    }
    const rowids = (where: string, ...params: string[]) => this.db.prepare(`SELECT rowid AS id FROM fact_dependencies WHERE ${where}`).all(...params).map(row => Number(row.id))
    const before = new Set(rowids('context_id = ?', targetId))
    this.db.prepare('INSERT OR IGNORE INTO fact_dependencies SELECT ?, fact_id, version_seen, first_at, last_at FROM fact_dependencies WHERE context_id = ?').run(targetId, sourceId)
    journal.added.fact_dependencies = rowids('context_id = ?', targetId).filter(id => !before.has(id))
    journal.purged.fact_dependencies = this.db.prepare('SELECT * FROM fact_dependencies WHERE context_id = ?').all(sourceId) as Record<string, unknown>[]
    this.db.prepare('DELETE FROM fact_dependencies WHERE context_id = ?').run(sourceId)
    // A topic does not depend on its own facts.
    journal.removedDependencies = this.db.prepare('SELECT rowid, * FROM fact_dependencies WHERE context_id = ? AND fact_id IN (SELECT id FROM facts WHERE context_id = ?)').all(targetId, targetId) as Record<string, unknown>[]
    this.db.prepare('DELETE FROM fact_dependencies WHERE context_id = ? AND fact_id IN (SELECT id FROM facts WHERE context_id = ?)').run(targetId, targetId)
    journal.moved.fact_deliveries = this.db.prepare('SELECT rowid AS id FROM fact_deliveries WHERE context_id = ?').all(sourceId).map(row => Number(row.id))
    this.db.prepare('UPDATE fact_deliveries SET context_id = ? WHERE context_id = ?').run(targetId, sourceId)
  }

  /**
   * A deleted topic's facts lose their values and evidence; the identity stays as a tombstone so that
   * topics which used them can be told once that they are gone. What the topic itself received goes.
   */
  private purgeFacts(contextId: string, now = Date.now()): void {
    this.db.prepare('DELETE FROM fact_versions WHERE fact_id IN (SELECT id FROM facts WHERE context_id = ?)').run(contextId)
    this.db.prepare("UPDATE facts SET deleted_at = ?, aliases = '[]', current_version = 0 WHERE context_id = ? AND deleted_at IS NULL").run(now, contextId)
    this.db.prepare('DELETE FROM fact_dependencies WHERE context_id = ?').run(contextId)
    this.db.prepare('DELETE FROM fact_deliveries WHERE context_id = ?').run(contextId)
  }

  /** A topic took up a message (one per message); a topic keeps its latest RUNS_KEPT records. */
  startTopicRun(messageId: string, contextId: string, sessionId: string, now = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO topic_runs VALUES (?, ?, ?, 'running', ?, NULL)").run(messageId, contextId, sessionId, now)
    this.db.prepare(`DELETE FROM topic_runs WHERE context_id = ? AND message_id NOT IN
      (SELECT message_id FROM topic_runs WHERE context_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ${RUNS_KEPT})`).run(contextId, contextId)
  }

  /** How the topic's work on a message ended. A record already settled keeps its outcome, except a move. */
  endTopicRun(messageId: string, outcome: Exclude<TopicRun['outcome'], 'running'>, now = Date.now()): void {
    this.db.prepare(`UPDATE topic_runs SET outcome = ?, ended_at = ? WHERE message_id = ? AND (outcome = 'running' OR ? = 'moved')`)
      .run(outcome, now, messageId, outcome)
  }

  /** A run marked interrupted at startup turned out to have finished before the restart. */
  recoverTopicRun(messageId: string, now = Date.now()): void {
    this.db.prepare("UPDATE topic_runs SET outcome = 'completed', ended_at = ? WHERE message_id = ? AND outcome = 'interrupted'").run(now, messageId)
  }

  /** Work never shown (the message was deleted from main chat's queue) leaves no record. */
  dropTopicRun(messageId: string): void {
    this.db.prepare('DELETE FROM topic_runs WHERE message_id = ?').run(messageId)
  }

  /** Work that was running when TheOne stopped (a restart) did not finish: it is interrupted. */
  interruptTopicRuns(now = Date.now()): string[] {
    const rows = this.db.prepare("SELECT message_id FROM topic_runs WHERE outcome = 'running'").all().map(row => String(row.message_id))
    this.db.prepare("UPDATE topic_runs SET outcome = 'interrupted', ended_at = ? WHERE outcome = 'running'").run(now)
    return rows
  }

  topicRun(messageId: string): TopicRun | undefined {
    const row = this.db.prepare('SELECT * FROM topic_runs WHERE message_id = ?').get(messageId)
    return row ? runOf(row) : undefined
  }

  /** The topic's runs, newest first. */
  topicRuns(contextId: string, limit = RUNS_KEPT): TopicRun[] {
    return this.db.prepare('SELECT * FROM topic_runs WHERE context_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(contextId, limit).map(runOf)
  }

  /** The newest run of every topic. */
  latestTopicRuns(): Map<string, TopicRun> {
    const rows = this.db.prepare(`SELECT * FROM topic_runs r WHERE rowid = (SELECT rowid FROM topic_runs WHERE context_id = r.context_id
      ORDER BY started_at DESC, rowid DESC LIMIT 1)`).all()
    return new Map(rows.map(row => [String(row.context_id), runOf(row)]))
  }

  /** The user said the topic's matter is done (`undefined` reopens it). */
  declareTopic(contextId: string, declared: 'done' | undefined, now = Date.now()): void {
    this.context(contextId)
    if (declared) this.db.prepare('INSERT OR REPLACE INTO topic_status VALUES (?, ?, ?)').run(contextId, declared, now)
    else this.db.prepare('DELETE FROM topic_status WHERE context_id = ?').run(contextId)
  }

  declaredTopics(): Map<string, { declared: 'done'; at: number }> {
    return new Map(this.db.prepare('SELECT * FROM topic_status').all().map(row => [String(row.context_id), { declared: 'done' as const, at: Number(row.declared_at) }]))
  }

  /** A changed-files card in main chat (`gatewayId`, `seq`) reads the topic's record (`sessionId`, `seq`). */
  linkChange(gatewayId: string, seq: number, source: { sessionId: string; seq: number; turn: number }): void {
    this.db.prepare('INSERT OR REPLACE INTO change_links VALUES (?, ?, ?, ?, ?)').run(gatewayId, seq, source.sessionId, source.seq, source.turn)
  }

  changeLink(gatewayId: string, seq: number): { sessionId: string; seq: number; turn: number } | undefined {
    const row = this.db.prepare('SELECT session_id, source_seq, turn FROM change_links WHERE gateway_id = ? AND seq = ?').get(gatewayId, seq)
    return row ? { sessionId: String(row.session_id), seq: Number(row.source_seq), turn: Number(row.turn) } : undefined
  }

  /** Notices the user closed; they are not shown again on any browser. */
  dismissNotice(id: string, now = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO dismissed_notices VALUES (?, ?)').run(id, now)
  }

  /** True the first time `name` is marked, false ever after: for one-time repairs. */
  markOnce(name: string, now = Date.now()): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO plugin_flags VALUES (?, ?)').run(name, now).changes === 1
  }

  /** A messaging app bound to main chat (its login, cursor and switch), or undefined when none is. */
  remoteLink<T>(channel: string): T | undefined {
    const row = this.db.prepare('SELECT state FROM remote_links WHERE channel = ?').get(channel)
    return row ? JSON.parse(String(row.state)) as T : undefined
  }

  saveRemoteLink(channel: string, state: unknown): void {
    if (state === undefined) this.db.prepare('DELETE FROM remote_links WHERE channel = ?').run(channel)
    else this.db.prepare('INSERT INTO remote_links VALUES (?, ?) ON CONFLICT(channel) DO UPDATE SET state = excluded.state').run(channel, JSON.stringify(state))
  }

  /** What a correction of `messageId` taught, so undoing it can take exactly that back. */
  recordCorrectionTerms(messageId: string, contextId: string, terms: string[], delta: number): void {
    for (const term of terms) this.db.prepare('INSERT INTO correction_terms VALUES (?, ?, ?, ?)').run(messageId, contextId, term, delta)
  }

  /**
   * Undo the user's move of a message: it belongs where it was first routed again, the terms the move
   * taught are taken back, and the first topic's turn counts as its own again. Returns the topic the
   * message was moved to, or undefined when it was not moved.
   */
  uncorrectRoute(messageId: string, now = Date.now()): string | undefined {
    const row = this.db.prepare('SELECT corrected_to FROM route_details WHERE message_id = ?').get(messageId)
    if (!row?.corrected_to) return undefined
    this.db.exec('SAVEPOINT store_write')
    try {
      this.db.prepare('UPDATE route_details SET corrected_to = NULL, corrected_at = NULL WHERE message_id = ?').run(messageId)
      const journalled = this.learningJournal.audit().some(event => event.kind === 'learnTerms' && event.sources.some(source => source.messageId === messageId))
      if (!journalled) for (const taught of this.db.prepare('SELECT context_id, term, delta FROM correction_terms WHERE message_id = ?').all(messageId))
        this.learnTerms(String(taught.context_id), [String(taught.term)], -Number(taught.delta), now)
      this.db.prepare('DELETE FROM correction_terms WHERE message_id = ?').run(messageId)
      const original = this.route(messageId)?.decision.contextId
      if (original) {
        this.reassignLearning(messageId, original)
        const source = this.learningJournal.source(messageId, original)
        this.db.prepare('UPDATE learning_turns SET revision=? WHERE message_id=? AND context_id=?').run(source.revision, messageId, original)
      }
      this.db.prepare('DELETE FROM misrouted_turns WHERE message_id = ?').run(messageId)
      this.db.prepare("UPDATE topic_runs SET outcome = 'completed' WHERE message_id = ? AND outcome = 'moved'").run(messageId)
      this.db.exec('RELEASE store_write')
      return String(row.corrected_to)
    } catch (error) { this.rollbackWrite(); throw error }
  }

  /** A topic's turn for a message that was not its own: later reads of its history leave it out. */
  recordMisroute(turn: { messageId: string; contextId: string; sessionId: string; startSeq: number; endSeq: number; movedTo: string; request: string; changes?: string[] }, now = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO misrouted_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(turn.messageId, turn.contextId, turn.sessionId, turn.startSeq, turn.endSeq, turn.movedTo, turn.request.slice(0, 600), now)
    this.db.prepare('INSERT OR REPLACE INTO misroute_effects VALUES (?,?,?)').run(turn.messageId, turn.contextId, JSON.stringify(turn.changes ?? []))
  }

  /** Event ranges of a session that belong to other topics' messages. */
  excludedRanges(sessionId: string): { startSeq: number; endSeq: number }[] {
    return [...this.db.prepare('SELECT start_seq, end_seq FROM misrouted_turns WHERE session_id = ?').all(sessionId)
      .map(row => ({ startSeq: Number(row.start_seq), endSeq: Number(row.end_seq) })),
      ...this.learningJournal.turns(sessionId).filter(turn => !this.learningJournal.valid(turn.sources))
        .map(({ startSeq, endSeq }) => ({ startSeq, endSeq }))]
  }

  /** Messages that reached a topic by mistake, oldest first. */
  misroutes(contextId: string): { messageId: string; movedTo: string; request: string }[] {
    return this.db.prepare('SELECT message_id, moved_to, request FROM misrouted_turns WHERE context_id = ? ORDER BY at, rowid').all(contextId)
      .map(row => ({ messageId: String(row.message_id), movedTo: String(row.moved_to), request: String(row.request) }))
  }

  /** `name` was marked with `markOnce`. */
  hasFlag(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM plugin_flags WHERE name = ?').get(name)
  }

  dismissedNotices(): Set<string> {
    return new Set(this.db.prepare('SELECT id FROM dismissed_notices').all().map(row => String(row.id)))
  }

  /**
   * Topics kept in the directory but hidden from routing and briefings: every conversation they can
   * draw on is gone from disk (`orphaned`) or archived in DSH (`archived`). The catalog scan
   * recomputes this set, so restoring a conversation or unarchiving it brings the topic back.
   */
  hiddenReasons(): Map<string, HiddenReason> {
    return new Map(this.db.prepare('SELECT context_id, reason FROM hidden_contexts').all()
      .map(row => [String(row.context_id), String(row.reason) as HiddenReason] as const))
  }

  /**
   * Topics with nothing left to read (every conversation gone from disk). An archived topic is only
   * put away: it still answers when the user comes back to it.
   */
  unreachable(): Set<string> {
    return new Set([...this.hiddenReasons()].filter(([, reason]) => (reason === 'orphaned' || reason === 'excluded')).map(([id]) => id))
  }

  /** Replace the hidden set in one write, so a scan never leaves a stale entry behind. */
  replaceHidden(entries: readonly { id: string; reason: string }[], now = Date.now()): void {
    this.db.exec('SAVEPOINT store_write')
    try {
      this.db.prepare('DELETE FROM hidden_contexts').run()
      const insert = this.db.prepare('INSERT OR REPLACE INTO hidden_contexts VALUES (?, ?, ?)')
      for (const entry of entries) insert.run(entry.id, entry.reason, now)
      this.db.exec('RELEASE store_write')
    } catch (error) { this.rollbackWrite(); throw error }
  }

  close(): void { this.db.close() }
  /** Bind every model-derived write to the input(s) that supplied its evidence. Synchronous only. */
  withLearning<T>(sources: readonly LearningSource[], work: () => T): T { return this.learningJournal.using(sources, work) }

  reassignLearning(messageId: string, contextId: string): void {
    this.inTransaction(() => {
      this.learningJournal.move(messageId, contextId)
      this.reconcileLearningFacts()
      this.rebuildDependencies()
      for (const row of this.db.prepare('SELECT DISTINCT session_id FROM learning_turns').all()) {
        const sessionId = String(row.session_id)
        const excluded = this.excludedRanges(sessionId)
        if (!excluded.length) continue
        for (const range of excluded) {
          this.db.prepare('DELETE FROM history_turns WHERE session_id=? AND user_seq BETWEEN ? AND ?').run(sessionId, range.startSeq, range.endSeq)
          this.db.prepare('DELETE FROM context_source_ranges WHERE session_id=? AND start_seq BETWEEN ? AND ?').run(sessionId, range.startSeq, range.endSeq)
        }
        this.db.prepare("UPDATE history_index SET through_seq=-1 WHERE session_id=? AND status='ready'").run(sessionId)
      }
    })
  }

  /** A rolled-back write may have changed route stages the journal holds in memory. */
  private rollbackWrite(): void { this.db.exec('ROLLBACK TO store_write; RELEASE store_write'); this.learningJournal.forget() }

  wasReassigned(messageId: string): boolean {
    return this.learningJournal.excludedMessage(messageId) || !!this.db.prepare("SELECT 1 FROM learning_routes WHERE message_id=? AND stage='excluded'").get(messageId) ||
      !!this.db.prepare(`SELECT 1 FROM route_details d JOIN routing_events r ON r.message_id=d.message_id
        WHERE d.message_id=? AND d.corrected_to IS NOT NULL AND d.corrected_to!=json_extract(r.decision,'$.contextId')`).get(messageId)
  }

  private learningSnapshot(stream: string): unknown {
    if (stream.startsWith('group:')) return this.db.prepare('SELECT group_id FROM topic_group_members WHERE context_id=?').get(stream.slice(6))?.group_id ?? null
    if (stream.startsWith('link:')) {
      const [a, b] = JSON.parse(stream.slice(5)) as string[]
      return this.db.prepare('SELECT * FROM topic_links WHERE a=? AND b=?').get(a, b) ?? null
    }
    if (stream.startsWith('seen:')) {
      const [reader, source] = JSON.parse(stream.slice(5)) as string[]
      return this.db.prepare('SELECT * FROM briefing_seen WHERE reader=? AND source=?').get(reader, source) ?? null
    }
    const id = stream.slice(6)
    const context = this.lookupContext(id)
    return { descriptor: context && JSON.parse(JSON.stringify(context)), constraints: this.constraints(id) ?? null,
      tables: Object.fromEntries(['topic_names', 'topic_settled', 'topic_open', 'context_state_updates',
        'context_summary_updates', 'compaction_digests', 'learned_terms'].map(table =>
        [table, this.db.prepare(`SELECT * FROM ${table} WHERE context_id=?`).all(id)])) }
  }

  private restoreLearning(stream: string, snapshot: unknown): void {
    if (stream.startsWith('group:')) { this.assignGroup(stream.slice(6), snapshot as string | null); return }
    const insert = (table: string, row: Record<string, string | number | null>) => {
      const keys = Object.keys(row)
      this.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
    }
    if (stream.startsWith('link:') || stream.startsWith('seen:')) {
      const [a, b] = JSON.parse(stream.slice(5)) as string[]
      const link = stream.startsWith('link:')
      this.db.prepare(link ? 'DELETE FROM topic_links WHERE a=? AND b=?' : 'DELETE FROM briefing_seen WHERE reader=? AND source=?').run(a, b)
      if (snapshot) insert(link ? 'topic_links' : 'briefing_seen', snapshot as Record<string, string | number | null>)
      return
    }
    const id = stream.slice(6)
    if (!this.contexts().some(item => item.id === id)) return
    const base = snapshot as { descriptor?: StoredContext; constraints: { text: string; at: number } | null;
      tables: Record<string, Record<string, string | number | null>[]> }
    if (base.descriptor) this.writeDescriptor(base.descriptor)
    this.db.prepare('UPDATE topic_flags SET constraints=?,constraints_at=? WHERE context_id=?')
      .run(base.constraints?.text ?? null, base.constraints?.at ?? null, id)
    for (const [table, rows] of Object.entries(base.tables)) {
      this.db.prepare(`DELETE FROM ${table} WHERE context_id=?`).run(id)
      for (const row of rows) insert(table, row)
    }
  }

  private canShareLearning(sources: readonly LearningSource[]): boolean {
    return this.learningJournal.valid(sources) && sources.every(source => {
      if (this.learningJournal.stage(source) === 'confirmed') return true
      const decision = this.route(source.messageId)?.decision
      return !decision?.alternateIds?.length && !/unclear|fallback/.test(decision?.reason ?? '')
    })
  }

  /** Positive user target confirmation releases verified facts, without waiting for another turn. */
  confirmLearning(messageId: string, contextId: string): void {
    this.learningJournal.settle(messageId, contextId, true)
    for (const fact of this.facts(contextId)) {
      if (fact.status !== 'proposed') continue
      const row = this.db.prepare('SELECT sources,intended FROM learning_fact_versions WHERE fact_id=? AND version=? AND invalid=0').get(fact.id, fact.version)
      if (row?.intended !== 'confirmed') continue
      const sources = JSON.parse(String(row.sources)) as LearningSource[]
      if (!this.canShareLearning(sources)) continue
      this.withLearning(sources, () => this.addVersion(fact.id, fact.version + 1, 'confirmed', fact.value, fact.evidence, fact.origin, Date.now()))
    }
  }

  private mergeLearning(targetId: string, _sourceId: string, snapshot: unknown): void {
    const base = snapshot as { descriptor: StoredContext; constraints: { text: string } | null;
      tables: Record<string, Record<string, string | number | null>[]> }
    const target = this.context(targetId)
    const merged = (a: string[], b: string[]) => [...new Map([...a, ...b].map(term => [term.toLowerCase(), term])).values()].slice(0, 40)
    this.writeDescriptor({ ...target, entities: merged(target.entities, base.descriptor.entities), keywords: merged(target.keywords, base.descriptor.keywords) })
    for (const table of ['context_state_updates', 'context_summary_updates', 'learned_terms', 'topic_names', 'topic_settled']) {
      for (const row of base.tables[table] ?? []) {
        const value = { ...row, context_id: targetId }, keys = Object.keys(value)
        this.db.prepare(`INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(value))
      }
    }
    if (base.constraints) this.setConstraints(targetId, [this.constraints(targetId)?.text, base.constraints.text].filter(Boolean).join('\n').slice(0, 400))
  }

  factLearningSources(factId: string, version: number): LearningSource[] {
    const row = this.db.prepare('SELECT sources FROM learning_fact_versions WHERE fact_id=? AND version=?').get(factId, version)
    return row ? JSON.parse(String(row.sources)) : []
  }

  misrouteEffects(messageId: string): { contextId: string; changes: string[] }[] {
    return this.db.prepare('SELECT context_id,changes FROM misroute_effects WHERE message_id=?').all(messageId)
      .map(row => ({ contextId: String(row.context_id), changes: JSON.parse(String(row.changes)) }))
  }

  private factSources(evidence: FactEvidence): LearningSource[] {
    return uniqueSources([...this.learningJournal.activeSources,
      ...(evidence.seq === null ? [] : this.learningJournal.sources(evidence.sessionId, evidence.seq, evidence.seq)),
      ...(evidence.accepts ? this.learningJournal.sources(evidence.sessionId, evidence.accepts.seq, evidence.accepts.seq) : [])])
  }

  private recordFactAliases(factId: string, aliases: string[], sources: LearningSource[]): void {
    for (const alias of aliases) this.db.prepare('INSERT OR IGNORE INTO learning_fact_aliases VALUES (?,?,?)').run(factId, alias, JSON.stringify(sources))
  }

  /** Repair by appending a version, so readers see a withdrawal/change, never a reused version number. */
  private reconcileLearningFacts(): void {
    const affected = new Set<string>()
    for (const row of this.db.prepare('SELECT * FROM learning_fact_versions WHERE invalid=0').all()) {
      if (this.learningJournal.valid(JSON.parse(String(row.sources)))) continue
      this.db.prepare('UPDATE learning_fact_versions SET invalid=1 WHERE fact_id=? AND version=?').run(String(row.fact_id), Number(row.version))
      affected.add(String(row.fact_id))
    }
    for (const id of affected) {
      const current = this.fact(id)
      if (!current || current.deletedAt !== undefined) continue
      const bad = this.db.prepare('SELECT invalid FROM learning_fact_versions WHERE fact_id=? AND version=?').get(id, current.version)
      const good = this.db.prepare(`SELECT v.version,p.aliases,p.sources FROM fact_versions v LEFT JOIN learning_fact_versions p
        ON p.fact_id=v.fact_id AND p.version=v.version WHERE v.fact_id=? AND COALESCE(p.invalid,0)=0 ORDER BY v.version DESC LIMIT 1`).get(id)
      const previous = bad?.invalid ? good && this.factVersion(id, Number(good.version)) : current
      const aliases = [...new Set(this.db.prepare('SELECT alias,sources FROM learning_fact_aliases WHERE fact_id=? ORDER BY rowid').all(id)
        .filter(row => this.learningJournal.valid(JSON.parse(String(row.sources)))).map(row => String(row.alias)))].slice(0, FACT_LIMITS.aliases)
      if (!bad?.invalid && JSON.stringify(aliases) === JSON.stringify(current.aliases)) continue
      const evidence: FactEvidence = previous?.evidence ?? { sessionId: '', seq: null, speaker: 'unverified', quote: '' }
      this.db.prepare('UPDATE facts SET aliases=? WHERE id=?').run(JSON.stringify(aliases), id)
      this.withLearning(previous ? this.factLearningSources(id, previous.version) : [], () =>
        this.addVersion(id, current.version + 1, previous?.status ?? 'retracted', previous?.value ?? null, evidence, current.origin, Date.now()))
    }
  }

  /** Delivery rows remain audit records; the derived dependencies and usage exclude moved inputs. */
  private rebuildDependencies(): void {
    this.db.exec('DELETE FROM fact_dependencies; UPDATE facts SET last_used_at=NULL')
    for (const row of this.db.prepare('SELECT * FROM fact_deliveries ORDER BY id').all()) {
      if (row.input_id) {
        const source = this.learningJournal.source(String(row.input_id), String(row.context_id))
        if (!this.learningJournal.valid([source])) continue
      }
      this.db.prepare(`INSERT INTO fact_dependencies VALUES (?,?,?,?,?) ON CONFLICT(context_id,fact_id)
        DO UPDATE SET version_seen=excluded.version_seen,last_at=excluded.last_at`)
        .run(String(row.context_id), String(row.fact_id), Number(row.version), Number(row.at), Number(row.at))
      if (row.via !== 'notice') this.db.prepare('UPDATE facts SET last_used_at=? WHERE id=?').run(Number(row.at), String(row.fact_id))
    }
  }

}
