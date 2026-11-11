import { ref } from 'vue'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'

export type OutboxRetryOutcome = { kind: 'retried' } | { kind: 'pending'; request: ApprovalRequestSummary }

function isPendingAnswer(data: unknown): data is ApprovalRequestSummary {
  return data !== null && typeof data === 'object' && 'permissionKey' in data
}

export type OutboxStatus = 'dead' | 'pending' | 'processing' | 'published'

export interface OutboxEvent {
  id: string
  projectId: string
  type: string
  eventId: string
  payload: unknown
  headers: Record<string, unknown> | null
  status: OutboxStatus
  attempts: number
  nextAttemptAt: string | null
  leaseUntil: string | null
  owner: string | null
  lastError: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

interface OutboxResponse {
  items: OutboxEvent[]
  total: number
}

export function useAdminOutbox() {
  const { $api } = useApi()
  const items = ref<OutboxEvent[]>([])
  const total = ref(0)
  const isLoading = ref(false)
  const error = ref<unknown>(null)
  const status = ref<OutboxStatus>('dead')
  let latestRequestId = 0

  async function retry(id: string): Promise<OutboxRetryOutcome> {
    const data = await $api.post<ApprovalRequestSummary | void>(`/admin/outbox/${encodeURIComponent(id)}/retry`)
    return isPendingAnswer(data) ? { kind: 'pending', request: data } : { kind: 'retried' }
  }

  async function load(): Promise<void> {
    const requestId = ++latestRequestId
    isLoading.value = true
    error.value = null
    try {
      const response = await $api.get<OutboxResponse>('/admin/outbox', { query: { status: status.value } })
      if (requestId !== latestRequestId) return
      items.value = response.items
      total.value = response.total
    }
    catch (err: unknown) {
      if (requestId !== latestRequestId) return
      error.value = err
      throw err
    }
    finally {
      if (requestId === latestRequestId) isLoading.value = false
    }
  }

  return { items, total, isLoading, error, status, load, retry }
}
