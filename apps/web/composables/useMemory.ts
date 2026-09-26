import { computed, ref } from 'vue'

export interface MemoryItem {
  id: string
  subject: string
  predicate: string
  object: string
  kind: string
  confidence: number
  status: string
}

export interface MemoryQuery {
  kind?: string
  status?: string
  page?: number
}

export interface MemoryResponse {
  records: MemoryItem[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

export function buildMemoryQuery(
  filters: MemoryQuery,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.kind) query.kind = filters.kind
  if (filters.status) query.status = filters.status
  if (filters.page && filters.page > 1) query.current = String(filters.page)
  return query
}

export function useMemory(slug: string) {
  const { $api } = useApi()

  const items = ref<MemoryItem[]>([])
  const isLoading = ref(false)
  const error = ref<unknown>(null)
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)
  let latestRequestId = 0

  const kindFilter = ref<string>('')
  const statusFilter = ref<string>('')

  const hasMore = computed(() => hasNext.value)

  async function loadMemory({ append = false }: { append?: boolean } = {}) {
    const requestId = ++latestRequestId
    isLoading.value = true
    error.value = null
    try {
      const query = buildMemoryQuery({
        kind: kindFilter.value || undefined,
        status: statusFilter.value || undefined,
        page: page.value || undefined,
      })
      const res = await $api.get<MemoryResponse>(
        `/projects/${slug}/memory`,
        { query },
      )
      if (requestId !== latestRequestId) return
      const fetched = res.records ?? []
      items.value = append ? [...items.value, ...fetched] : fetched
      total.value = res.total ?? items.value.length
      hasNext.value = res.hasNext ?? false
    }
    catch (err) {
      if (requestId !== latestRequestId) return
      error.value = err
      // On a failed initial load, clear items so the empty-state copy
      // doesn't show stale data. On a failed append (loadMore), preserve
      // the rows already loaded so the user can retry without losing
      // what they had.
      if (!append) {
        items.value = []
        total.value = 0
        hasNext.value = false
      }
      // If this was an append that we incremented page for, restore it
      // so the next retry re-fetches the same page instead of skipping.
      if (append && page.value > 1) {
        page.value -= 1
      }
      throw err
    }
    finally {
      if (requestId === latestRequestId) {
        isLoading.value = false
      }
    }
  }

  async function applyFilters() {
    page.value = 1
    await loadMemory()
  }

  async function loadMore() {
    if (!hasMore.value) return
    page.value += 1
    // loadMemory already handles page-restore and error propagation
    // internally — a failed append decrements `page` and re-throws so
    // the page wrapper surfaces the error via toast.
    await loadMemory({ append: true })
  }

  return {
    items,
    isLoading,
    error,
    total,
    page,
    hasMore,
    kindFilter,
    statusFilter,
    loadMemory,
    applyFilters,
    loadMore,
  }
}
