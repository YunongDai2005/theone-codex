import { routingPrompt, routingPayload, validateRoutingDecision, answerJson, RouterFailure, type RoutingInput, type RoutingRouter, type RoutingResult } from './llm-router.ts'
import { MERGE_VET_PROMPT, type MergePair } from './merge-vetting.ts'

/** Optional explicitly configured OpenAI-compatible classifier. No tools or host account tokens. */
export class HttpRouter implements RoutingRouter {
  readonly source = 'http' as const
  constructor(private config: { endpoint: string; model: string; apiKey?: string; timeoutMs?: number }, private fetcher: typeof fetch = fetch) {
    const url = new URL(config.endpoint)
    if (url.username || url.password || url.hash || url.search || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('ROUTER_ENDPOINT_INVALID')
    if (!config.model.trim()) throw new Error('ROUTER_MODEL_REQUIRED')
  }
  async decide(input: RoutingInput, signal?: AbortSignal): Promise<RoutingResult> {
    const payload = routingPayload(input), { value, ...result } = await this.query(routingPrompt(payload), payload, signal)
    try { return { ...result, decision: validateRoutingDecision(value, input) } }
    catch (error) {
      const failure = error as RouterFailure
      throw new RouterFailure(failure.code ?? 'ROUTER_INVALID_DECISION', { elapsedMs: result.elapsedMs, attempts: [{ attempt: 1, sent: true, model: result.model, elapsedMs: result.elapsedMs, errorCode: failure.code }] })
    }
  }
  async vetMerges(pairs: MergePair[], signal: AbortSignal) { return (await this.query(MERGE_VET_PROMPT, { pairs }, signal)).value }
  private async query(prompt: string, payload: unknown, signal?: AbortSignal) {
    const started = Date.now()
    let sent = false
    try {
      const bounded = AbortSignal.timeout(Math.min(30000, this.config.timeoutMs ?? 8000))
      sent = true
      const response = await this.fetcher(this.config.endpoint, {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, bounded]) : bounded,
        headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.config.model, stream: false, messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(payload) }] }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new RouterFailure(`ROUTER_HTTP_${response.status}`) }
      const reader = response.body?.getReader()
      if (!reader) throw new RouterFailure('ROUTER_EMPTY_RESPONSE')
      const chunks: Uint8Array[] = []; let bytes = 0
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1000000) throw new RouterFailure('ROUTER_RESPONSE_TOO_LARGE'); chunks.push(value) } }
      finally { await reader.cancel().catch(() => {}) }
      let value: any
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RouterFailure('ROUTER_INVALID_JSON') }
      const text = value.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new RouterFailure('ROUTER_EMPTY_RESPONSE')
      let decoded: unknown
      try { decoded = JSON.parse(answerJson(text)) } catch { throw new RouterFailure('ROUTER_INVALID_JSON') }
      return { value: decoded, model: this.config.model, elapsedMs: Date.now()-started,
        ...(value.usage && typeof value.usage.total_tokens === 'number' ? { usage: value.usage } : {}) }
    } catch (error) {
      const code = signal?.aborted ? 'ROUTER_ABORTED' : error instanceof RouterFailure ? error.code
        : error instanceof Error && error.name === 'TimeoutError' ? 'ROUTER_TIMEOUT' : 'ROUTER_UNAVAILABLE'
      const elapsedMs = Date.now() - started
      throw new RouterFailure(code, { elapsedMs, attempts: [{ attempt: 1, sent, model: this.config.model, elapsedMs, errorCode: code }] }, error instanceof RouterFailure ? error.detail : undefined)
    }
  }
}
export function routerFromEnvironment(): HttpRouter | undefined {
  const endpoint = process.env.THEONE_ROUTER_URL, model = process.env.THEONE_ROUTER_MODEL
  if (!endpoint) return undefined
  if (!endpoint || !model) throw new Error('ROUTER_URL_AND_MODEL_REQUIRED')
  return new HttpRouter({ endpoint, model, apiKey: process.env.THEONE_ROUTER_KEY })
}
