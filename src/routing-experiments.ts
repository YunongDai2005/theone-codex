import { createHash } from 'node:crypto'
import { routingPrompt, RouterFailure, type RoutingPayload, type RecentMessage } from './llm-router.ts'

export const ROUTING_VARIANTS = ['none', 'snapshot', 'compact', 'snapshot+compact'] as const
export type RoutingVariant = typeof ROUTING_VARIANTS[number]
export function routingVariant(value: unknown = 'none'): RoutingVariant {
  if (!ROUTING_VARIANTS.includes(value as RoutingVariant)) throw new Error('Invalid routing variant: ' + value)
  return value as RoutingVariant
}

/** Same proxy as eval/prefix-share; a size budget, never provider token accounting. */
function tokens(text: string): number {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).join('').length
  return han / 1.5 + (text.length - han) / 4
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
type SnapshotPayload = RoutingPayload & { contexts: (RoutingPayload['contexts'][number] & { routeId?: string })[] }
interface Overlay {
  contexts?: { remove: string[]; upsert: SnapshotPayload['contexts']; order?: string[] }
  recent?: { drop: number; append: RecentMessage[] }
  set?: Record<string, unknown>
  unset?: string[]
}
export interface SnapshotWire { protocol: 'snapshot-v1'; epoch: number; snapshot: SnapshotPayload; overlay: Overlay[] }
interface SnapshotState { wire: SnapshotWire; latest: SnapshotPayload }

function difference(before: SnapshotPayload, after: SnapshotPayload): Overlay {
  const patch: Overlay = {}
  if (!same(before.contexts, after.contexts)) {
    const old = new Map(before.contexts.map(row => [row.id, row]))
    const ids = after.contexts.map(row => row.id)
    patch.contexts = { remove: before.contexts.filter(row => !ids.includes(row.id)).map(row => row.id),
      upsert: after.contexts.filter(row => !same(old.get(row.id), row)),
      ...(!same(before.contexts.map(row => row.id), ids) ? { order: ids } : {}) }
  }
  if (!same(before.recent, after.recent)) {
    let keep = Math.min(before.recent.length, after.recent.length)
    while (keep && !same(before.recent.slice(-keep), after.recent.slice(0, keep))) keep--
    patch.recent = { drop: before.recent.length - keep, append: after.recent.slice(keep) }
  }
  const a = before as unknown as Record<string, unknown>, b = after as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'contexts' || key === 'recent' || same(a[key], b[key])) continue
    if (!(key in b)) (patch.unset ??= []).push(key)
    else (patch.set ??= {})[key] = b[key]
  }
  return patch
}

/** Materialize from the immutable trunk, applying every overlay from left to right. */
export function materializeSnapshot(wire: SnapshotWire): SnapshotPayload {
  const result = structuredClone(wire.snapshot)
  for (const patch of wire.overlay) {
    if (patch.contexts) {
      const rows = new Map(result.contexts.map(row => [row.id, row]))
      for (const id of patch.contexts.remove) rows.delete(id)
      for (const row of patch.contexts.upsert) rows.set(row.id, structuredClone(row))
      result.contexts = patch.contexts.order ? patch.contexts.order.map(id => rows.get(id)!) : [...rows.values()]
    }
    if (patch.recent) result.recent = [...result.recent.slice(patch.recent.drop), ...structuredClone(patch.recent.append)]
    for (const key of patch.unset ?? []) delete (result as unknown as Record<string, unknown>)[key]
    Object.assign(result, structuredClone(patch.set ?? {}))
  }
  return result
}

/** Per gateway session, shared synchronously by quick/recheck/review. Eviction only causes a cold epoch. */
export class SnapshotCache {
  private sessions = new Map<string, SnapshotState>()
  private sequence = 0
  constructor(private readonly limits: Partial<{ overlayRatio: number; minOverlayTokens: number; maxChars: number; sessions: number }> = {}) {}

  prepare(payload: SnapshotPayload, session?: string): SnapshotWire {
    const limits = { overlayRatio: 0.5, minOverlayTokens: 512, maxChars: 32000, sessions: 64, ...this.limits }
    const previous = session ? this.sessions.get(session) : undefined
    let wire: SnapshotWire | undefined
    if (previous) {
      const patch = difference(previous.latest, payload)
      wire = { ...previous.wire, overlay: [...previous.wire.overlay, ...(Object.keys(patch).length ? [patch] : [])] }
      if (tokens(JSON.stringify(wire.overlay)) > Math.max(limits.minOverlayTokens, limits.overlayRatio * tokens(JSON.stringify(wire.snapshot)))
        || JSON.stringify(wire).length > limits.maxChars) wire = undefined
    }
    wire ??= { protocol: 'snapshot-v1', epoch: ++this.sequence, snapshot: structuredClone(payload), overlay: [] }
    if (session) {
      this.sessions.delete(session)
      this.sessions.set(session, { wire, latest: structuredClone(payload) })
      if (this.sessions.size > limits.sessions) this.sessions.delete(this.sessions.keys().next().value!)
    }
    return structuredClone(wire)
  }
}

