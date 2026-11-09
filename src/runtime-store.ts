import { openDatabase } from './sqlite.ts'
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { DesktopCursor, DesktopEvent, DesktopEventData } from './desktop-events.ts'

/** Local bridge state. Never writes Codex's private databases. */
export class RuntimeStore {
  private db: DatabaseSync
  constructor(path: string, busyTimeoutMs = 5000) {
    this.db = openDatabase(path, busyTimeoutMs)
    this.db.exec(`CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS execution_locks (resource TEXT PRIMARY KEY, run_id TEXT NOT NULL);`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, gateway TEXT, at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS desktop_events_scope ON desktop_events(gateway,seq);`)
    this.db.prepare('INSERT OR IGNORE INTO records VALUES (?,?,?)').run('desktop-epoch', 'main', JSON.stringify(randomUUID()))
    this.db.exec(`CREATE INDEX IF NOT EXISTS desktop_run_activity ON records
      (json_extract(body,'$.gatewayId'),json_extract(body,'$.updatedAt') DESC) WHERE kind='run'`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS native_history_thread ON records (json_extract(body,'$.hostThreadId'))
      WHERE kind='message' AND json_extract(body,'$.nativeHistory')=1`)
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(String(row.body)) as T : undefined
  }
  all<T>(kind: string): T[] {
    return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(String(r.body)) as T)
  }
  appendEvent(event: DesktopEventData, gatewayId: string | null = null) {
    this.db.prepare('INSERT INTO desktop_events(gateway,at,body) VALUES (?,?,?)').run(gatewayId, Date.now(), JSON.stringify(event))
    this.db.exec('DELETE FROM desktop_events WHERE seq <= (SELECT MAX(seq)-2048 FROM desktop_events)')
  }
  events(gatewayId: string | null, previous?: DesktopCursor) {
    const epoch = this.get<string>('desktop-epoch', 'main')!
    const bounds = this.db.prepare('SELECT MIN(seq) AS floor, MAX(seq) AS last FROM desktop_events').get()!
    const seq = Number(bounds.last ?? 0), eventFloor = Number(bounds.floor ?? 1)
    const reset = !previous || previous.epoch !== epoch || previous.gatewayId !== gatewayId || previous.seq > seq || previous.seq < eventFloor - 1
    const events: DesktopEvent[] = reset ? [] : this.db.prepare('SELECT * FROM desktop_events WHERE seq>? AND (gateway IS NULL OR gateway=?) ORDER BY seq').all(previous!.seq, gatewayId)
      .map(row => ({ ...JSON.parse(String(row.body)), seq: Number(row.seq), at: Number(row.at), gatewayId: row.gateway == null ? null : String(row.gateway) }))
    return { cursor: { epoch, seq, gatewayId }, eventFloor, reset, events }
  }
  /** Read this chat's projection references without decoding unrelated message bodies. */
  nativeMessageRefs(threadId: string) {
    return this.db.prepare(`SELECT id,json_extract(body,'$.topicId') AS topicId,json_extract(body,'$.historyFingerprint') AS fingerprint
      FROM records WHERE kind='message' AND json_extract(body,'$.nativeHistory')=1 AND json_extract(body,'$.hostThreadId')=?`)
      .all(threadId).map(row => ({ id: String(row.id), topicId: String(row.topicId), fingerprint: row.fingerprint == null ? null : String(row.fingerprint) }))
  }
  /** Sidebar polling reads indexed metadata, never the potentially large run transcript. */
  activity(gatewayId: string, limit = 40) {
    return this.db.prepare(`SELECT id,
      json_extract(body,'$.topicId') AS topicId, json_extract(body,'$.status') AS status,
      json_extract(body,'$.updatedAt') AS updatedAt, json_extract(body,'$.delivered') AS delivered,
      json_extract(body,'$.at') AS startedAt, json_extract(body,'$.queueReason') AS queueReason,
      json_extract(body,'$.waitingKind') AS waitingKind, json_extract(body,'$.steeringOf') AS steeringOf,
      json_array_length(body,'$.approvals') AS pendingApprovals
      FROM records WHERE kind='run' AND json_extract(body,'$.gatewayId')=?
      ORDER BY json_extract(body,'$.updatedAt') DESC LIMIT ?`).all(gatewayId, limit)
      .map(row => ({ id: String(row.id), topicId: String(row.topicId), status: String(row.status),
        updatedAt: Number(row.updatedAt), delivered: !!row.delivered, pendingApprovals: Number(row.pendingApprovals ?? 0),
        startedAt: row.startedAt == null ? undefined : Number(row.startedAt), queueReason: row.queueReason ?? undefined,
        waitingKind: row.waitingKind ?? undefined, source: row.steeringOf ? 'steering' : 'user' }))
  }
  put(kind: string, id: string, body: unknown): void {
    this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, id, JSON.stringify(body))
  }
  remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id) }
  trim(kind: string, limit: number): void { this.db.prepare('DELETE FROM records WHERE kind=? AND rowid NOT IN (SELECT rowid FROM records WHERE kind=? ORDER BY rowid DESC LIMIT ?)').run(kind, kind, limit) }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  lock(resources: string[], runId: string): boolean {
    return this.transaction(() => {
      const normalize = (value: string) => {
        const path = value.slice('workspace:'.length).replace(/\\/g, '/').replace(/\/$/, '')
        return process.platform === 'win32' ? path.toLowerCase() : path
      }
      const held = this.db.prepare('SELECT resource,run_id FROM execution_locks').all()
      for (const resource of resources) {
        for (const row of held) {
          if (row.run_id === runId) continue
          const other = String(row.resource)
          if (resource === other) return false
          if (resource.startsWith('workspace:') && other.startsWith('workspace:')) {
            const a = normalize(resource), b = normalize(other)
            if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) return false
          }
        }
      }
      for (const resource of resources) this.db.prepare('INSERT OR IGNORE INTO execution_locks VALUES (?,?)').run(resource, runId)
      return true
    })
  }
  unlock(runId: string): void { this.db.prepare('DELETE FROM execution_locks WHERE run_id=?').run(runId) }
  close(): void { this.db.close() }
}
