/**
 * Fleet S5a wire types for the web (hand-written: the web has no generated client).
 * Shapes mirror the API DTOs in apps/api/src/fleet/threads/dto/thread.dto.ts and the
 * ThreadLiveEvent in apps/api/src/live/thread-event-bus.ts. Money is a Decimal.toString()
 * string (`costUsd` `'0'`, `maxCostUsd` `'5'`, `'1.25'`) and is only ever shown with usd()
 * — the browser never sums or re-rounds it (web context A7).
 */

/** Runtime mirror of packages/fleet-protocol/src/threads.ts (`ThreadBackend`). */
export type ThreadBackend =
  | { kind: 'native'; model?: string; effort?: string }
  | { kind: 'acp'; agent: 'claude' | 'codex'; model?: string; effort?: string }

/** The skills the thread was created with (skill-catalog.domain.ts `ThreadSkillSource`). */
export interface ThreadSkillSource {
  sourceId: string
  owner: string
  repo: string
  sha: string
  skills: Array<{ name: string; dir: string; description: string }>
}

/** One reason the API refuses a send (`thread-send-rules.ts`); only GET /:id and archive carry it. */
export type ThreadSendRefusal =
  | 'disabled' | 'archived' | 'costCap' | 'budgetPaused' | 'runnerOffline' | 'runnerOutdated'
  | 'closing' | 'turnRunning'

export interface ThreadTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ThreadPendingQuestion {
  requestId: string
  text: string
  expiresAt: string
}

/** The thread's session as the thread stream last folded it (chat-thread.domain.ts `ThreadSession`). */
export interface ThreadSession {
  jobId: string
  state: 'live' | 'closed' | 'failed'
  resumed: boolean
  contextReset: boolean
  reason: string | null
  at: string
}

export interface ThreadDto {
  id: string
  repoId: string
  baseRef: string
  feature: string
  title: string
  createdById: string
  runnerId: string | null
  backend: ThreadBackend
  status: string
  archivedAt: string | null
  skills: ThreadSkillSource[]
  maxCostUsd: string
  costUsd: string
  tokens: ThreadTokens | null
  specPath: string
  pendingQuestion: ThreadPendingQuestion | null
  session: ThreadSession | null
  lastActivityAt: string
  createdAt: string
  /** The thread's current THREAD job, when one is not terminal. */
  activeJob: { id: string; state: string } | null
}

export interface ThreadDetailDto extends ThreadDto {
  sendRefusal: ThreadSendRefusal | null
}

/** One tool/approval entry of a message's folded `toolSummary` (tool-summary.ts `ToolSummaryEntry`). */
export interface ToolSummaryEntry {
  callId: string
  name: string
  input: string
  isError: boolean | null
  preview: string
  decidedBy: string | null
}

export interface ChatMessageDto {
  id: string
  seq: number
  jobId: string | null
  turnId: string | null
  role: string
  authorUserId: string | null
  clientMessageId: string | null
  content: string
  toolSummary: ToolSummaryEntry[] | null
  status: string
  errorReason: string | null
  usage: unknown
  costUsd: string | null
  costSource: string | null
  createdAt: string
}

/** Content-free live event of one thread (thread-event-bus.ts `ThreadLiveEvent`). */
export type ThreadLiveEvent = { id: string; threadId: string; at: string } & (
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'message'; messageId: string }
  | { type: 'question'; requestId: string; text: string }
  | { type: 'thread' }
)

/** Runner capability report as the web sees it (runner-summary.dto.ts). */
export interface RunnerThreadBackends {
  native: string[]
  acp: string[]
}

export type SessionLabel = 'starting' | 'closing' | 'live' | 'failed' | 'closed' | 'none'

/** Why the composer cannot send: the API refusal, or the viewer-only read-only case. */
export type ComposerReason = ThreadSendRefusal | 'readOnly'