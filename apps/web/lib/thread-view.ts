/**
 * Fleet S5a §4: pure display-state derivation for the thread page. No Vue imports;
 * every function returns new data and never mutates its inputs.
 */

import type { ChatMessageDto, ComposerReason, SessionLabel, ThreadDetailDto, ThreadDto, ToolSummaryEntry } from '~/lib/thread-types'
import { usd } from '~/lib/fleet-analytics-format'

const STREAMING = 'streaming'
const PENDING = 'pending'
const IN_FLIGHT: readonly string[] = [PENDING, STREAMING]
/** An optimistic entry: the local echo of a send, keyed by clientMessageId. */
const OPTIMISTIC_PREFIX = 'local:'

const isOptimistic = (message: ChatMessageDto): boolean => message.id.startsWith(OPTIMISTIC_PREFIX)

/** A new array whose message `messageId` has `text` appended to its content; null when no such message exists. */
export function applyDelta(messages: readonly ChatMessageDto[], messageId: string, text: string): ChatMessageDto[] | null {
  const index = messages.findIndex(message => message.id === messageId)
  if (index === -1) return null
  return messages.map((message, i) => (i === index ? { ...message, content: message.content + text } : message))
}

/**
 * Union by `id`; `incoming` wins, except that a message `streaming` on both sides keeps the longer
 * `content` (an older in-flight GET never shortens streamed text). Real messages sort ascending by
 * `seq`; an optimistic entry is dropped when `incoming` holds a message with its `clientMessageId`,
 * and remaining optimistic entries sort after every real message.
 */
export function mergeMessages(current: readonly ChatMessageDto[], incoming: readonly ChatMessageDto[]): ChatMessageDto[] {
  const inComingClientIds = new Set(incoming.map(message => message.clientMessageId).filter((id): id is string => id !== null))
  const byId = new Map<string, ChatMessageDto>()
  for (const message of incoming) byId.set(message.id, message)
  for (const message of current) {
    if (byId.has(message.id)) continue
    if (isOptimistic(message) && message.clientMessageId !== null && inComingClientIds.has(message.clientMessageId)) continue
    byId.set(message.id, message)
  }
  // Streaming on both sides: keep the longer content (the in-flight GET is older than the stream).
  for (const message of current) {
    const merged = byId.get(message.id)
    if (merged && merged.status === STREAMING && message.status === STREAMING && merged.content.length < message.content.length) {
      byId.set(message.id, { ...merged, content: message.content })
    }
  }
  return [...byId.values()].sort((a, b) => {
    const aReal = !isOptimistic(a)
    const bReal = !isOptimistic(b)
    if (aReal !== bReal) return aReal ? -1 : 1
    return aReal ? a.seq - b.seq : 0
  })
}

/** `seq - 1` of the lowest-`seq` real message whose status is pending or streaming, else the highest real `seq`, else 0. */
export function refetchAfterSeq(messages: readonly ChatMessageDto[]): number {
  const real = messages.filter(message => !isOptimistic(message))
  const inFlight = real.filter(message => IN_FLIGHT.includes(message.status))
  if (inFlight.length > 0) return Math.min(...inFlight.map(message => message.seq)) - 1
  if (real.length > 0) return Math.max(...real.map(message => message.seq))
  return 0
}

/** True while any message (real or optimistic) is pending or streaming. */
export function isTurnRunning(messages: readonly ChatMessageDto[]): boolean {
  return messages.some(message => IN_FLIGHT.includes(message.status))
}

/** The session chip label: the active job state first, then the folded session, then none. */
export function sessionLabel(thread: ThreadDto): SessionLabel {
  const state = thread.activeJob?.state
  if (state === 'QUEUED' || state === 'ASSIGNED') return 'starting'
  if (state === 'UPLOADING') return 'closing'
  if (state === 'RUNNING') return 'live'
  if (thread.session?.state === 'failed') return 'failed'
  if (thread.session) return 'closed'
  return 'none'
}

export interface ComposerViewer {
  isCreator: boolean
}

/**
 * The composer's send state. The web never re-implements the API send checks: the reason is the
 * viewer-only case (not the creator), then `thread.sendRefusal`, then a running turn (the API sends
 * no `thread` event when a turn starts, so `sendRefusal` can lag).
 */
export function composerState(
  thread: ThreadDetailDto,
  messages: readonly ChatMessageDto[],
  viewer: ComposerViewer,
): { canSend: boolean; reason: ComposerReason | null } {
  let reason: ComposerReason | null = null
  if (!viewer.isCreator) {
    reason = 'readOnly'
  } else if (thread.sendRefusal !== null) {
    reason = thread.sendRefusal
  } else if (isTurnRunning(messages)) {
    reason = 'turnRunning'
  }
  return { canSend: reason === null, reason }
}

export type ToolChipState = 'running' | 'ok' | 'error' | 'denied' | 'unfinished'

/** One tool chip: profile-denied, running while streaming, unfinished when never resolved, else ok/error. */
export function toolChipState(entry: ToolSummaryEntry, messageStatus: string): ToolChipState {
  if (entry.decidedBy === 'profile') return 'denied'
  if (entry.isError === null) return messageStatus === STREAMING ? 'running' : 'unfinished'
  return entry.isError ? 'error' : 'ok'
}

/** A fresh id matching the API's clientMessageId format `/^[A-Za-z0-9_-]{1,64}$/`. */
export function newClientMessageId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/** Thread money exactly as received through usd(): `'1.25'`/`'5'` stay `'$1.25'`/`'$5'` (A7). */
export function costText(thread: Pick<ThreadDto, 'costUsd' | 'maxCostUsd'>): string {
  return `${usd(thread.costUsd)} / ${usd(thread.maxCostUsd)}`
}