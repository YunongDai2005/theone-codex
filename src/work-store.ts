import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './sqlite.ts'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type WorkState = 'queued' | 'running' | 'paused' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export interface WorkInput { key: string; kind: string; resource: string; payload: unknown }
export interface WorkJob extends WorkInput {
  id: string; state: WorkState; due: number; created: number; runs: number; failures: number
  token?: string; leaseUntil?: number; candidate?: unknown; result?: unknown; error?: string
}
export interface WorkNotice { id: string; jobId: string; text: string; at: number }
const decode = (row: Record<string, unknown>): WorkJob => ({
  ...JSON.parse(String(row.body)), id: String(row.id), state: row.state as WorkState,
  due: Number(row.due), created: Number(row.created), runs: Number(row.runs), failures: Number(row.failures),
  ...(row.token == null ? {} : { token: String(row.token), leaseUntil: Number(row.lease_until) }),
  ...(row.candidate == null ? {} : { candidate: JSON.parse(String(row.candidate)) }),
  ...(row.result == null ? {} : { result: JSON.parse(String(row.result)) }),
  ...(row.error == null ? {} : { error: String(row.error) }),
})

/** Durable work is kept separate from the user's DSH session log. */
export class WorkStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = openDatabase(path, 5000)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE, resource TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL, due INTEGER NOT NULL, created INTEGER NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        token TEXT, lease_until INTEGER, candidate TEXT, result TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS work_due ON work_items(state, due);
      CREATE TABLE IF NOT EXISTS work_events (job_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(job_id,event_id));
      CREATE TABLE IF NOT EXISTS work_notices (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL,
        at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(job_id,fingerprint)
      );`)
  }
  enqueue(input: WorkInput, now = Date.now()): WorkJob {
    this.db.prepare("INSERT OR IGNORE INTO work_items(id,dedupe,resource,body,state,due,created) VALUES(?,?,?,?,'queued',?,?)")
      .run(randomUUID(), input.key, input.resource, JSON.stringify(input), now, now)
    return decode(this.db.prepare('SELECT * FROM work_items WHERE dedupe=?').get(input.key)!)
  }
  list(): WorkJob[] { return this.db.prepare('SELECT * FROM work_items ORDER BY created,id').all().map(decode) }
  get(id: string): WorkJob | undefined { const row = this.db.prepare('SELECT * FROM work_items WHERE id=?').get(id); return row && decode(row) }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  claim(now = Date.now(), leaseMs = 90000, exclude: string[] = []): WorkJob | undefined {
    return this.transaction(() => {
      // Every job in this queue is read-only research or an idempotent memory merge.
      this.db.prepare("UPDATE work_items SET state='queued',token=NULL,lease_until=NULL WHERE state='running' AND lease_until<=?").run(now)
      const row = this.db.prepare(`SELECT a.* FROM work_items a WHERE a.state='queued' AND a.due<=?
        AND NOT EXISTS (SELECT 1 FROM work_items b WHERE b.resource=a.resource AND b.state='running')
        ${exclude.length ? `AND a.id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
        ORDER BY a.due,a.created,a.rowid LIMIT 1`).get(now, ...exclude)
      if (!row) return undefined
      this.db.prepare("UPDATE work_items SET state='running',token=?,lease_until=?,runs=runs+1 WHERE id=?")
        .run(randomUUID(), now + leaseMs, String(row.id))
      return this.get(String(row.id))
    })
  }
  owns(job: WorkJob, now = Date.now()): boolean {
    const current = this.get(job.id)
    return !!job.token && current?.state === 'running' && current.token === job.token && current.leaseUntil! > now
  }
  checkpoint(job: WorkJob, candidate: unknown, now = Date.now()): boolean {
    return !!this.db.prepare("UPDATE work_items SET candidate=? WHERE id=? AND token=? AND state='running' AND lease_until>?")
      .run(JSON.stringify(candidate), job.id, job.token ?? '', now).changes
  }
  finish(job: WorkJob, result: unknown, nextAt?: number, notice?: { fingerprint: string; text: string }, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(job, now)) return false
      this.db.prepare('UPDATE work_items SET state=?,due=?,result=?,candidate=NULL,error=NULL,failures=0,token=NULL,lease_until=NULL WHERE id=?')
        .run(nextAt === undefined ? 'completed' : 'queued', nextAt ?? now, JSON.stringify(result ?? null), job.id)
      if (notice) this.db.prepare('INSERT OR IGNORE INTO work_notices(id,job_id,fingerprint,text,at) VALUES(?,?,?,?,?)')
        .run(randomUUID(), job.id, notice.fingerprint, notice.text.slice(0, 6000), now)
      return true
    })
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'wake', now = Date.now()): boolean {
    const states = action === 'resume' ? ['paused', 'waiting', 'failed'] : action === 'wake' ? ['queued'] : ['queued', 'running', 'paused', 'waiting', 'failed']
    const target = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'queued'
    return !!this.db.prepare(`UPDATE work_items SET state=?,due=?,token=NULL,lease_until=NULL WHERE id=? AND state IN (${states.map(() => '?').join(',')})`)
      .run(target, now, id, ...states).changes
  }
  wake(id: string, eventId: string, now = Date.now()): boolean {
    return this.transaction(() => {
      if (this.get(id)?.state !== 'queued') return false
      const inserted = this.db.prepare('INSERT OR IGNORE INTO work_events(job_id,event_id) VALUES(?,?)').run(id, eventId)
      return !!inserted.changes && this.control(id, 'wake', now)
    })
  }
  fail(job: WorkJob, error: string, now = Date.now()): void {
    if (!this.owns(job, now)) return
    const failures = job.failures + 1
    this.db.prepare("UPDATE work_items SET state=?,due=?,failures=?,error=?,token=NULL,lease_until=NULL WHERE id=? AND token=? AND state='running' AND lease_until>?")
      .run(failures >= 3 ? 'failed' : 'queued', now + Math.min(3600000, 30000 * 2 ** (failures - 1)), failures, error.slice(0, 160), job.id, job.token!, now)
  }
  wait(job: WorkJob, reason: string, now = Date.now()): void {
    this.db.prepare("UPDATE work_items SET state='waiting',error=?,token=NULL,lease_until=NULL WHERE id=? AND token=? AND state='running' AND lease_until>?").run(reason, job.id, job.token ?? '', now)
  }
  release(job: WorkJob, now = Date.now()): void {
    this.db.prepare("UPDATE work_items SET state='queued',token=NULL,lease_until=NULL WHERE id=? AND token=? AND state='running' AND lease_until>?").run(job.id, job.token ?? '', now)
  }
  pendingNotices(): WorkNotice[] {
    return this.db.prepare(`SELECT n.* FROM work_notices n JOIN work_items w ON w.id=n.job_id
      WHERE n.delivered=0 AND w.state NOT IN ('paused','cancelled') ORDER BY n.at,n.rowid LIMIT 100`).all()
      .map(row => ({ id: String(row.id), jobId: String(row.job_id), text: String(row.text), at: Number(row.at) }))
  }
  delivered(id: string): void { this.db.prepare('UPDATE work_notices SET delivered=1 WHERE id=?').run(id) }
  attention(job: WorkJob, text: string, now = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO work_notices(id,job_id,fingerprint,text,at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), job.id, `attention:${job.state}:${job.error ?? ''}:${job.failures}`, text.slice(0, 6000), now)
  }
  close(): void { this.db.close() }
}
