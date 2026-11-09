export interface WorkerConfig {
  cwd: string
  sandbox: 'read-only' | 'workspace-write'
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
}
export interface WorkerRequest extends WorkerConfig {
  runId: string
  threadId?: string
  text: string
  reference: string
}
export interface Approval {
  id: string; requestId: string | number; method: string; threadId: string; turnId: string
  details: Record<string, unknown>; expiresAt: number
}
export type WorkerEvent =
  | { type: 'started'; threadId: string; turnId?: string }
  | { type: 'message'; id: string; text: string; phase?: string }
  | { type: 'progress'; text: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-resolved'; id: string }
export interface WorkerResult { status: 'completed' | 'failed' | 'interrupted'; error?: string }
export interface WorkerBackend {
  execute(request: WorkerRequest, emit: (event: WorkerEvent) => void, signal: AbortSignal): Promise<WorkerResult>
  respond(approval: Approval, response: { decision?: 'accept' | 'decline' | 'cancel'; answers?: Record<string, { answers: string[] }> }): Promise<void>
  compact?(threadId: string): Promise<unknown>
  close(): Promise<void>
}
