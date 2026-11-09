import type { ThreadDto, ThreadPreApproval } from './thread-types'

export type TickHint = 'none' | 'notYours' | 'exceeded' | 'covers'

/** Suggest the native thread model for both flow roles; other backends need explicit role models. */
export function defaultFlowRoles(thread: ThreadDto): { reviewer: string; supervisor: string } {
  const model = thread.backend.kind === 'native' ? thread.backend.model ?? '' : ''
  return { reviewer: model, supervisor: model }
}

/** Advisory estimate of whether the current thread pre-approval covers this flow. */
export function tickHint(
  tick: ThreadPreApproval | null,
  costCapUsd: number,
  viewer: { userId: string; isThreadCreator: boolean },
): TickHint {
  if (!tick) return 'none'

  if (tick.userId !== viewer.userId && !viewer.isThreadCreator) return 'notYours'

  const tickCap = Math.round(Number(tick.costCapUsd) * 10_000)
  const flowCap = Math.round(costCapUsd * 10_000)
  if (flowCap > tickCap) return 'exceeded'

  return 'covers'
}
