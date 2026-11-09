import { DatabaseSync } from 'node:sqlite'

/** Opens one of TheOne's databases in WAL. A commit then no longer waits for the disk, which was most of a message's
 * local time (207 → 16 ms p50 on the fake-model replay). The busy wait is set first because switching needs a moment
 * alone with the file. If another connection holds it or the file system cannot share memory (a network drive), the
 * database stays in its current mode, and keeps full sync there: NORMAL is only crash-safe under WAL. */
export function openDatabase(path: string, busyMs: number): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = ${busyMs}`)
  if (path === ':memory:') return db
  let mode: unknown
  try { mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode } catch {}
  if (mode === 'wal') db.exec('PRAGMA synchronous = NORMAL')
  return db
}
