import { computed, ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { buildTimelineQuery } from '~/lib/timeline-query'

export interface TimelineEvent {
  id: string
  eventType: string
  actorId: string
  actorName: string | null
  action: string
  ticketId?: string
  ticketRef: string | null
  ticketTitle: string | null
  createdAt: string
}

export type { TimelineQuery } from '~/lib/timeline-query'
export { buildTimelineQuery } from '~/lib/timeline-query'

export interface TimelineResponse {
  events: TimelineEvent[]
  nextCursor?: string
}

export function useTimelineEvents(slug: string) {
  const { $api } = useApi()

  const events = ref<TimelineEvent[]>([])
  const isLoading = ref(false)
  const error = ref<unknown>(null)
  const cursor = ref<string | undefined>(undefined)
  let latestRequestId = 0

  const eventTypeFilter = ref<string>('')
  const fromFilter = ref<string>('')
  const toFilter = ref<string>('')

  async function loadEvents({ append = false }: { append?: boolean } = {}) {
    const requestId = ++latestRequestId
    isLoading.value = true
    error.value = null
    try {
      const query = buildTimelineQuery({
        eventTypes: eventTypeFilter.value || undefined,
        from: fromFilter.value || undefined,
        to: toFilter.value || undefined,
        cursor: cursor.value,
      })
      const res = await $api.get<TimelineResponse>(
        apiPath`/projects/${slug}/timeline`,
        { query },
      )
      if (requestId !== latestRequestId) return
      const fetched = res.events ?? []
      events.value = append ? [...events.value, ...fetched] : fetched
      cursor.value = res.nextCursor
    }
    catch (err) {
      if (requestId !== latestRequestId) return
      error.value = err
      throw err
    }
    finally {
      if (requestId === latestRequestId) {
        isLoading.value = false
      }
    }
  }

  async function applyFilters() {
    cursor.value = undefined
    await loadEvents()
  }

  async function loadMore() {
    if (!cursor.value) return
    await loadEvents({ append: true })
  }

  const hasMore = computed(() => !!cursor.value)

  return {
    events,
    isLoading,
    error,
    cursor,
    hasMore,
    eventTypeFilter,
    fromFilter,
    toFilter,
    loadEvents,
    applyFilters,
    loadMore,
  }
}
