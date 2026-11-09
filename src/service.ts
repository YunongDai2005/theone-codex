import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ContextStore } from './store.ts'
import { RuntimeStore } from './runtime-store.ts'
import { resolveContext } from './router.ts'
import { verify, findQuote, retracts, type FactKind } from './facts.ts'
import { mayShare, relatedTopics, topicDigest, type LinkScope } from './linkage.ts'
import type { WorkerBackend, WorkerEvent, WorkerConfig, WorkerAttachment, Approval } from './backend.ts'
import { validAttachment } from './backend.ts'
import type { Decision } from './types.ts'
import { projectKey } from './project-queue.ts'
import { RouterFailure, redactRoutingText, type RoutingRouter, type RoutingInput, type RouterReceipt } from './llm-router.ts'
import { decideWithReview } from './routing-flow.ts'
import { normalizeTopicLabel, bubbleLabel } from './topic-label.ts'
import { recommendedRouterModel, validateRouterModel, type RouterModelSettings } from './router-model-settings.ts'
import { factCandidates, factDelivery } from './fact-flow.ts'
import { HistoryCatalog, type CatalogOptions } from './history-catalog.ts'
import { Preroutes, type PrerouteInput } from './preroute.ts'
import { TopicMerges } from './topic-merges.ts'
import type { DesktopCursor } from './desktop-events.ts'
import { continuesCurrent, resumesWork, newIndependentTopic, settleUnclear } from './routing-policy.ts'
import { ReleaseChecker } from './update-check.ts'

