/**
 * Fleet S5a thread handoff (C2/C3): pure action availability for Publish, Plan, Run and Discard.
 * No Vue imports; the API stays the authority, so these checks only decide what the page offers.
 * Each action is an ordered pipeline: the first failing check gives the reason.
 */

import { isTerminalJobState } from '~/lib/fleet-jobs'
import { isTurnRunning, sessionLabel } from '~/lib/thread-view'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'

export type HandoffAction = 'publish' | 'plan' | 'run' | 'discard'

export type HandoffBlock =
  | 'nothingToPublish'
  | 'turnRunning'
  | 'handoffBusy'
  | 'notPublished'
  | 'sessionActive'
  | 'notPlanned'
  | 'planNotCompleted'

export interface HandoffActionState {
  enabled: boolean
  reason: HandoffBlock | null
}

export function showActionBar(thread: ThreadDetailDto, isCreator: boolean): boolean {
  // S5b 1a-R3: a PROJECT thread has no Publish, Discard, Plan or Run; the API answers 409.
  if (thread.kind === 'PROJECT') return false
  return isCreator && thread.archivedAt === null && thread.sendRefusal !== 'disabled'
}

export function showStaleBanner(thread: ThreadDetailDto): boolean {
  return thread.session?.stale === true
}

export function showKodaToolsNotice(thread: ThreadDetailDto): boolean {
  return thread.session?.state === 'live' && thread.session.kodaToolsUnavailableOn !== undefined
}

/** S5b 1c-b-D16: a live PROJECT session on a runner without projectCode cannot read the project's repos. */
export function showProjectCodeNotice(thread: ThreadDetailDto): boolean {
  return thread.session?.state === 'live' && thread.session.projectCodeUnavailableOn !== undefined
}

const COMPLETED = 'COMPLETED'

const blocked = (reason: HandoffBlock): HandoffActionState => ({ enabled: false, reason })
const allowed: HandoffActionState = { enabled: true, reason: null }

/** True while the PLAN or the RUN of the thread has a job that is not terminal. */
export function isHandoffBusy(thread: ThreadDetailDto): boolean {
  const { plan, run } = thread.handoff
  return [plan, run].some(job => job !== null && !isTerminalJobState(job.state))
}

/**
 * The availability of one handoff action. A live session does not block Publish (the API sends
 * THREAD_PUBLISH to it); a running turn or a starting/closing session does. Plan, Run and Discard
 * are blocked by any active THREAD job (`activeJob` is non-null).
 */
export function handoffActionState(
  thread: ThreadDetailDto,
  messages: readonly ChatMessageDto[],
  action: HandoffAction,
): HandoffActionState {
  switch (action) {
    case 'publish': {
      if (thread.writtenPaths.length === 0) return blocked('nothingToPublish')
      if (isHandoffBusy(thread)) return blocked('handoffBusy')
      const label = sessionLabel(thread)
      if (isTurnRunning(messages) || label === 'starting' || label === 'closing') return blocked('turnRunning')
      return allowed
    }
    case 'plan': {
      if (!thread.specPublished) return blocked('notPublished')
      if (isHandoffBusy(thread)) return blocked('handoffBusy')
      if (thread.activeJob !== null) return blocked('sessionActive')
      return allowed
    }
    case 'run': {
      const plan = thread.handoff.plan
      if (plan === null) return blocked('notPlanned')
      if (isHandoffBusy(thread)) return blocked('handoffBusy')
      if (plan.state !== COMPLETED) return blocked('planNotCompleted')
      if (thread.activeJob !== null) return blocked('sessionActive')
      return allowed
    }
    case 'discard': {
      if (isHandoffBusy(thread)) return blocked('handoffBusy')
      if (thread.activeJob !== null) return blocked('sessionActive')
      return allowed
    }
  }
}
