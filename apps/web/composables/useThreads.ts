/**
 * Fleet S5a §4 (US-003): the thread list for one project.
 *
 * Thin client over GET /projects/:slug/threads: the API is the authority on which threads exist
 * and whether threads are enabled at all. The page owns the ACTIVE/ARCHIVED toggle via `status`.
 *
 * A user can switch that toggle faster than the API answers, so this mirrors
 * `useWorkspaceThreads` (fleet S5b 1d): `load()` keeps a generation counter and reports whether its
 * read applied, so an overtaken read writes nothing and its caller does not act on it (koda#294).
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ThreadDto } from '~/lib/thread-types'
import type { Ref } from 'vue'

type ThreadStatus = 'ACTIVE' | 'ARCHIVED'

export interface ThreadList {
  threads: Ref<ThreadDto[]>
  threadsEnabled: Ref<boolean>
  status: Ref<ThreadStatus>
  /** Resolves `true` when this read filled the list, `false` when a newer `load()` overtook it. */
  load: (status?: ThreadStatus) => Promise<boolean>
}

/** The thread list for a project; `load()` defaults to the active threads. */
export function useThreads(slug: string): ThreadList {
  const { $api } = useApi()
  const threads = ref<ThreadDto[]>([])
  const threadsEnabled = ref(true)
  const status = ref<ThreadStatus>('ACTIVE')

  /** Bumped by every `load()`: the read that started last is the one whose answer counts. */
  let generation = 0

  /**
   * Resolves `true` when this read filled the list, `false` when a newer `load()` overtook it and it
   * wrote nothing — not the rows, not the kill switch, not the status (koda#294). An overtaken read
   * that fails still rejects: the caller is told, and the generation guard alone keeps its writes off.
   */
  const load = async (next: ThreadStatus = 'ACTIVE'): Promise<boolean> => {
    const mine = ++generation
    const response = await $api.get<{ items: ThreadDto[]; threadsEnabled: boolean }>(
      apiPath`/projects/${slug}/threads`,
      { query: { status: next, size: '100' } },
    )
    // A newer load() owns the list now: its answer is the one on screen.
    if (generation !== mine) return false
    threads.value = response.items
    threadsEnabled.value = response.threadsEnabled
    status.value = next
    return true
  }

  return { threads, threadsEnabled, status, load }
}
