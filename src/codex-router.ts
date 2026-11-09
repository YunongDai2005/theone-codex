import type { AppServerOptions } from './app-server.ts'
import { CodexJsonClient } from './codex-json-client.ts'
import { routingPrompt, routingPayload, validateRoutingDecision, RouterFailure, type RoutingInput, type RoutingRouter, type RoutingResult, type RoutingOptions } from './llm-router.ts'
import { recommendedRouterModel, validateRouterModel, type RouterModelSettings } from './router-model-settings.ts'

const nullableString = { type: ['string', 'null'] }
const ids = { type: 'array', items: { type: 'string' } }
export const ROUTING_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['action','contextId','title','label','reason','relatedIds','imports','historyIndependent','aside','projectId','candidateIds','question'],
  properties: {
    action: { type: 'string', enum: ['EXISTING','CREATE','CLARIFY'] }, contextId: nullableString, title: nullableString, label: nullableString,
    reason: { type: 'string' }, relatedIds: ids, imports: ids, historyIndependent: { type: ['boolean','null'] }, aside: { type: ['boolean','null'] },
    projectId: nullableString, candidateIds: ids, question: nullableString,
  },
}

export class CodexRouter implements RoutingRouter {
  readonly source = 'codex' as const
  private client: CodexJsonClient
  private timeoutMs: number
  constructor(private options: AppServerOptions & { timeoutMs?: number; settings?: RouterModelSettings } = {}) {
    this.timeoutMs = options.timeoutMs ?? 15000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new RouterFailure('ROUTER_TIMEOUT_INVALID')
    this.client = new CodexJsonClient(options)
  }
  models() { return this.client.models() }
  async decide(input: RoutingInput, parentSignal?: AbortSignal, _sessionId?: string, options?: RoutingOptions): Promise<RoutingResult> {
    const started = Date.now(), signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(this.timeoutMs)])
    const selected = options?.modelSettings ?? this.options.settings
    let model = selected?.model
    let sent = false
    try {
      const payload = routingPayload(input)
      const result = await this.client.execute(payload, { prompt: routingPrompt(payload), schema: ROUTING_SCHEMA, signal, serviceName: 'gpt-theone-router',
        select: models => {
          const selection = selected ?? recommendedRouterModel(models)
          if (!selection) throw new RouterFailure('ROUTER_MODEL_SELECTION_REQUIRED')
          return validateRouterModel(selection, models)
        }, onSelected: chosen => { model = chosen }, onStarted: () => { sent = true } })
      const offered = new Set(payload.contexts.map(c => c.id))
      const decision = validateRoutingDecision(result.value, { ...input, contexts: input.contexts.filter(c => offered.has(c.id)) })
      const elapsedMs = Date.now() - started
      const attempt = { attempt: 1, sent: true, model, elapsedMs }
      options?.onAttempt?.(attempt)
      return { decision, model: result.model, elapsedMs, attempts: [attempt] }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const code = signal.aborted ? (signal.reason?.name === 'TimeoutError' ? 'ROUTER_TIMEOUT' : 'ROUTER_ABORTED')
        : message.startsWith('ROUTER_') ? message : message === 'MODEL_MISMATCH' ? 'ROUTER_MODEL_MISMATCH' : message.startsWith('MODEL_') ? message.replace(/^MODEL_/, 'ROUTER_')
        : message.startsWith('CODEX_REQUEST_TIMEOUT') ? 'ROUTER_TIMEOUT'
        : message.startsWith('CODEX_DISCONNECTED') ? 'ROUTER_DISCONNECTED' : 'ROUTER_UNAVAILABLE'
      const elapsedMs = Date.now() - started, attempt = { attempt: 1, sent, model, elapsedMs, errorCode: code }
      options?.onAttempt?.(attempt)
      throw new RouterFailure(code, { elapsedMs, attempts: [attempt] }, error instanceof RouterFailure ? error.detail : undefined)
    }
  }
  close() { return this.client.close() }
}
