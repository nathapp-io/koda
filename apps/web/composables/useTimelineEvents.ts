import { computed, ref } from 'vue'
import { apiPath } from '~/lib/api-path'

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

export interface TimelineQuery {
  eventTypes?: string
  from?: string
  to?: string
  cursor?: string
}

export interface TimelineResponse {
  events: TimelineEvent[]
  nextCursor?: string
}

function localDateBound(value: string, isEnd: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value

  const [, year, month, day] = match
  const date = new Date(0)
  date.setFullYear(Number(year), Number(month) - 1, Number(day))
  date.setHours(0, 0, 0, 0)
  if (isEnd) {
    date.setDate(date.getDate() + 1)
    date.setMilliseconds(-1)
  }
  return date.toISOString()
}

export function buildTimelineQuery(
  filters: TimelineQuery,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.eventTypes) query.eventTypes = filters.eventTypes
  if (filters.from) query.from = localDateBound(filters.from, false)
  if (filters.to) query.to = localDateBound(filters.to, true)
  if (filters.cursor) query.cursor = filters.cursor
  return query
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