export interface GatewaySettings {
  gatewayId: string; workspace: string; sandbox: WorkerConfig['sandbox']; model?: string
  effort?: WorkerConfig['effort']; linkScope: LinkScope; enabled: boolean
  routerMode: 'rules' | 'model' | 'auto'
}
export interface Message {
  id: string; topicId: string; role: 'user' | 'assistant'; text: string; at: number
  source: 'gateway' | 'codex' | 'import'; runId?: string; hostThreadId?: string; hostTurnId?: string
}
export type RoutingProposal = ({ topicId: string; newTopic?: never } | { newTopic: { title: string; label: string }; topicId?: never }) & { confidence: 'high' | 'low' }
export interface RouteInput { gatewayId: string; inputId: string; text: string; topicId?: string; proposal?: RoutingProposal; catalogVersion?: string; foreground?: boolean; attachments?: WorkerAttachment[] }
export interface RouteResult { inputId: string; topicId?: string; decision: Decision; routingError?: string; receipt: RouterReceipt }
export type RunStatus = 'queued' | 'starting' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export interface Run {
  id: string; gatewayId: string; inputId: string; topicId: string; cwd: string; text: string
  status: RunStatus; at: number; updatedAt: number; owner: string; pid: number
  threadId?: string; turnId?: string; error?: string; progress?: string
  approvals: Approval[]; output: { id: string; text: string; phase?: string }[]; delivered: boolean
  requestedSandbox?: WorkerConfig['sandbox']
  foreground?: boolean; attachments?: WorkerAttachment[]; steeringOf?: string
  queueReason?: 'topic_busy' | 'project_busy'; waitingKind?: 'question' | 'approval'
}
interface TemporaryTopic { topicId: string; gatewayId: string; returnTopicId?: string; inputId: string }
interface ForegroundReply { messageId: string; topicId: string; returnTopicId?: string }
interface InputRecord extends RouteInput { key: string; result?: RouteResult; routingOwner?: string; pid?: number; at?: number }
interface Binding { topicId: string; threadId: string; cwd: string }
const terminal = new Set<RunStatus>(['completed', 'failed', 'interrupted', 'cancelled'])
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const keyOf = (gateway: string, input: string) => hash(JSON.stringify([gateway, input]))
const bounded = (value: string, max: number, code: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(code)
  return value
}
const canonical = (path: string) => {
  const absolute = realpathSync.native(resolve(path))
  if (!statSync(absolute).isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY')
  return absolute
}
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
const within = (root: string, path: string) => { const rel = relative(pathKey(root), pathKey(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' } }
const historySchema = z.object({ version: z.literal(1), source: z.string().max(200).optional(), topics: z.array(z.object({
  id: z.string().min(1).max(200), title: z.string().min(1).max(80), summary: z.string().max(12000).optional(), private: z.boolean().optional(),
  messages: z.array(z.object({ id: z.string().min(1).max(200), role: z.enum(['user','assistant']), text: z.string().max(100000), at: z.number().optional() })).max(10000),
})).max(10000) })

export class TheOneService {
  readonly store: ContextStore
  readonly runtime: RuntimeStore
  readonly catalog?: HistoryCatalog
  private owner = randomUUID()
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private routing = new Map<string, Promise<RouteResult>>()
  private lifetime = new AbortController()
  private preroutes: Preroutes
  private topicMerges: TopicMerges
  private suggestionsDirty = true
  private releaseChecker = new ReleaseChecker('0.1.0-alpha.9')
  checkUpdates(force = false) { return this.releaseChecker.check(force) }
  constructor(private options: { dataDir: string; backend?: WorkerBackend; router?: RoutingRouter; catalog?: CatalogOptions }) {
    mkdirSync(options.dataDir, { recursive: true })
    this.store = new ContextStore(join(options.dataDir, 'topics.db'))
    this.runtime = new RuntimeStore(join(options.dataDir, 'runtime.db'))
    this.preroutes = new Preroutes(this.runtime, (entry, signal) => this.computeRoute({ ...entry, inputId: entry.inputId ?? entry.key }, this.settings(entry.gatewayId), entry.key, true, true, signal), this.lifetime.signal)
    this.topicMerges = new TopicMerges(this.runtime, this.store, { visible: id => this.visible(id),
      busy: (...ids) => this.runs().some(r => ids.includes(r.topicId) && !terminal.has(r.status)), merge: (source, target) => { this.merge(source, target, false) },
      vettingEnabled: gatewayId => { const s = this.runtime.get<GatewaySettings>('gateway', gatewayId); return !!s?.enabled && s.routerMode !== 'rules' },
      idle: () => !this.stopped && !this.routing.size && !this.preroutes.pending() && !this.runs().some(r => !terminal.has(r.status)),
      ...(options.router?.vetMerges ? { vet: (pairs, signal) => options.router!.vetMerges!(pairs, signal, this.runtime.get<RouterModelSettings>('router-model-settings', 'main')) } : {}) })
    if (options.catalog) this.catalog = new HistoryCatalog(this.store, this.runtime, options.catalog)
    this.recover()
    let ticks = 0; this.timer = setInterval(() => {
      if (++ticks % 10 === 0) this.recover()
      this.preroutes.drain(); this.drainMerges(); this.pump()
      if (this.suggestionsDirty || ticks % 20 === 0) { this.suggestionsDirty = false; for (const gateway of this.runtime.all<GatewaySettings>('gateway')) if (gateway.enabled) this.detectSuggestions(gateway.gatewayId) }
      void this.topicMerges.tickVetting().catch(() => {})
    }, 500); this.timer.unref()
  }
  preroute(input: PrerouteInput) {
    if (!this.settings(input.gatewayId).enabled) throw Error('GATEWAY_DISABLED')
    this.topicMerges.interrupt()
    return this.preroutes.enqueue(input)
  }
  configure(gatewayId: string, change: Partial<Omit<GatewaySettings, 'gatewayId'>> & { workspace?: string }): GatewaySettings {
    bounded(gatewayId, 200, 'GATEWAY_INVALID')
    const old = this.runtime.get<GatewaySettings>('gateway', gatewayId)
    if (!change.workspace && !old) throw new Error('WORKSPACE_REQUIRED')
    const settings: GatewaySettings = { sandbox: 'read-only', linkScope: 'auto', routerMode: 'auto', enabled: true, ...old, ...change, gatewayId, workspace: canonical(change.workspace ?? old!.workspace) }
    if (!['read-only','workspace-write'].includes(settings.sandbox)) throw new Error('SANDBOX_INVALID')
    if (!['rules','model','auto'].includes(settings.routerMode)) throw new Error('ROUTER_MODE_INVALID')
    if (settings.routerMode === 'model' && !this.options.router) throw new Error('MODEL_ROUTER_NOT_CONFIGURED')
    this.runtime.put('gateway', gatewayId, settings)
    if (old && (old.enabled !== settings.enabled || old.routerMode !== settings.routerMode || old.linkScope !== settings.linkScope || old.workspace !== settings.workspace)) this.preroutes.invalidate(gatewayId)
    this.topicMerges.interrupt(); this.suggestionsDirty = true
    return settings
  }
  settings(gatewayId: string): GatewaySettings {
    const settings = this.runtime.get<GatewaySettings>('gateway', gatewayId)
    if (!settings) throw new Error('GATEWAY_NOT_CONFIGURED')
    return settings
  }
  async routerModels() {
    if (!this.options.router?.models) throw Error('ROUTER_MODEL_SETTINGS_UNAVAILABLE')
    const models = await this.options.router.models(), recommended = recommendedRouterModel(models)
    return { models, recommendedModel: recommended?.model ?? null,
      selection: this.runtime.get<RouterModelSettings>('router-model-settings', 'main') ?? recommended }
  }
  async configureRouterModel(selection: RouterModelSettings) {
    const { models } = await this.routerModels(), { settings } = validateRouterModel(selection, models)
    this.runtime.put('router-model-settings', 'main', settings)
    this.topicMerges.interrupt()
    return settings
  }
  status() { return { version: '0.1.0-alpha.9', gateways: this.runtime.all<GatewaySettings>('gateway'), topics: this.listTopics().length, runs: this.runs(), merges: this.store.merges(), groups: this.store.groups() } }
  desktopBind(profileId: string, gatewayId: string, workspace: string, topicId?: string) {
    bounded(profileId, 500, 'DESKTOP_PROFILE_INVALID')
    const existing = this.runtime.get<{ gatewayId: string }>('desktop-main', profileId)
    if (existing && existing.gatewayId !== gatewayId) throw new Error('DESKTOP_GATEWAY_ALREADY_BOUND')
    const configured = this.runtime.get<GatewaySettings>('gateway', gatewayId)
    if (configured && pathKey(configured.workspace) !== pathKey(canonical(workspace))) throw new Error('GATEWAY_WORKSPACE_MISMATCH')
    if (topicId !== undefined) { this.context(topicId); if (!this.visible(topicId)) throw new Error('TOPIC_EXCLUDED') }
    // Binding a UI identity cannot broaden or silently re-enable existing permissions.
    if (!configured) this.configure(gatewayId, { workspace })
    this.runtime.put('desktop-main', profileId, { gatewayId })
    if (topicId !== undefined) this.selectTopic(gatewayId, topicId)
    return this.desktopSnapshot(profileId)
  }
  desktopSnapshot(profileId: string, cursor?: DesktopCursor) {
    bounded(profileId, 500, 'DESKTOP_PROFILE_INVALID')
    const binding = this.runtime.get<{ gatewayId: string }>('desktop-main', profileId)
    const settings = binding && this.runtime.get<GatewaySettings>('gateway', binding.gatewayId)
    const topics = this.listTopics().map(topic => ({ id: topic.id, title: topic.title, label: bubbleLabel(topic), private: topic.private, done: topic.done,
      summary: topic.summary?.slice(0, 240), threadId: topic.threadId, sourceThreadIds: topic.sourceThreadIds,
      oneOff: !!this.runtime.get('temporary-topic', topic.id) }))
    const selected = settings && this.store.current(settings.gatewayId)
    const operations = this.topicMerges.operations()
    const shown = new Set(topics.map(t => t.id))
    return { version: '0.1.0-alpha.9', ...this.runtime.events(settings?.gatewayId ?? null, cursor),
      gateway: settings ? { ...settings, currentTopicId: topics.some(t => t.id === selected) ? selected! : null } : null,
      topics, merges: this.store.merges(), activity: settings ? this.runtime.activity(settings.gatewayId) : [],
      pendingMerges: operations.filter(op => ['queued','executing'].includes(op.state) && shown.has(op.sourceId) && shown.has(op.targetId)),
      mergeReceipts: operations.filter(op => !['queued','executing'].includes(op.state)),
      suggestions: settings ? this.topicMerges.suggestions(settings.gatewayId) : [],
      clarification: settings ? this.runtime.get<{ candidateIds: string[] }>('clarification', settings.gatewayId) : undefined,
      catalog: this.catalog?.status() ?? { available: false } }
  }
  selectTopic(gatewayId: string, topicId: string | null) {
    if (!this.settings(gatewayId).enabled) throw new Error('GATEWAY_DISABLED')
    if (topicId === null) this.store.unmount(gatewayId)
    else {
      this.context(topicId)
      if (!this.visible(topicId)) throw new Error('TOPIC_EXCLUDED')
      this.store.mount(gatewayId, topicId)
    }
    this.runtime.appendEvent({ type: 'topic.changed', contextId: topicId ?? '' }, gatewayId)
    this.runtime.remove('foreground', gatewayId)
    return { gatewayId, currentTopicId: this.store.current(gatewayId) ?? null }
  }
  private context(id: string) { const context = this.store.contexts().find(c => c.id === id); if (!context) throw new Error('TOPIC_NOT_FOUND'); return context }
  listTopics(readerTopicId?: string) {
    if (readerTopicId) this.context(readerTopicId)
    return this.store.contexts().filter(c => this.visible(c.id, readerTopicId)).map(c => ({ ...c, private: this.store.isPrivate(c.id), done: this.store.declaredTopics().has(c.id), threadId: this.runtime.get<Binding>('binding', c.id)?.threadId,
      sourceThreadIds: this.store.sources(c.id).filter(id => this.runtime.get('catalog-session', id) && this.catalog?.messageAllowed({ nativeHistory: true, hostThreadId: id })) }))
  }
  private visible(id: string, reader?: string, scope: LinkScope = 'auto'): boolean {
    if (this.runtime.get<boolean>('excluded', id)) return false
    if (this.store.unreachable().has(id)) return false
    if (reader) return reader === id || mayShare(this.store, scope, id, reader) === undefined
    return true // An explicit directory/history request by the main gateway may inspect its own library.
  }
  private routingTopics(settings: GatewaySettings, currentId = this.store.current(settings.gatewayId)) {
    const reader = currentId && this.visible(currentId) ? currentId : undefined
    return this.store.contexts().filter(c => this.visible(c.id, reader, settings.linkScope) && (c.id === reader || !this.store.isPrivate(c.id)))
  }
  private proposalDecision(proposal: RoutingProposal | undefined, routing: RoutingInput, rules: Decision): Decision | undefined {
    if (!proposal || proposal.confidence !== 'high' || !!proposal.topicId === !!proposal.newTopic) return
    let decision: Decision
    if (proposal.newTopic) {
      const title = proposal.newTopic.title?.trim()
      if (!title || title.length > 80) return
      // Same title means the same topic; never recreate an unavailable/private topic by name.
      const same = this.store.contexts().filter(t => t.title.trim().toLowerCase() === title.toLowerCase())
      if (same.length) {
        if (same.length !== 1 || !routing.contexts.some(t => t.id === same[0].id)) return
        decision = { action: same[0].id === routing.currentId ? 'KEEP' : routing.currentId ? 'SWAP' : 'MOUNT', contextId: same[0].id, reason: 'main-model-proposal' }
      } else {
        const label = normalizeTopicLabel(proposal.newTopic.label)
        decision = { action: 'CREATE', title, ...(label ? { label } : {}), reason: 'main-model-proposal' }
      }
    } else {
      if (!routing.contexts.some(t => t.id === proposal.topicId)) return
      decision = { action: proposal.topicId === routing.currentId ? 'KEEP' : routing.currentId ? 'SWAP' : 'MOUNT', contextId: proposal.topicId, reason: 'main-model-proposal' }
    }
    if (rules.reason === 'explicit-new-topic') return
    if (['entity-or-keyword','combined-contexts'].includes(rules.reason) && rules.contextId !== decision.contextId) return
    if (rules.contextId === decision.contextId && rules.relatedIds) decision.relatedIds = rules.relatedIds
    return decision
  }
  private dispatchCatalog(input: RouteInput) {
    const settings = this.settings(input.gatewayId)
    const topics = this.routingTopics(settings).map(t => ({ id: t.id, title: redactRoutingText(t.title).slice(0, 80), label: bubbleLabel(t) }))
    const catalogVersion = hash(JSON.stringify(topics)), catalog: typeof topics = []
    let size = 2
    for (const topic of topics) {
      const length = JSON.stringify(topic).length + 1
      if (catalog.length >= 80 || size + length > 12000) break
      catalog.push(topic); size += length
    }
    // Only the caller knows whether it still holds the catalog (a new chat or compaction drops it), so omit it only on its word.
    const unchanged = input.catalogVersion === catalogVersion
    return { catalogVersion, catalogTruncated: catalog.length < topics.length, ...(unchanged ? {} : { catalog }) }
  }
  createTopic(title: string, summary?: string) { const id = this.store.createTopic(title, summary); this.suggestionsDirty = true; this.runtime.appendEvent({ type: 'topic.changed', contextId: id }); return id }
  manageTopic(id: string, change: { title?: string; summary?: string; lastState?: string; private?: boolean; constraints?: string | null; done?: boolean; excluded?: boolean; group?: string | null }) {
    this.context(id)
    this.store.editTopic(id, change)
    if (change.private !== undefined) this.store.setPrivate(id, change.private)
    if (change.constraints !== undefined) this.store.setConstraints(id, change.constraints)
    if (change.done !== undefined) this.store.declareTopic(id, change.done ? 'done' : undefined)
    if (change.excluded !== undefined) {
      this.runtime.put('excluded', id, change.excluded)
      const hidden = this.store.hiddenReasons(); hidden.delete(id)
      if (change.excluded) hidden.set(id, 'excluded')
      this.store.replaceHidden([...hidden].map(([id, reason]) => ({ id, reason })))
    }
    if (change.group !== undefined) this.store.moveTopic(id, change.group === null ? null : { title: change.group })
    this.suggestionsDirty = true; this.runtime.appendEvent({ type: 'topic.changed', contextId: id })
    return this.context(id)
  }
  async route(input: RouteInput, preview = false): Promise<RouteResult> {
    this.topicMerges.interrupt()
    const settings = this.settings(input.gatewayId)
    if (!settings.enabled) throw new Error('GATEWAY_DISABLED')
    bounded(input.inputId, 200, 'INPUT_ID_INVALID')
    if (!input.attachments?.length) bounded(input.text, 100000, 'INPUT_TEXT_INVALID')
    else if (typeof input.text !== 'string' || input.text.length > 100000 || input.attachments.length > 20 || input.attachments.some(a => !validAttachment(a))) throw Error('INPUT_ATTACHMENTS_INVALID')
    const key = keyOf(input.gatewayId, input.inputId)
    const existing = this.runtime.get<InputRecord>('input', key)
    if (existing && (existing.text !== input.text || existing.topicId !== input.topicId || JSON.stringify(existing.attachments) !== JSON.stringify(input.attachments) || (existing.foreground !== false) !== (input.foreground !== false))) throw new Error('INPUT_CONFLICT')
    if (existing?.result) return existing.result
    if (this.routing.has(key)) return this.routing.get(key)!
    if (!preview) this.runtime.transaction(() => {
      const pending = this.runtime.get<InputRecord>('input', key)
      if (pending && (pending.text !== input.text || pending.topicId !== input.topicId)) throw new Error('INPUT_CONFLICT')
      if (pending?.routingOwner && pending.routingOwner !== this.owner && pending.pid && alive(pending.pid) && Date.now()-(pending.at ?? 0) < 60000) throw new Error('ROUTING_IN_PROGRESS_RETRY_SAME_INPUT')
      this.runtime.put('input', key, { ...input, key, routingOwner: this.owner, pid: process.pid, at: Date.now() })
    })
    const operation = this.computeRoute(input, settings, key, preview).finally(() => this.routing.delete(key))
    this.routing.set(key, operation)
    return operation
  }
  private async computeRoute(input: RouteInput, settings: GatewaySettings, key: string, preview: boolean, speculative = false, signal = this.lifetime.signal): Promise<RouteResult> {
    if (!settings.enabled) throw Error('GATEWAY_DISABLED')
    const started = Date.now()
    let decision: Decision
    let routingError: string | undefined, receipt: RouterReceipt = { mode: 'rules', source: 'rules', calls: 0 }
    const pre = !speculative && !preview && input.text.trim() ? this.preroutes.take(input) : undefined
    if (input.topicId) { if (pre) this.preroutes.discard(pre); this.context(input.topicId); if (!this.visible(input.topicId)) throw new Error('TOPIC_EXCLUDED'); decision = { action: 'MOUNT', contextId: input.topicId, reason: 'explicit-topic' }; receipt.source = 'explicit' }
    else {
      const currentId = this.store.current(input.gatewayId)
      const routingInput: RoutingInput = { text: input.text, contexts: this.routingTopics(settings, currentId), currentId, corrections: this.store.corrections(input.gatewayId),
        recent: currentId && this.visible(currentId) ? this.messages(this.topicIds(currentId)).slice(-4).map(m => ({ role: m.role, text: m.text })) : [] }
      const available = new Set(routingInput.contexts.map(t => t.id)), allRuns = this.runs(input.gatewayId)
      const running = allRuns.find(r => r.topicId === currentId && !r.steeringOf && ['starting','running','waiting_approval'].includes(r.status))
      if (running) routingInput.running = { topicId: running.topicId, request: running.text, progress: running.progress ?? running.output.at(-1)?.text ?? '' }
      const front = this.runtime.get<ForegroundReply>('foreground', input.gatewayId)
      const foreground = front && available.has(front.topicId) ? front : undefined
      const pending = allRuns.filter(r => r.status === 'waiting_approval' && !r.steeringOf && available.has(r.topicId)).flatMap(r => r.approvals.filter(a => a.expiresAt > Date.now()).map(a => ({ id: a.id, topicId: r.topicId, kind: a.method === 'item/tool/requestUserInput' ? 'question' as const : 'approval' as const })))
      routingInput.attention = { foreground, background: allRuns.filter(r => r.status === 'completed' && r.foreground === false && available.has(r.topicId)).slice(-3).map(r => ({ messageId: r.inputId, topicId: r.topicId })), pending: pending.slice(0, 8), pendingOverflow: pending.length > 8 }
      routingInput.facts = factCandidates(this.store, settings.linkScope, input.text, [], currentId)
      decision = resolveContext(input.text, routingInput.contexts, currentId)
      const proposal = settings.routerMode === 'auto' ? this.proposalDecision(input.proposal, routingInput, decision) : undefined
      const returning = resumesWork(input.text) && foreground?.returnTopicId === currentId && !!currentId && available.has(currentId)
      const frontId = returning ? currentId : foreground?.topicId
      const conflict = pending.length > 1 || pending.length === 1 && !!frontId && frontId !== pending[0].topicId
      const fastId = !conflict && (pending[0]?.topicId ?? frontId ?? currentId)
      const attachmentOnly = !input.text.trim() && !!input.attachments?.length
      const fast = attachmentOnly ? currentId && available.has(currentId) ? { action: 'KEEP' as const, contextId: currentId, reason: 'attachment-only' } : newIndependentTopic('附件', routingInput.contexts, 'attachment-only')
        : continuesCurrent(input.text) && fastId && available.has(fastId) ? { action: fastId === currentId ? 'KEEP' as const : 'MOUNT' as const, contextId: fastId,
          reason: returning ? 'continuation-temporary-return' : pending.length ? 'continuation-pending' : frontId ? 'continuation-foreground' : 'short-continuation' } : undefined
      if (pre && (pre.result || !proposal)) {
        const waiting = Date.now()
        try {
          const cached = pre.result ?? await this.preroutes.wait(pre)
          decision = structuredClone(cached.decision); routingError = cached.routingError
          receipt = { ...cached.receipt, source: 'preroute', waitMs: pre.result ? 0 : Date.now() - waiting }
          const available = this.routingTopics(this.settings(input.gatewayId))
          if (decision.contextId && !available.some(t => t.id === decision.contextId)) throw Error('ROUTER_STALE_TOPIC')
          decision.relatedIds = decision.relatedIds?.filter(id => available.some(t => t.id === id))
          decision.alternateIds = decision.alternateIds?.filter(id => available.some(t => t.id === id))
        } catch (error) {
          this.lifetime.signal.throwIfAborted()
          routingError = error instanceof Error ? error.message : 'ROUTER_UNAVAILABLE'
          decision = resolveContext(input.text, this.routingTopics(this.settings(input.gatewayId)), this.store.current(input.gatewayId))
          receipt = { mode: 'rules', source: 'fallback', calls: 0, waitMs: Date.now() - waiting, errorCode: routingError }
        }
      }
      else if (proposal) { decision = proposal; receipt.source = 'proposal'; receipt.waitMs = 0; if (pre) this.preroutes.shadow(pre, input.inputId, proposal) }
      else if (fast) { decision = fast; receipt.source = 'rules' }
      else if (settings.routerMode !== 'rules' && decision.reason !== 'explicit-new-topic') {
        try {
          if (!this.options.router) throw new RouterFailure('MODEL_ROUTER_NOT_CONFIGURED')
          const result = await decideWithReview(this.options.router, routingInput, signal,
            { modelSettings: this.runtime.get<RouterModelSettings>('router-model-settings', 'main') })
          decision = result.decision
          receipt = result.receipt
          const available = this.routingTopics(settings, currentId)
          if (decision.contextId && !available.some(t => t.id === decision.contextId)) throw new RouterFailure('ROUTER_STALE_TOPIC')
          decision.relatedIds = decision.relatedIds?.filter(id => available.some(t => t.id === id))
        } catch (error) {
          this.lifetime.signal.throwIfAborted()
          routingError = error instanceof RouterFailure ? error.code : error instanceof Error && /^(ROUTER_|TimeoutError)/.test(error.message) ? error.message.slice(0, 100) : 'ROUTER_UNAVAILABLE'
          decision = resolveContext(input.text, this.routingTopics(settings, currentId), currentId)
          const failureReceipt = (error as { receipt?: RouterReceipt })?.receipt
          receipt = { ...(failureReceipt ?? receipt), mode: 'rules', source: 'fallback', errorCode: routingError }
        }
      }
      decision = settleUnclear(decision, input.text, this.routingTopics(this.settings(input.gatewayId)), this.store.current(input.gatewayId))
    }
    // Permissions and visibility may change while a model or shared preroute is pending.
    settings = this.settings(input.gatewayId)
    if (!settings.enabled) throw Error('GATEWAY_DISABLED')
    const latest = this.routingTopics(settings)
    if (!input.topicId && decision.contextId && !latest.some(t => t.id === decision.contextId)) {
      decision = resolveContext(input.text, latest, this.store.current(input.gatewayId))
      routingError = 'ROUTER_STALE_TOPIC'; receipt = { ...receipt, source: 'fallback', errorCode: routingError }
    }
    decision.relatedIds = decision.relatedIds?.filter(id => latest.some(t => t.id === id))
    decision.alternateIds = decision.alternateIds?.filter(id => latest.some(t => t.id === id))
    if (decision.action === 'CREATE' && decision.aside) receipt.temporary = { returnTopicId: this.store.current(input.gatewayId), sources: [] }
    receipt.elapsedMs = Date.now() - started
    if (preview) return { inputId: input.inputId, topicId: decision.contextId, decision, receipt, ...(routingError ? { routingError } : {}) }
    const planned = this.store.plan(key, input.gatewayId, input.gatewayId, { ...decision, ...(decision.action === 'CREATE' ? { folder: settings.workspace } : {}) }, !receipt.temporary && input.foreground !== false)
    const result = { inputId: input.inputId, topicId: planned.decision.contextId, decision: planned.decision, receipt, ...(routingError ? { routingError } : {}) }
    this.runtime.put('input', key, { ...input, key, result })
    this.store.recordRouteDetail(key, input.text.slice(0, 200), receipt)
    if (result.topicId) this.runtime.put('message', key, { id: key, topicId: result.topicId, role: 'user', text: input.text, at: Date.now(), source: 'gateway' } satisfies Message)
    if (result.topicId) {
      this.store.declareTopic(result.topicId, undefined)
      if (receipt.temporary) this.runtime.put('temporary-topic', result.topicId, { topicId: result.topicId, gatewayId: input.gatewayId, returnTopicId: receipt.temporary.returnTopicId, inputId: input.inputId } satisfies TemporaryTopic)
      else this.runtime.remove('temporary-topic', result.topicId)
      if (this.runtime.get('clarification', input.gatewayId)) {
        this.runtime.remove('clarification', input.gatewayId); this.runtime.appendEvent({ type: 'route.resolved', contextId: result.topicId }, input.gatewayId)
      }
      this.runtime.appendEvent({ type: 'route.assigned', workItemId: key, messageIds: [input.inputId], contextId: result.topicId,
        created: decision.action === 'CREATE', alternateIds: decision.alternateIds ?? [], source: this.steerTarget(input.gatewayId, result.topicId) ? 'steering' : 'user' }, input.gatewayId)
      if (decision.action === 'CREATE') { this.suggestionsDirty = true; this.detectSuggestions(input.gatewayId) }
    } else {
      const candidateIds = decision.alternateIds ?? decision.relatedIds ?? []
      this.runtime.put('clarification', input.gatewayId, { candidateIds })
      this.runtime.appendEvent({ type: 'route.blocked', candidateIds }, input.gatewayId)
    }
    return result
  }
  private topicIds(id: string): Set<string> {
    const ids = new Set([id]); let changed = true
    while (changed) { changed = false; for (const m of this.runtime.all<{ sourceId: string; targetId: string }>('merge')) if (ids.has(m.targetId) && !ids.has(m.sourceId)) { ids.add(m.sourceId); changed = true } }
    return ids
  }
  readTopic(id: string, readerTopicId?: string) {
    const context = this.context(id)
    if (!this.visible(id, readerTopicId)) throw new Error('TOPIC_PRIVATE_OR_EXCLUDED')
    const ids = this.topicIds(id)
    return { ...context, constraints: this.store.constraints(id), facts: this.store.facts(id), messages: this.messages(ids) }
  }
  private messages(ids: Set<string>) { return this.runtime.all<Message>('message').filter(m => ids.has(m.topicId) && (this.catalog?.messageAllowed(m) ?? true)).sort((a,b) => a.at-b.at) }
  search(query: string, readerTopicId?: string, limit = 30) {
    bounded(query, 1000, 'QUERY_INVALID')
    const allowed = new Set(this.listTopics(readerTopicId).flatMap(t => [...this.topicIds(t.id)]))
    const needle = query.normalize('NFKC').toLowerCase()
    return this.runtime.all<Message>('message').filter(m => allowed.has(m.topicId) && (this.catalog?.messageAllowed(m) ?? true) && m.text.normalize('NFKC').toLowerCase().includes(needle)).slice(-Math.max(1, Math.min(limit, 100))).map(m => ({ ...m, text: m.text.slice(0, 6000) }))
  }
  briefing(id: string, scope: LinkScope = 'auto'): string { return this.referencePacket(id, scope).text }
  private referencePacket(id: string, scope: LinkScope, inputId?: string) {
    const topic = this.context(id)
    const others = relatedTopics(this.store, id, scope).filter(t => this.visible(t.id, id, scope))
    const history = this.messages(this.topicIds(id)).slice(-12).map(m => ({ id: m.id, topicId: m.topicId, role: m.role, source: m.source, text: m.text.slice(0, 600) }))
    const imports = [...(inputId ? this.store.route(inputId)?.decision.imports ?? [] : []), ...others.flatMap(t => this.store.facts(t.id).filter(f => f.status === 'confirmed').slice(0, 5).map(f => f.id))]
    const delivery = factDelivery(this.store, scope, id, imports, inputId)
    const text = JSON.stringify({ referenceOnly: true, topic: { id, title: topic.title, digest: topicDigest(this.store, topic, 2000), constraints: this.store.constraints(id)?.text, recentHistory: history, facts: this.store.facts(id, true).slice(0, 20) },
      related: others.map(t => ({ id: t.id, title: t.title, digest: topicDigest(this.store, this.context(t.id), 600) })), sharedFacts: delivery.facts, changes: delivery.notices })
    return { text, commit: delivery.commit }
  }
  lookupFacts(query: string, readerTopicId: string, scope: LinkScope = 'auto') {
    this.context(readerTopicId)
    const candidates = factCandidates(this.store, scope, query, [], readerTopicId).flatMap(candidate => {
      const fact = this.store.fact(candidate.id)
      return fact && this.visible(fact.contextId, readerTopicId, scope) ? [{ ...fact, topicTitle: candidate.topic }] : []
    }).slice(0, 10)
    for (const f of candidates) this.store.recordDelivery(readerTopicId, f, 'lookup')
    return candidates
  }
  recordFact(id: string, input: { label: string; value: string; quote: string; kind?: FactKind; acceptsQuote?: string; factId?: string; expectedVersion?: number }) {
    const messages = this.readTopic(id).messages
    const verdict = verify({ sessionId: `theone:${id}`, events: messages.map((m, seq) => ({ seq, speaker: m.role, text: m.source === 'import' ? '' : m.text })), kind: input.kind ?? 'fact', value: input.value, quote: input.quote, acceptsQuote: input.acceptsQuote })
    return this.store.recordFact(id, { ...input, kind: input.kind ?? 'fact', ...verdict, origin: 'worker' })
  }
  retractFact(id: string, factId: string, quote: string, expectedVersion?: number) {
    const events = this.readTopic(id).messages.map((m, seq) => ({ seq, speaker: m.role, text: m.source === 'import' ? '' : m.text }))
    const evidence = findQuote(events, quote, { speaker: 'user' })
    if (!evidence || !retracts(quote) || !retracts(evidence.text)) throw new Error('WITHDRAWAL_EVIDENCE_REQUIRED')
    return this.store.retractFact(id, factId, { sessionId: `theone:${id}`, seq: evidence.seq, speaker: 'user', quote }, 'worker', expectedVersion)
  }
  link(a: string, b: string, value: -1 | 0 | 1) { this.context(a); this.context(b); this.store.setManualLink(a, b, value); return this.store.links(a) }
  private idle(...ids: string[]) { if (this.runs().some(r => ids.includes(r.topicId) && !terminal.has(r.status))) throw Object.assign(new Error('TOPIC_BUSY'), { statusCode: 409 }) }
  requestMerge(source: string, target: string, requestId: string = randomUUID()) { return this.topicMerges.request(source, target, bounded(requestId, 200, 'REQUEST_ID_INVALID')) }
  cancelMerge(operationId: string) { return this.topicMerges.cancel(operationId) }
  drainMerges() { this.topicMerges.drain() }
  detectSuggestions(gatewayId: string) { this.settings(gatewayId); this.topicMerges.detect(gatewayId) }
  vetSuggestions() { return this.topicMerges.tickVetting() }
  answerSuggestion(id: string, response: 'accept' | 'decline' | 'later', direction?: { sourceId: string; targetId: string }) { return this.topicMerges.answer(id, response, direction) }
  merge(source: string, target: string, publish = true) {
    this.idle(source, target)
    if (!this.visible(source) || !this.visible(target)) throw new Error('TOPIC_EXCLUDED')
    const wasPrivate = this.store.isPrivate(source)
    this.store.mergeTopics(source, target)
    this.runtime.put('merge', source, { sourceId: source, targetId: target })
    if (wasPrivate) this.store.setPrivate(target, true)
    this.suggestionsDirty = true
    if (publish) this.runtime.appendEvent({ type: 'topic.merged', sourceId: source, targetId: target })
    return this.store.merges()
  }
  unmerge(source: string) {
    const m = this.store.merges().find(m => m.sourceId === source); if (m) this.idle(m.targetId)
    const target = this.store.unmergeTopic(source); this.runtime.remove('merge', source)
    if (target) this.runtime.appendEvent({ type: 'topic.unmerged', sourceId: source, targetId: target })
    this.suggestionsDirty = true
    // Leave the target private after undo; only a deliberate privacy edit can widen sharing.
    return target
  }
  deleteTopic(id: string) {
    this.idle(id); this.context(id)
    if (this.store.merges().some(m => m.targetId === id)) throw new Error('UNMERGE_BEFORE_DELETE')
    this.store.deleteTopic(id)
    for (const m of this.runtime.all<Message>('message')) if (m.topicId === id) this.runtime.remove('message', m.id)
    this.runtime.remove('binding', id)
    this.runtime.appendEvent({ type: 'topic.changed', contextId: id }); this.suggestionsDirty = true
    return { deleted: id, nativeThreadDeleted: false }
  }
  correct(gatewayId: string, inputId: string, topicId: string) {
    if (!this.settings(gatewayId).enabled) throw Error('GATEWAY_DISABLED')
    this.context(topicId)
    if (!this.visible(topicId)) throw Error('TOPIC_EXCLUDED')
    const key = keyOf(gatewayId, inputId), input = this.runtime.get<InputRecord>('input', key)
    if (!input) throw new Error('INPUT_NOT_FOUND')
    const run = this.runtime.get<Run>('run', key)
    if (run && !terminal.has(run.status)) throw Object.assign(new Error('CANCEL_RUN_BEFORE_CORRECTION'), { statusCode: 409 })
    const fromId = this.runtime.get<Message>('message', key)?.topicId ?? input.result?.topicId
    this.idle(topicId, ...(fromId ? [fromId] : []))
    this.store.correctRoute(key, topicId)
    const message = this.runtime.get<Message>('message', key)
    if (message) this.runtime.put('message', key, { ...message, topicId })
    if (input.result) this.runtime.put('input', key, { ...input, result: { ...input.result, topicId, decision: { ...input.result.decision, contextId: topicId } } })
    if (fromId) this.runtime.appendEvent({ type: 'route.moved', fromId, toId: topicId, messageId: inputId }, gatewayId)
    return { correctedTo: topicId, sideEffectsUndone: false, rerunRequiresNewInputId: true }
  }
  exportHistory() {
    return { version: 1 as const, source: 'gpt-theone', topics: this.store.contexts().map(t => ({ id: t.id, title: t.title, summary: t.summary, private: this.store.isPrivate(t.id), messages: this.messages(this.topicIds(t.id)) })) }
  }
  importHistory(payload: unknown, consent: boolean) {
    if (!consent) throw new Error('HISTORY_CONSENT_REQUIRED')
    const data = historySchema.parse(payload)
    return this.runtime.transaction(() => {
    const staged = new Map<string, { role: string; text: string }>()
    for (const topic of data.topics) {
      const importKey = hash(JSON.stringify([data.source ?? 'external', topic.id]))
      for (const message of topic.messages) {
        const messageId = hash(JSON.stringify([importKey, message.id]))
        const old = staged.get(messageId) ?? this.runtime.get<Message>('message', messageId)
        if (old && (old.text !== message.text || old.role !== message.role)) throw new Error('IMPORT_MESSAGE_CONFLICT')
        staged.set(messageId, message)
      }
    }
    let topics = 0, messages = 0
    for (const t of data.topics) {
      const importKey = hash(JSON.stringify([data.source ?? 'external', t.id]))
      let id = this.runtime.get<string>('import', importKey)
      if (!id) {
        // A source identity, never its title, decides whether this is a duplicate.
        id = `import-${importKey}`
        if (!this.store.contexts().some(c => c.id === id)) { this.store.seed([{ id, title: t.title, summary: t.summary ?? '', lastState: '', entities: [], keywords: [t.title] }]); topics++ }
        this.runtime.put('import', importKey, id)
        this.store.setPrivate(id, t.private ?? true)
      }
      for (const m of t.messages) {
        const messageId = hash(JSON.stringify([importKey, m.id]))
        const old = this.runtime.get<Message>('message', messageId)
        if (old && (old.text !== m.text || old.role !== m.role)) throw new Error('IMPORT_MESSAGE_CONFLICT')
        if (!old) { this.runtime.put('message', messageId, { ...m, id: messageId, topicId: id, at: m.at ?? Date.now(), source: 'import' } satisfies Message); messages++ }
      }
    }
    this.store.setCatalogConsent('granted')
    return { topics, messages }
    })
  }
  async dispatch(input: RouteInput & { cwd?: string }) {
    const settings = this.settings(input.gatewayId)
    const cwd = canonical(input.cwd ?? settings.workspace)
    if (!within(settings.workspace, cwd)) throw new Error('WORKSPACE_OUT_OF_SCOPE')
    const routed = await this.route(input)
    const latestSettings = this.settings(input.gatewayId)
    if (!latestSettings.enabled) throw Error('GATEWAY_DISABLED')
    if (!within(latestSettings.workspace, cwd)) throw Error('WORKSPACE_OUT_OF_SCOPE')
    if (!routed.topicId) return { ...routed, status: 'clarify' as const, ...this.dispatchCatalog(input) }
    const id = keyOf(input.gatewayId, input.inputId), old = this.runtime.get<Run>('run', id)
    if (old) { if (pathKey(old.cwd) !== pathKey(cwd)) throw new Error('INPUT_WORKSPACE_CONFLICT'); return { ...old, receipt: routed.receipt, routingError: routed.routingError, ...this.dispatchCatalog(input) } }
    const binding = this.runtime.get<Binding>('binding', routed.topicId)
    if (binding && pathKey(binding.cwd) !== pathKey(cwd)) throw new Error('TOPIC_WORKSPACE_CONFLICT')
    if (!this.options.backend) throw new Error('CODEX_BACKEND_NOT_CONFIGURED')
    const target = this.steerTarget(input.gatewayId, routed.topicId)
    const run: Run = { id, gatewayId: input.gatewayId, inputId: input.inputId, topicId: routed.topicId, cwd, text: input.text, status: target ? 'starting' : 'queued', at: Date.now(), updatedAt: Date.now(), owner: this.owner, pid: process.pid, requestedSandbox: settings.sandbox, approvals: [], output: [], delivered: false,
      attachments: input.attachments, foreground: input.foreground !== false, ...(target ? { steeringOf: target.id, threadId: target.threadId, turnId: target.turnId } : {}) }
    let inserted = false
    this.runtime.transaction(() => { if (!this.runtime.get<Run>('run', id)) { this.runtime.put('run', id, run); inserted = true } })
    if (target && inserted) {
      try {
        await this.options.backend!.steer!({ threadId: target.threadId!, turnId: target.turnId!, text: input.text, attachments: input.attachments })
        const current = this.run(target.id)
        Object.assign(run, { status: current.status, output: current.output, progress: current.progress, approvals: current.approvals, waitingKind: current.waitingKind }); this.saveRun(run)
      } catch { run.status = 'failed'; run.error = 'STEERING_FAILED_VERIFY_BEFORE_RETRY'; this.saveRun(run) }
    }
    this.pump()
    return { ...this.run(id), receipt: routed.receipt, routingError: routed.routingError, ...this.dispatchCatalog(input) }
  }
  runs(gatewayId?: string) { return this.runtime.all<Run>('run').filter(r => !gatewayId || r.gatewayId === gatewayId) }
  private steerTarget(gatewayId: string, topicId: string) {
    if (!this.options.backend?.steer) return
    const settings = this.settings(gatewayId)
    if (!settings.enabled) return
    return this.runs(gatewayId).find(r => r.topicId === topicId && r.owner === this.owner && r.status === 'running' && r.threadId && r.turnId && !r.steeringOf &&
      (settings.sandbox === 'workspace-write' || r.requestedSandbox === 'read-only') && within(settings.workspace, r.cwd))
  }
  run(id: string) { const r = this.runtime.get<Run>('run', id); if (!r) throw new Error('RUN_NOT_FOUND'); return r }
  private saveRun(run: Run) {
    run.updatedAt = Date.now(); this.runtime.put('run', run.id, run); this.runtime.appendEvent({ type: 'work.changed', workItemId: run.id }, run.gatewayId)
    if (!run.steeringOf) for (const extra of this.runs(run.gatewayId)) if (extra.steeringOf === run.id && !terminal.has(extra.status)) {
      this.runtime.put('run', extra.id, { ...extra, status: run.status, updatedAt: run.updatedAt, output: run.output, progress: run.progress, approvals: run.approvals, waitingKind: run.waitingKind, error: run.error })
      if (terminal.has(run.status)) this.store.finish(extra.id, run.status === 'completed' ? 'completed' : 'failed')
    }
  }
  private recover() {
    for (const r of this.runs()) {
      if (terminal.has(r.status)) { this.runtime.unlock(r.id); continue }
      if (!alive(r.pid)) {
      if (r.status === 'queued') { r.owner = this.owner; r.pid = process.pid }
      else { r.status = 'interrupted'; r.error = 'OWNER_EXITED_VERIFY_SIDE_EFFECTS_BEFORE_RETRY'; r.approvals = []; this.runtime.unlock(r.id); this.store.endTopicRun(r.id, 'interrupted'); this.store.finish(r.id, 'failed') }
      this.saveRun(r)
      }
    }
  }
  private pump() {
    if (this.stopped || !this.options.backend) return
    for (const run of this.runs()) {
      if (run.owner !== this.owner || run.status !== 'queued' || this.active.has(run.id)) continue
      if (!this.runtime.lock([`workspace:${projectKey(run.cwd)}`, `topic:${run.topicId}`], run.id)) {
        const reason = this.runs().some(other => other.id !== run.id && other.topicId === run.topicId && ['starting','running','waiting_approval'].includes(other.status)) ? 'topic_busy' : 'project_busy'
        if (run.queueReason !== reason) { run.queueReason = reason; this.saveRun(run) }
        continue
      }
      delete run.queueReason
      run.status = 'starting'; this.saveRun(run)
      const controller = new AbortController()
      const promise = this.execute(run, controller).finally(() => { this.active.delete(run.id); this.runtime.unlock(run.id); if (!this.stopped) this.pump() })
      this.active.set(run.id, { controller, promise })
    }
  }
  private async execute(run: Run, controller: AbortController) {
    try {
      const settings = this.settings(run.gatewayId)
      if (!settings.enabled || !within(canonical(settings.workspace), canonical(run.cwd)) || !this.visible(run.topicId)) throw new Error('EXECUTION_PERMISSION_CHANGED')
      const binding = this.runtime.get<Binding>('binding', run.topicId)
      if (binding && pathKey(binding.cwd) !== pathKey(run.cwd)) throw new Error('TOPIC_WORKSPACE_CONFLICT')
      const sandbox = run.requestedSandbox === 'read-only' || settings.sandbox === 'read-only' ? 'read-only' : 'workspace-write'
      const packet = this.referencePacket(run.topicId, settings.linkScope, run.id); let committed = false
      const result = await this.options.backend!.execute({ runId: run.id, threadId: binding?.threadId, cwd: run.cwd, sandbox, model: settings.model, effort: settings.effort, text: run.text, attachments: run.attachments, reference: packet.text }, event => {
        this.event(run.id, event)
        if (!committed && event.type === 'started' && event.turnId) { packet.commit(); committed = true }
      }, controller.signal)
      const latest = this.run(run.id)
      if (!terminal.has(latest.status)) { latest.status = controller.signal.aborted ? 'cancelled' : result.status; latest.error = result.error; latest.approvals = []; this.saveRun(latest) }
    } catch (error) { const latest = this.run(run.id); if (!terminal.has(latest.status)) { latest.status = controller.signal.aborted ? 'cancelled' : 'failed'; latest.error = (error as Error).message; latest.approvals = []; this.saveRun(latest) } }
    const finished = this.run(run.id)
    this.store.finish(run.id, finished.status === 'completed' ? 'completed' : 'failed')
    this.store.endTopicRun(run.id, finished.status === 'cancelled' ? 'stopped' : finished.status === 'interrupted' ? 'interrupted' : finished.status === 'completed' ? 'completed' : 'failed')
    if (finished.status === 'completed' && this.runtime.get<TemporaryTopic>('temporary-topic', run.topicId)?.inputId === run.inputId) {
      this.store.declareTopic(run.topicId, 'done'); this.runtime.appendEvent({ type: 'topic.changed', contextId: run.topicId }, run.gatewayId)
    }
  }
  private event(id: string, event: WorkerEvent) {
    const run = this.run(id)
    if (terminal.has(run.status)) return
    if (event.type === 'started') {
      const first = !run.threadId
      run.threadId = event.threadId; run.turnId = event.turnId ?? run.turnId; run.status = run.approvals.length ? 'waiting_approval' : 'running'
      this.runtime.put('binding', run.topicId, { topicId: run.topicId, threadId: event.threadId, cwd: run.cwd } satisfies Binding)
      if (first) this.store.startTopicRun(id, run.topicId, event.threadId)
    } else if (event.type === 'message') {
      if (!run.output.some(m => m.id === event.id)) run.output.push({ id: event.id, text: event.text, phase: event.phase })
      const messageId = `${id}:${event.id}`
      this.runtime.put('message', messageId, { id: messageId, topicId: run.topicId, role: 'assistant', text: event.text, at: Date.now(), source: 'codex', runId: id, hostThreadId: run.threadId, hostTurnId: run.turnId } satisfies Message)
    } else if (event.type === 'progress') run.progress = ((run.progress ?? '') + event.text).slice(-4000)
    else if (event.type === 'approval') { run.approvals.push(event.approval); run.status = 'waiting_approval'; run.waitingKind = run.approvals.some(a => a.method === 'item/tool/requestUserInput') ? 'question' : 'approval' }
    else if (event.type === 'approval-resolved') { run.approvals = run.approvals.filter(a => a.id !== event.id); if (!run.approvals.length) run.status = 'running' }
    this.saveRun(run)
  }
  async wait(id: string, timeoutMs = 15000) {
    const until = Date.now() + Math.min(20000, Math.max(0, timeoutMs))
    while (Date.now() < until && !terminal.has(this.run(id).status) && this.run(id).status !== 'waiting_approval') await new Promise(r => setTimeout(r, 50))
    return this.run(id)
  }
  async cancel(id: string) {
    const run = this.run(id)
    if (terminal.has(run.status)) return run
    if (run.steeringOf) { await this.cancel(run.steeringOf); return this.run(id) }
    if (run.owner !== this.owner) throw new Error('RUN_OWNED_BY_ANOTHER_CONNECTION')
    const active = this.active.get(id)
    if (active) { active.controller.abort(); await active.promise }
    else { run.status = 'cancelled'; run.approvals = []; this.saveRun(run); this.runtime.unlock(id) }
    return this.run(id)
  }
  async respond(id: string, approvalId: string, response: Parameters<WorkerBackend['respond']>[1]) {
    const run = this.run(id), approval = run.approvals.find(a => a.id === approvalId)
    if (run.steeringOf) { await this.respond(run.steeringOf, approvalId, response); return this.run(id) }
    if (!approval || approval.expiresAt <= Date.now() || terminal.has(run.status)) throw new Error('APPROVAL_EXPIRED_OR_UNKNOWN')
    if (run.owner !== this.owner) throw new Error('APPROVAL_OWNED_BY_ANOTHER_CONNECTION')
    await this.options.backend!.respond(approval, response)
    this.event(id, { type: 'approval-resolved', id: approvalId })
    return this.run(id)
  }
  acknowledge(id: string, foreground?: boolean) {
    const run = this.run(id); if (!terminal.has(run.status)) throw new Error('RUN_NOT_FINISHED')
    run.delivered = true; this.saveRun(run)
    if (foreground ?? run.foreground !== false) {
      const temporary = this.runtime.get<TemporaryTopic>('temporary-topic', run.topicId)
      this.runtime.put('foreground', run.gatewayId, { messageId: run.inputId, topicId: run.topicId, ...(temporary ? { returnTopicId: temporary.returnTopicId } : {}) } satisfies ForegroundReply)
    }
    return { acknowledged: id }
  }
  async compact(id: string) { this.idle(id); const binding = this.runtime.get<Binding>('binding', id); if (!binding || !this.options.backend?.compact) throw new Error('NO_CODEX_THREAD'); return this.options.backend.compact(binding.threadId) }
  async close() {
    this.stopped = true; this.lifetime.abort(); clearInterval(this.timer)
    await this.topicMerges.close()
    await this.catalog?.close()
    await Promise.allSettled([...this.routing.values()])
    await this.preroutes.close()
    for (const task of this.active.values()) task.controller.abort()
    await Promise.all([...this.active.values()].map(t => t.promise))
    for (const r of this.runs()) if (r.owner === this.owner && !terminal.has(r.status)) { r.status = 'interrupted'; r.error = 'CONNECTION_CLOSED'; r.approvals = []; this.saveRun(r); this.runtime.unlock(r.id) }
    await this.options.backend?.close()
    await this.options.router?.close?.()
    this.runtime.close(); this.store.close()
  }
}
