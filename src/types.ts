/** A topic's goal, what is done so far, and the next step. */
export interface Progress { goal: string; done: string; next: string }

export interface ContextDescriptor {
  id: string
  title: string
  summary: string
  entities: string[]
  keywords: string[]
  /** Where the topic stands, in words; written from `progress` when the topic keeps one. */
  lastState: string
  /** Where the topic stands in three parts, kept by the topic itself (theone_update_state). */
  progress?: Progress
  /** Routing only, never stored: when the topic was last active ("3 小时前", "已搁置（12 天未动）"). */
  activity?: string
  /** Routing only, never stored: the name of the project (DSH workspace) the topic works in. */
  project?: string
  /** Routing only, never stored: the user said it is done, or it waits on the user. */
  status?: 'done' | 'waiting'
}

export interface StoredContext extends ContextDescriptor {
  workingSessionId: string
}

export interface ContextUsage {
  contextId: string
  completedCalls: number
  recentCalls: number
  lastUsedAt: number
}

export type Action = 'KEEP' | 'MOUNT' | 'SWAP' | 'CREATE' | 'CLARIFY'
export interface Decision {
  action: Action
  contextId?: string
  title?: string
  reason: string
  question?: string
  /** CREATE can proceed during indexing only when the request needs no missing history. */
  historyIndependent?: boolean
  /** CREATE: a self-contained question that temporarily leaves the current work. */
  aside?: boolean
  /** Other topics this request also draws on; the routed topic does the work. */
  relatedIds?: string[]
  /** Topics the message may have meant instead (an unclear pick, or a first pick the second look changed): reference only, never learned as related. */
  alternateIds?: string[]
  /** Confirmed facts of other topics this request uses (ids from the offered candidates). */
  imports?: string[]
  /** The user said message `correctionOf` went to the wrong topic; this route redoes it here. */
  correctionOf?: string
  /** CREATE: the classifier's pick among the offered project folders (see RoutingInput.projects). */
  projectId?: string
  /** CREATE: the project folder the new topic works in (one of the user's workspaces). */
  folder?: string
}

/** Relatedness between two topics: a user's choice (1 linked, -1 kept apart) or learned weight. */
export interface TopicLink { a: string; b: string; weight: number; manual: 1 | 0 | -1 }

export interface RouteRecord {
  messageId: string
  gatewayId: string
  decision: Decision
  status: 'planned' | 'running' | 'completed' | 'failed'
}

/** One routed main-chat message as the topic directory lists it. */
export interface RouteView {
  messageId: string
  decision: Decision
  status: RouteRecord['status']
  at: number
  /** Redacted start of the message. */
  excerpt: string
  receipt?: import('./llm-router.ts').RouterReceipt & Record<string, unknown>
  /** The topic the user said it belonged to instead. */
  correctedTo?: string
}

/** Inclusive raw-event ranges reviewed for a historical Context. */
export type SourceRange =
  | { sessionId: string; kind: 'bounded'; startSeq: number; endSeq: number }
  | { sessionId: string; kind: 'worker' | 'unscoped' }
