import { WorkStore, type WorkJob } from './work-store.ts'
export interface WorkOutcome {
  result?: unknown; nextAt?: number; waiting?: string
  notice?: { fingerprint: string; text: string }
}
export interface WorkScope { signal: AbortSignal; checkpoint(value: unknown): boolean; owns(): boolean }
export type WorkHandler = (job: WorkJob, scope: WorkScope) => Promise<WorkOutcome>
export class WorkScheduler {
  private stopped = false
  private timer?: ReturnType<typeof setInterval>
  private pump?: Promise<void>
  private active?: { job: WorkJob; abort: AbortController }
  constructor(readonly store: WorkStore, private readonly handler: WorkHandler, private readonly now = Date.now) {}
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 5000)
    this.timer.unref()
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.pump ??= this.drain().finally(() => { this.pump = undefined })
  }
  private async drain(): Promise<void> {
    // A bounded batch yields to ordinary conversations even if new work keeps arriving.
    const visited: string[] = []
    for (let i = 0; i < 32 && !this.stopped; i++) {
      const job = this.store.claim(this.now(), 90000, visited)
      if (!job) break
      visited.push(job.id)
      const abort = new AbortController()
      this.active = { job, abort }
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60000)])
      const owns = () => !signal.aborted && !this.stopped && this.store.owns(job, this.now())
      let onAbort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const outcome = await Promise.race([cancelled, this.handler(job, { signal, owns,
          checkpoint: value => owns() && this.store.checkpoint(job, value, this.now()) })])
        if (owns()) {
          if (outcome.waiting) this.store.wait(job, outcome.waiting, this.now())
          else this.store.finish(job, outcome.result, outcome.nextAt, outcome.notice, this.now())
        } else if (signal.aborted && !this.stopped && this.store.owns(job, this.now())) this.store.fail(job, 'WORK_TIMEOUT', this.now())
      } catch (error) {
        if (!this.stopped && this.store.owns(job, this.now())) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
          this.store.fail(job, signal.aborted ? 'WORK_TIMEOUT' : /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'WORK_FAILED', this.now())
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        if (this.stopped) this.store.release(job, this.now())
        this.active = undefined
      }
    }
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'wake'): boolean {
    const changed = this.store.control(id, action, this.now())
    if (changed && this.active?.job.id === id) this.active.abort.abort()
    return changed
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.active?.abort.abort()
    await this.pump
  }
}
