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
  returnNote?: string
  targetCheck?: import('./target-check.ts').TargetCheck
  attachments?: WorkerAttachment[]
}
type MediaRef = { url: string; fileId?: never } | { fileId: string; url?: never }
type ImageDetail = { detail?: 'auto' | 'low' | 'high' | 'original' | null }
export type WorkerAttachment = ({ type: 'image' } & MediaRef & ImageDetail) | ({ type: 'audio' } & MediaRef) |
  ({ type: 'localImage'; path: string } & ImageDetail) | { type: 'localAudio'; path: string } | { type: 'mention'; name: string; path: string }
/** Matches the local App Server UserInput schema; never invents a binary file transport. */
export function validAttachment(value: WorkerAttachment): boolean {
  const bounded = (s: unknown, max: number) => typeof s === 'string' && !!s.trim() && s.length <= max
  if (!value || typeof value !== 'object') return false
  if ((value.type === 'image' || value.type === 'localImage') && value.detail != null && !['auto','low','high','original'].includes(value.detail)) return false
  if (value.type === 'image' || value.type === 'audio') return value.url !== undefined
    ? value.fileId === undefined && bounded(value.url, 10000000) && (/^https?:\/\//i.test(value.url) || value.url.startsWith(`data:${value.type}/`))
    : bounded(value.fileId, 2000)
  if (value.type === 'localImage' || value.type === 'localAudio') return bounded(value.path, 4000)
  return value.type === 'mention' && bounded(value.name, 500) && bounded(value.path, 4000)
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
  | { type: 'target-checked'; answer: 'confirmed' | 'declined' }
export interface WorkerResult { status: 'completed' | 'failed' | 'interrupted'; error?: string }
export interface WorkerBackend {
  execute(request: WorkerRequest, emit: (event: WorkerEvent) => void, signal: AbortSignal): Promise<WorkerResult>
  respond(approval: Approval, response: { decision?: 'accept' | 'decline' | 'cancel'; answers?: Record<string, { answers: string[] }> }): Promise<void>
  steer?(request: { threadId: string; turnId: string; text: string; attachments?: WorkerAttachment[] }): Promise<void>
  compact?(threadId: string): Promise<unknown>
  version?(): Promise<string>
  close(): Promise<void>
}
