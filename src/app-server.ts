import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string }; handled?: boolean }
export interface AppServerOptions { command?: string; args?: string[]; requestTimeoutMs?: number; env?: NodeJS.ProcessEnv; worker?: boolean; experimentalApi?: boolean }
export function findCodex(): string {
  if (process.env.THEONE_CODEX_BIN) return process.env.THEONE_CODEX_BIN
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    if (existsSync(root)) {
      const files = readdirSync(root).map(p => join(root, p, 'codex.exe')).filter(existsSync).sort((a,b) => statSync(b).mtimeMs-statSync(a).mtimeMs)
      if (files[0]) return files[0]
    }
  }
  return 'codex'
}
/** The supported app-server newline JSON-RPC transport, without a shell. */
export class AppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private nextId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  disconnected = false
  constructor(private options: AppServerOptions = {}) { super() }
  async connect(): Promise<void> {
    return this.ready ??= this.initialize()
  }
  private async initialize() {
    this.child = spawn(this.options.command ?? findCodex(), this.options.args ?? ['app-server'], {
      stdio: 'pipe', windowsHide: true,
      env: { ...process.env, ...this.options.env, ...(this.options.worker ? { THEONE_WORKER: '1' } : {}) },
    })
    // stderr can contain private runtime paths; do not mix it into the MCP protocol or errors.
    this.child.stderr.resume()
    this.child.once('error', error => this.disconnect(new Error(`CODEX_SPAWN_FAILED: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)))
    this.child.once('exit', () => this.disconnect(new Error('CODEX_DISCONNECTED_VERIFY_SIDE_EFFECTS')))
    this.child.stdin.on('error', () => this.disconnect(new Error('CODEX_DISCONNECTED_VERIFY_SIDE_EFFECTS')))
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (!line.trim()) return
      try {
        const message = JSON.parse(line) as RpcMessage
        if (message.method) {
          this.emit(message.id === undefined ? 'notification' : 'request', message)
          if (message.id !== undefined && !message.handled) this.send({ id: message.id, error: { code: -32601, message: 'Unsupported or unbound host request; no permission granted.' } })
        }
        else if (typeof message.id === 'number') {
          const waiter = this.pending.get(message.id)
          if (!waiter) return
          this.pending.delete(message.id); clearTimeout(waiter.timer)
          if (message.error) waiter.reject(new Error(`CODEX_RPC_${message.error.code}: ${message.error.message}`))
          else waiter.resolve(message.result)
        }
      } catch { this.disconnect(new Error('CODEX_PROTOCOL_INVALID')) }
    })
    await this.request('initialize', { clientInfo: { name: 'gpt-theone', title: 'TheOne', version: '0.1.0-alpha.1' }, ...(this.options.experimentalApi ? { capabilities: { experimentalApi: true } } : {}) })
    this.send({ method: 'initialized' })
  }
  send(message: RpcMessage): void {
    if (this.disconnected || !this.child) throw new Error('CODEX_DISCONNECTED_VERIFY_SIDE_EFFECTS')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation may already have run. Close this transport; never replay it.
        this.disconnect(new Error(`CODEX_REQUEST_TIMEOUT_${method}_VERIFY_SIDE_EFFECTS`))
      }, this.options.requestTimeoutMs ?? 30000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  private disconnect(error: Error) {
    if (this.disconnected) return
    this.disconnected = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear(); this.child?.kill(); this.emit('disconnect', error)
  }
  async close() { this.disconnect(new Error('CODEX_DISCONNECTED_CLOSED')) }
}
