import { RouterFailure, newRoutingTrace, routingPayload, type RoutingInput, type RoutingRouter, type RoutingOptions, type RouterReceipt, type RouterCall } from './llm-router.ts'
import { routingEvidence, secondLook, type TopicMemory } from './routing-evidence.ts'
import type { Decision } from './types.ts'

/** The same bounded retry/recheck/review path for either model transport. */
export async function decideWithReview(router: RoutingRouter, input: RoutingInput, signal: AbortSignal, options?: RoutingOptions, memory?: TopicMemory[]) {
  const trace = newRoutingTrace(), calls: RouterCall[] = [], started = Date.now()
  const receipt: RouterReceipt = { mode: 'llm', source: router.source ?? 'codex', trace, callDetails: calls }
  const call = async (data: RoutingInput, layer: RouterCall['layer']): Promise<Decision> => {
    const payload = routingPayload(data), offered = new Set(payload.contexts.map(c => c.id))
    const bounded = { ...data, contexts: data.contexts.filter(c => offered.has(c.id)) }
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted()
      const start = Date.now()
      try {
        const result = await router.decide(bounded, signal, undefined, { ...options, think: layer !== 'quick' })
        calls.push({ layer, attempt, candidateIds: [...offered], sent: true, elapsedMs: Date.now() - start, model: result.model,
          promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens })
        receipt.model = result.model; receipt.tier = layer
        return result.decision
      } catch (error) {
        const code = error instanceof RouterFailure ? error.code : error instanceof Error && /^ROUTER_/.test(error.message) ? error.message : 'ROUTER_UNAVAILABLE'
        const observed = error instanceof RouterFailure ? error.meta?.attempts?.at(-1) : undefined
        calls.push({ layer, attempt, candidateIds: [...offered], sent: observed?.sent ?? false, elapsedMs: Date.now() - start, model: observed?.model, errorCode: code })
        if (observed?.sent && observed.model) receipt.model = observed.model
        const retryable = /^(ROUTER_INVALID_JSON|ROUTER_INVALID_DECISION|ROUTER_DISCONNECTED|ROUTER_UNAVAILABLE|ROUTER_HTTP_(429|5\d\d))$/.test(code)
        if (signal.aborted || attempt >= 2 || !retryable) {
          receipt.calls = calls.length; receipt.elapsedMs = Date.now() - started
          throw Object.assign(new RouterFailure(code, { elapsedMs: receipt.elapsedMs }), { receipt })
        }
        trace.retries ??= []; trace.retries.push({ layer, candidateIds: [...offered], attempts: attempt + 1 })
      }
    }
  }
  trace.candidateIds = routingPayload(input).contexts.map(c => c.id)
  let decision = await call(input, 'quick')
  trace.initial = decision
  const evidence = routingEvidence(input.text, memory ?? input.contexts.map(c => ({ id: c.id, texts: [c.title, c.summary, c.lastState, ...c.entities, ...c.keywords] })))
  const recheck = secondLook(decision, evidence)
  if (recheck && !decision.aside) {
    trace.recheck = { attempted: true, trigger: recheck.contextId ? 'evidence-conflict' : decision.action === 'CREATE' ? 'create' : 'clarify', ...recheck }
    decision = await call({ ...input, recheck }, 'recheck'); trace.recheck.accepted = true
  } else if (decision.aside) trace.recheck.skipped = 'aside'
  // Omitted candidates get at most three additional pages, bounded by the wire payload.
  const seen = new Set(trace.candidateIds)
  for (let page = 0; page < 3 && !decision.aside && ['CREATE','CLARIFY'].includes(decision.action); page++) {
    const remaining = input.contexts.filter(c => !seen.has(c.id))
    if (!remaining.length) break
    const data = { ...input, contexts: remaining, recheck: { previous: decision.contextId ?? decision.action } }
    const ids = routingPayload(data).contexts.map(c => c.id)
    trace.review.attempted = true; trace.review.pages.push(ids); ids.forEach(id => seen.add(id))
    decision = await call(data, 'review')
  }
  trace.final = decision; receipt.calls = calls.length; receipt.elapsedMs = Date.now() - started
  receipt.promptTokens = calls.reduce((sum, c) => sum + (c.promptTokens ?? 0), 0)
  receipt.completionTokens = calls.reduce((sum, c) => sum + (c.completionTokens ?? 0), 0)
  return { decision, receipt }
}
