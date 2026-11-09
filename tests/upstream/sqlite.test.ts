import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../src/sqlite.ts'
import { ContextStore } from '../../src/store.ts'
import { WorkStore } from '../../src/work-store.ts'
import { RoutingBindings } from '../../src/routing-bindings.ts'
import { RoutingShadow } from '../../src/routing-shadow.ts'

const pragma = (path: string, name: string) => {
  const db = new DatabaseSync(path)
  try { return db.prepare(`PRAGMA ${name}`).get()?.[name] } finally { db.close() }
}

test('every TheOne database opens in WAL and keeps what was written across a reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'theone-wal-'))
  try {
    const path = join(root, 'contexts.db')
    const store = new ContextStore(path)
    const id = store.createTopic('读书会筹备')
    store.close()
    const work = new WorkStore(`${path}.work.db`); work.close()
    const bindings = new RoutingBindings(`${path}.bindings.db`, 'default', () => true); bindings.close()
    const shadow = new RoutingShadow(`${path}.shadow.db`); shadow.close()
    for (const file of [path, `${path}.work.db`, `${path}.bindings.db`, `${path}.shadow.db`])
      assert.equal(pragma(file, 'journal_mode'), 'wal', file)
    const reopened = new ContextStore(path)
    try { assert.ok(reopened.contexts().some(context => context.id === id)) } finally { reopened.close() }
    const db = openDatabase(path, 100)
    try { assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 1) } finally { db.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a database another connection holds stays in its mode and keeps full sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'theone-wal-'))
  try {
    const path = join(root, 'held.db')
    const holder = new DatabaseSync(path)
    holder.exec('CREATE TABLE t (x); BEGIN IMMEDIATE; INSERT INTO t VALUES (1)')
    const db = openDatabase(path, 0)
    try {
      assert.notEqual(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal')
      assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 2)
    } finally { db.close(); holder.exec('ROLLBACK'); holder.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
