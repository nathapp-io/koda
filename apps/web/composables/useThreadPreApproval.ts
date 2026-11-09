import { apiPath } from '~/lib/api-path'
import { isPendingFlowAnswer } from '~/lib/fleet-flows'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'

export type PreApprovalWrite =
  | { kind: 'done' }
  | { kind: 'pending'; request: ApprovalRequestSummary }

interface ThreadPreApprovalTick {
  userId: string
  at: string
  costCapUsd: string
}

interface PreApprovalCleared {
  cleared: true
}

export function useThreadPreApproval(slug: string) {
  const { $api } = useApi()
  const path = (threadId: string): string => apiPath`/projects/${slug}/threads/${threadId}/preapproval`

  async function write(request: Promise<ThreadPreApprovalTick | PreApprovalCleared | ApprovalRequestSummary>): Promise<PreApprovalWrite> {
    const answer = await request
    return isPendingFlowAnswer(answer) ? { kind: 'pending', request: answer } : { kind: 'done' }
  }

  const set = (threadId: string, costCapUsd: number): Promise<PreApprovalWrite> =>
    write($api.put<ThreadPreApprovalTick | ApprovalRequestSummary>(path(threadId), { costCapUsd }))

  const clear = (threadId: string): Promise<PreApprovalWrite> =>
    write($api.delete<PreApprovalCleared | ApprovalRequestSummary>(path(threadId)))

  return { set, clear }
}
