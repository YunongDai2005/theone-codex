import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './sqlite.ts'

/** Positions are native session sequence numbers, ordered across main-chat sessions.
 * They describe display order, never whether the user has read a message. */
export type DisplayOrder = [session: number, event: number]
export type MessageOrigin = 'user' | 'foreground' | 'background' | 'system'
export interface ShadowMessage {
  messageId: string
  sessionId: string
  seq: number
  topicId: string | null
  source: MessageOrigin
  displayOrder: DisplayOrder
  visible?: boolean
  replyTo?: string
  temporary?: boolean
  basis?: string
  completed?: boolean
}
interface Focus { topicId: string; messageId: string; inputId: string; order: DisplayOrder; responseOrder?: DisplayOrder }
interface ShadowState { focus?: Focus; durableTopicId?: string; durableFocus?: Focus; temporary?: { messageId: string; returnFocus?: Focus } }
export interface PendingOwner {
  topicId: string
  kind: 'question' | 'approval'
  messageId?: string
  basis: 'host-request' | 'question-form'
}
type Binding = { topicId: string | null; temporary?: boolean; basis?: string; source?: MessageOrigin }
const compare = (a: DisplayOrder, b: DisplayOrder) => a[0] - b[0] || a[1] - b[1]

/** Conservative lexical detection of a self-contained arithmetic aside; no shadow state is read. */
export function temporaryArithmetic(text: string): boolean {
  const expression = text.trim().replace(/^(?:(?:顺便问(?:一下)?|插一句)[，,:：\s]*)?(?:计算(?:一下)?|算(?:一下)?|what is|calculate)?\s*/i, '')
    .replace(/(?:等于多少|是多少)?[?？。.!！\s]*$/, '').trim()
  return /^-?\d+(?:\.\d+)?(?:\s*[+\-*/×÷]\s*-?\d+(?:\.\d+)?)+$/.test(expression)
}

/** Separate durable metadata only. No caller may use this to construct routing inputs.
 * No message text, credentials, model payloads or executable actions are stored here. */
