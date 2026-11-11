import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'

export type RetireOutcome =
  | { kind: 'retired' }
  | { kind: 'pending'; request: ApprovalRequestSummary }

function isPendingAnswer(data: unknown): data is ApprovalRequestSummary {
  return data !== null && typeof data === 'object' && 'permissionKey' in data
}

function retireOutcome(data: unknown): RetireOutcome {
  return isPendingAnswer(data)
    ? { kind: 'pending', request: data }
    : { kind: 'retired' }
}

export interface MemoryItem {
  id: string
  subject: string
  predicate: string
  object: string
  kind: string
  confidence: number
  status: string
  description?: string
  scope: string
}

export interface MemoryQuery {
  kind?: string
  status?: string
  text?: string
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

/**
 * Clamp the search text to the API's 100-character bound without splitting a surrogate pair.
 *
 * `String#slice` counts UTF-16 code units, so cutting an emoji (or any astral character) at the boundary would
 * send half a pair — malformed Unicode that corrupts the query. The unit length is kept, because the API's
 * `@MaxLength(100)` counts code units too; only a trailing high surrogate (the half a cut would leave) is
 * dropped, which costs one character and never produces an unpaired one.
 */
export function clampSearchText(text: string, max = 100): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  const endsOnHighSurrogate = last >= 0xd800 && last <= 0xdbff
  return endsOnHighSurrogate ? cut.slice(0, -1) : cut
}

export function buildMemoryQuery(
  filters: MemoryQuery,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.kind) query.kind = filters.kind
  if (filters.status) query.status = filters.status
  if (filters.text) query.text = clampSearchText(filters.text)
  if (filters.page && filters.page > 1) query.current = String(filters.page)
  return query
}

export function watchDebouncedMemorySearch(search: Ref<string>, onSearch: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = watch(search, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onSearch()
    }, 300)
  })
  onScopeDispose(() => {
    stop()
    if (timer) clearTimeout(timer)
  })
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
  const textFilter = ref<string>('')

  const hasMore = computed(() => hasNext.value)

  async function loadMemory({ append = false }: { append?: boolean } = {}) {
    const requestId = ++latestRequestId
    isLoading.value = true
    error.value = null
    try {
      const query = buildMemoryQuery({
        kind: kindFilter.value || undefined,
        status: statusFilter.value || undefined,
        text: textFilter.value.trim() || undefined,
        page: page.value || undefined,
      })
      const res = await $api.get<MemoryResponse>(
        apiPath`/projects/${slug}/memory`,
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

  async function retireDecision(id: string, reason?: string): Promise<RetireOutcome> {
    const trimmedReason = reason?.trim()
    const data = await $api.post<unknown>(
      apiPath`/memory/${id}/retire`,
      trimmedReason ? { reason: trimmedReason } : {},
    )
    return retireOutcome(data)
  }

  async function retireNote(id: string, projectId: string, reason?: string): Promise<RetireOutcome> {
    const trimmedReason = reason?.trim()
    const data = await $api.post<unknown>(
      apiPath`/memory/notes/${id}/retire`,
      { projectId, ...(trimmedReason ? { reason: trimmedReason } : {}) },
    )
    return retireOutcome(data)
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
    textFilter,
    loadMemory,
    applyFilters,
    loadMore,
    retireDecision,
    retireNote,
  }
}
