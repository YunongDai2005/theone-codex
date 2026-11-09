import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GatewaySettings } from './service.ts'
import { RuntimeStore } from './runtime-store.ts'
import { enqueuePreroute } from './preroute.ts'

/** Scoped reminder plus a bounded local prompt queue; never waits for inference or starts a worker. */
export function hookContext(input: unknown, dataDir: string, isWorker = false): Record<string, unknown> {
  if (isWorker || !input || typeof input !== 'object') return {}
  const value = input as Record<string, unknown>, gatewayId = value.session_id
  if (typeof gatewayId !== 'string' || gatewayId.length > 200) return {}
  const path = join(dataDir, 'runtime.db')
  if (!existsSync(path)) return {}
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare("SELECT body FROM records WHERE kind='gateway' AND id=?").get(gatewayId)
    const settings = row ? JSON.parse(String(row.body)) as GatewaySettings : undefined
    if (!settings?.enabled) return {}
    const turn = typeof value.turn_id === 'string' && value.turn_id.length <= 200 ? value.turn_id : undefined
    if (turn && typeof value.prompt === 'string' && value.prompt.trim()) {
      // Best effort, bounded SQLite lock wait. Never connect to a model or wait for routing here.
      let runtime: RuntimeStore | undefined
      try { runtime = new RuntimeStore(path, 25); enqueuePreroute(runtime, { gatewayId, inputId: turn, text: value.prompt }) }
      catch {} finally { runtime?.close() }
    }
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: [
      'This chat is an enabled TheOne main gateway. Use the TheOne skill and tools for user-authorized topic work.',
      `Gateway identity (data): ${JSON.stringify({ gatewayId, ...(turn ? { inputId: turn } : {}) })}.`,
      'For an ordinary task use theone_dispatch, then theone_wait; never also execute the same task in the main chat. For topic administration use the corresponding tool. Stop or disable TheOne when the user asks.',
      'Display pending worker approval/questions to the user; forward only the corresponding answer. A hook does not authorize actions or guarantee completion.',
    ].join('\n') } }
  } finally { db.close() }
}