/** Content-derived aliases never get reassigned on a new epoch; only this request's candidates are valid. */
export function compactPayload(payload: RoutingPayload): { payload: SnapshotPayload; aliases: Map<string, string> } {
  const aliases = new Map<string, string>()
  const contexts = payload.contexts.map(row => {
    const routeId = row.id.length > 16 ? '@' + createHash('sha256').update(row.id).digest('hex').slice(0, 12) : row.id
    if (aliases.has(routeId) && aliases.get(routeId) !== row.id) throw new RouterFailure('ROUTER_COMPACT_ID_INVALID')
    aliases.set(routeId, row.id)
    return { ...row, routeId }
  })
  return { payload: { ...payload, contexts }, aliases }
}

type DecisionRow = Record<string, unknown>
function object(value: unknown): DecisionRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouterFailure('ROUTER_INVALID_DECISION')
  return value as DecisionRow
}
function mapIds(row: DecisionRow, mapping: Map<string, string>): DecisionRow {
  // currentId stays a full id in the payload, so a model may answer with an offered full id; that is unambiguous.
  const offered = new Set(mapping.values())
  const lookup = (id: unknown) => {
    if (typeof id === 'string' && mapping.has(id)) return mapping.get(id)!
    if (typeof id === 'string' && offered.has(id)) return id
    throw new RouterFailure('ROUTER_COMPACT_ID_INVALID')
  }
  const result = { ...row }
  if (result.contextId != null) result.contextId = lookup(result.contextId)
  for (const key of ['relatedIds', 'candidateIds']) if (result[key] != null) {
    if (!Array.isArray(result[key])) throw new RouterFailure('ROUTER_INVALID_DECISION')
    result[key] = result[key].map(lookup)
  }
  return result
}

/** Omit only protocol defaults. False, nonempty optional fields and an explicit reason are preserved. */
export function compressDecision(value: unknown, aliases: Map<string, string>): DecisionRow {
  const row = mapIds(object(value), new Map([...aliases].map(([short, full]) => [full, short])))
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => value != null
    && !(Array.isArray(value) && !value.length) && !(key === 'reason' && value === 'match')))
}
export function expandDecision(value: unknown, aliases: Map<string, string>): DecisionRow {
  const row = mapIds(object(value), aliases)
  return { ...row, reason: row.reason === undefined ? 'match' : row.reason }
}

const SNAPSHOT_PROMPT = '\n输入使用 snapshot-v1：snapshot 是 epoch 开始时的完整输入，overlay 按从左到右依次覆盖，同一 id 或字段以最后一次为准；contexts.remove 删除、upsert 新增或整条替换（合并表现为删除旧 id 并更新目标），order 是完整有效候选顺序，recent.drop 删除开头消息后 append 追加，unset 删除字段，set 整个替换字段。只对物化后的最新有效输入作判断（包括 text、recent、currentId、attention、recheck 和纠正），不得使用已删除的候选或被覆盖的旧值。'
const COMPACT_PROMPT = '\n使用 compact-v1 稀疏 JSON：已有话题通常只输出 {"action":"EXISTING","contextId":"该候选的routeId"}。CREATE 必须给 title，historyIndependent 仍按上述规则判断；aside 只在 CREATE 且为 true 时输出，一次性小问题用法同上；CLARIFY 必须给 question，需要多候选时给 candidateIds；relatedIds、imports、projectId 只在有实际值时输出，省略所有空数组和 null。contextId、relatedIds、candidateIds 只能用本次有效 contexts 中的 routeId，imports/projectId 仍用原 id；理由可省略（本地补 match）或用几个字，复核也使用本协议。'

export class RoutingExperiments {
  private snapshots = new SnapshotCache()
  prepare(payload: RoutingPayload, variant: RoutingVariant = 'none', session?: string) {
    routingVariant(variant)
    const snapshot = variant.includes('snapshot'), compact = variant.includes('compact')
    let system = routingPrompt(snapshot ? { attention: true } : payload)
    if (compact) system = system.replace(/输出 JSON：[\s\S]*?。\n不得编造目录ID。/, '不得编造目录ID。')
      .replace('没有 symbols 就输出空数组。', '没有 symbols 时省略 imports。')
      .replace('其他动作或没有 projects 时 projectId 为 null。', '其他动作或没有 projects 时省略 projectId。') + COMPACT_PROMPT
    if (snapshot) system += SNAPSHOT_PROMPT
    const encoded = compact ? compactPayload(payload) : { payload, aliases: new Map<string, string>() }
    const wire = snapshot ? this.snapshots.prepare(encoded.payload, session) : encoded.payload
    return { system, user: JSON.stringify(wire), decode: (value: unknown) => compact ? expandDecision(value, encoded.aliases) : value }
  }
}
