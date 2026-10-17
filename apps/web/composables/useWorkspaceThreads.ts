/**
 * Fleet S5b 1d (US-004): the signed-in user's own workspace threads.
 *
 * Thin client over the top-level GET /threads (workspace-threads.controller.ts): the API is the
 * authority on which threads exist and whether threads are enabled at all, and it already scopes
 * the list to the caller's own threads, so there is no project slug and no membership question.
 * The page owns the ACTIVE/ARCHIVED toggle via `status`.
 *
 * A user can own more threads than one page holds, so the list pages like the member list does:
 * `load()` replaces the list with page 1 (and resets pagination), `loadMore()` appends the next
 * page. The API's `/threads` list answers no `total`/`hasNext`, only `items`, so a page that comes
 * back full is the signal that older threads may sit behind it (B2).
 */
import { ref } from 'vue'
import type { ThreadDto } from '~/lib/thread-types'
import type { Ref } from 'vue'

/** The API's maximum `size` (workspace-threads.controller.ts): the widest page one read may ask for. */
const PAGE_SIZE = 100

/** One page of the personal list: the rows plus the kill switch the API reports with them. */
interface ThreadPage {
  items: ThreadDto[]
  threadsEnabled: boolean
}

type ThreadStatus = 'ACTIVE' | 'ARCHIVED'

export interface WorkspaceThreadList {
  threads: Ref<ThreadDto[]>
  threadsEnabled: Ref<boolean>
  status: Ref<ThreadStatus>
  /** The page the list currently holds: `load()` resets it to 1, `loadMore()` advances it. */
  current: Ref<number>
  /** True when the last page came back full, so older threads may sit behind it. */
  hasNext: Ref<boolean>
  loadingMore: Ref<boolean>
  load: (status?: ThreadStatus) => Promise<void>
  loadMore: () => Promise<void>
}

/** The caller's workspace threads; `load()` defaults to the active ones and starts at page 1. */
export function useWorkspaceThreads(): WorkspaceThreadList {
  const { $api } = useApi()
  const threads = ref<ThreadDto[]>([])
  const threadsEnabled = ref(true)
  const status = ref<ThreadStatus>('ACTIVE')
  const current = ref(1)
  const hasNext = ref(false)
  const loadingMore = ref(false)

  /**
   * One page of the list. Page 1 sends no `page`: the API defaults to it, and the first read stays
   * exactly `{ status, size }` (US-004 AC-6).
   */
  function fetchPage(next: ThreadStatus, pageNumber: number): Promise<ThreadPage> {
    const query: Record<string, string> = { status: next, size: String(PAGE_SIZE) }
    if (pageNumber > 1) query.page = String(pageNumber)
    return $api.get<ThreadPage>('/threads', { query })
  }

  const load = async (next: ThreadStatus = 'ACTIVE'): Promise<void> => {
    const response = await fetchPage(next, 1)
    threads.value = response.items
    threadsEnabled.value = response.threadsEnabled
    status.value = next
    current.value = 1
    hasNext.value = response.items.length === PAGE_SIZE
  }

  /** Append the page after the one held; a no-op when the last page was not full. */
  const loadMore = async (): Promise<void> => {
    if (loadingMore.value || !hasNext.value) return
    const next = current.value + 1
    const requested = status.value
    loadingMore.value = true
    try {
      const response = await fetchPage(requested, next)
      // The status switch resets the list while this read is in flight: its rows belong to the old one.
      if (status.value !== requested) return
      threads.value = [...threads.value, ...response.items]
      threadsEnabled.value = response.threadsEnabled
      current.value = next
      hasNext.value = response.items.length === PAGE_SIZE
    }
    finally {
      loadingMore.value = false
    }
  }

  return { threads, threadsEnabled, status, current, hasNext, loadingMore, load, loadMore }
}
