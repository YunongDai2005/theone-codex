/** Metadata-only DSH event vocabulary, persisted in the local runtime database. */
export interface DesktopCursor { epoch: string; seq: number; gatewayId?: string | null }
export interface MergeOperation {
  operationId: string; requestId: string; sourceId: string; targetId: string; whenIdle: boolean; suggestionId?: string
  state: 'queued' | 'executing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  createdAt: number; updatedAt: number; expiresAt: number; error?: string
}
export interface MergeSuggestion {
  suggestionId: string; gatewayId: string; pair: [string, string]; directions: { sourceId: string; targetId: string }[]
  evidence: { sharedNames: number; titleSimilarity: number }; fingerprint: string
  createdAt: number; updatedAt: number; expiresAt: number
  state: 'pending' | 'accepted' | 'declined' | 'dismissed' | 'expired'
  operationId?: string; sourceId?: string; targetId?: string
}
export type DesktopEventData =
  | { type: 'route.assigned'; workItemId: string; messageIds: string[]; contextId: string; created: boolean; alternateIds: string[]; source?: 'user' | 'steering' }
  | { type: 'route.blocked'; candidateIds: string[] }
  | { type: 'route.resolved'; contextId?: string }
  | { type: 'route.moved'; messageId: string; fromId: string; toId: string }
  | { type: 'topic.merged' | 'topic.unmerged'; sourceId: string; targetId: string }
  | { type: 'topic.changed'; contextId: string }
  | { type: 'work.changed'; workItemId: string }
  | ({ type: 'merge.changed' } & MergeOperation)
  | { type: 'suggestion.changed'; suggestionId: string }
export type DesktopEvent = DesktopEventData & { seq: number; at: number; gatewayId: string | null }
