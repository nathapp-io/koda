export type ApprovalDecision = 'approve' | 'reject'

/** Minimal client for decisions on the unified ApprovalRequest route. */
export function useApprovalRequests() {
  const { $api } = useApi()

  async function decide(id: string, decision: ApprovalDecision, comment?: string): Promise<void> {
    const body: { decision: ApprovalDecision; comment?: string } = { decision }
    if (typeof comment === 'string' && comment.length > 0) body.comment = comment
    await $api.post(`/approvals/${encodeURIComponent(id)}/decisions`, body)
  }

  return { decide }
}
