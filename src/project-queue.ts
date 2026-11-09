import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Canonical repository root, or workspace root when it is not a Git checkout. */
export function projectKey(folder: string): string {
  let path = resolve(folder)
  try { path = realpathSync(path) } catch { /* A new workspace may not exist yet. */ }
  let cursor = path
  for (;;) {
    if (existsSync(join(cursor, '.git'))) { path = cursor; break }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export class ProjectQueue {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const bounded = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    bounded.throwIfAborted()
    const previous = this.tails.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const gate = new Promise<void>(resolve => { unlock = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    let released = false
    const release = () => {
      if (released) return
      released = true; unlock()
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    }
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(bounded.reason)
      bounded.addEventListener('abort', onAbort, { once: true })
    })
    try { await Promise.race([previous, aborted]); bounded.throwIfAborted(); return release }
    catch (error) { release(); throw error }
    finally { bounded.removeEventListener('abort', onAbort) }
  }
  close(): void { this.lifetime.abort() }
}
