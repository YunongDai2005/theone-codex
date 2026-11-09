/** Host-neutral shapes used by the migrated domain code. Not Codex wire types. */
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
type TextBlock = { type: string; text?: string }
export type SessionEvent =
  | { type: 'user/message'; seq: number; data: { source: { kind: string }; content: TextBlock[] } }
  | { type: 'assistant/message'; seq: number; data: { message: { content: TextBlock[] } } }
  | { type: 'tool/call'; seq: number; data: { name: string; callId: string } }
  | { type: 'tool/result'; seq: number; data: { message: { source: { callId: string }; content: TextBlock[]; isError?: boolean } } }