export class RoutingShadow {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = openDatabase(path, 100)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shadow_sessions (gateway TEXT, session TEXT, ordinal INTEGER, PRIMARY KEY(gateway,session));
      CREATE TABLE IF NOT EXISTS shadow_messages (gateway TEXT, session TEXT, message TEXT, ordinal INTEGER, seq INTEGER, value TEXT, PRIMARY KEY(gateway,session,message));
      CREATE TABLE IF NOT EXISTS shadow_bindings (gateway TEXT, session TEXT, message TEXT, value TEXT, PRIMARY KEY(gateway,session,message));
      CREATE TABLE IF NOT EXISTS shadow_state (gateway TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS shadow_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, gateway TEXT, value TEXT, closed INTEGER DEFAULT 0);
    `)
  }
  close(): void { this.db.close() }
  private state(gateway: string): ShadowState {
    const row = this.db.prepare('SELECT value FROM shadow_state WHERE gateway=?').get(gateway)
    return row ? JSON.parse(String(row.value)) : {}
  }
  private save(gateway: string, state: ShadowState): void {
    this.db.prepare('INSERT INTO shadow_state VALUES (?,?) ON CONFLICT(gateway) DO UPDATE SET value=excluded.value').run(gateway, JSON.stringify(state))
  }
  private ordinal(gateway: string, session: string): number {
    const row = this.db.prepare('SELECT ordinal FROM shadow_sessions WHERE gateway=? AND session=?').get(gateway, session)
    if (row) return Number(row.ordinal)
    const next = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM shadow_sessions WHERE gateway=?').get(gateway)!.n)
    this.db.prepare('INSERT INTO shadow_sessions VALUES (?,?,?)').run(gateway, session, next)
    return next
  }
  message(gateway: string, session: string, message: string): ShadowMessage | undefined {
    const row = this.db.prepare('SELECT value FROM shadow_messages WHERE gateway=? AND session=? AND message=?').get(gateway, session, message)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  binding(gateway: string, session: string, message: string): Binding | undefined {
    const row = this.db.prepare('SELECT value FROM shadow_bindings WHERE gateway=? AND session=? AND message=?').get(gateway, session, message)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  /** A route may be planned before the host commits the corresponding user event. */
  bind(gateway: string, session: string, message: string, binding: Binding): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO shadow_bindings VALUES (?,?,?,?) ON CONFLICT(gateway,session,message) DO UPDATE SET value=excluded.value')
        .run(gateway, session, message, JSON.stringify(binding))
      const previous = this.message(gateway, session, message)
      if (previous) {
        const updated = { ...previous, ...binding }
        this.db.prepare('UPDATE shadow_messages SET value=? WHERE gateway=? AND session=? AND message=?').run(JSON.stringify(updated), gateway, session, message)
        this.advance(gateway, updated)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  record(gateway: string, input: Omit<ShadowMessage, 'displayOrder'>): void {
    if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new Error('Invalid shadow sequence')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.message(gateway, input.sessionId, input.messageId)) {
        const ordinal = input.visible === false ? 0 : this.ordinal(gateway, input.sessionId)
        const message: ShadowMessage = { ...input, ...this.binding(gateway, input.sessionId, input.messageId), displayOrder: [ordinal, input.seq] }
        this.db.prepare('INSERT INTO shadow_messages VALUES (?,?,?,?,?,?)').run(gateway, input.sessionId, input.messageId, ordinal, input.seq, JSON.stringify(message))
        this.advance(gateway, message)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private advance(gateway: string, message: ShadowMessage): void {
    if (!message.topicId || message.visible === false || !['user', 'foreground'].includes(message.source)) return
    const state = this.state(gateway)
    if (message.source === 'user') {
      if (state.focus && (compare(message.displayOrder, state.focus.order) < 0 || compare(message.displayOrder, state.focus.order) === 0 && state.focus.messageId !== message.messageId)) return
      if (message.temporary) state.temporary = { messageId: message.messageId, returnFocus: state.durableFocus ?? state.focus }
      else { delete state.temporary; state.durableTopicId = message.topicId }
      state.focus = { topicId: message.topicId, messageId: message.messageId, inputId: message.messageId, order: message.displayOrder }
      if (!message.temporary) state.durableFocus = { ...state.focus }
    } else {
      // A reply belongs to its triggering input, even if newer user messages or
      // background notifications were inserted before it finished.
      const anchor = message.replyTo && this.message(gateway, message.sessionId, message.replyTo)
      if (!anchor || !state.focus || anchor.messageId !== state.focus.inputId || compare(anchor.displayOrder, state.focus.order) < 0) return
      if (compare(message.displayOrder, state.focus.responseOrder ?? state.focus.order) < 0) return
      state.focus.messageId = message.messageId
      state.focus.responseOrder = message.displayOrder
      if (message.completed && state.temporary?.messageId === anchor.messageId) {
        const restored = state.temporary.returnFocus
        if (restored) state.focus = { ...restored, order: message.displayOrder }
        delete state.temporary
      } else if (!state.temporary) state.durableFocus = { ...state.focus }
    }
    this.save(gateway, state)
  }
  hasPending(gateway: string, messageId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM shadow_pending WHERE gateway=? AND json_extract(value, '$.messageId')=? LIMIT 1").get(gateway, messageId)
  }
  openPending(gateway: string, owner: PendingOwner): string {
    const row = this.db.prepare('INSERT INTO shadow_pending(gateway,value) VALUES (?,?)').run(gateway, JSON.stringify(owner))
    return String(row.lastInsertRowid)
  }
  closePending(gateway: string, id: string): void {
    this.db.prepare('UPDATE shadow_pending SET closed=1 WHERE gateway=? AND id=?').run(gateway, id)
  }
  snapshot(gateway: string) {
    const records = this.db.prepare('SELECT value FROM shadow_messages WHERE gateway=? ORDER BY ordinal,seq').all(gateway)
      .map(row => JSON.parse(String(row.value)) as ShadowMessage)
    return { ...this.state(gateway), messages: records.filter(message => message.visible !== false), background: records.filter(message => message.visible === false),
      pending: this.db.prepare('SELECT id,value FROM shadow_pending WHERE gateway=? AND closed=0 ORDER BY id').all(gateway)
        .map(row => ({ id: String(row.id), ...JSON.parse(String(row.value)) as PendingOwner })) }
  }
}
