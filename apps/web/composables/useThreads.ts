/**
 * Fleet S5a §4 (US-003): the thread list for one project.
 *
 * Thin client over GET /projects/:slug/threads: the API is the authority on which threads exist
 * and whether threads are enabled at all. The page owns the ACTIVE/ARCHIVED toggle via `status`.
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ThreadDto } from '~/lib/thread-types'
import type { Ref } from 'vue'

export interface ThreadList {
  threads: Ref<ThreadDto[]>
  threadsEnabled: Ref<boolean>
  status: Ref<'ACTIVE' | 'ARCHIVED'>
  load: (status?: 'ACTIVE' | 'ARCHIVED') => Promise<void>
}

/** The thread list for a project; `load()` defaults to the active threads. */
export function useThreads(slug: string): ThreadList {
  const { $api } = useApi()
  const threads = ref<ThreadDto[]>([])
  const threadsEnabled = ref(true)
  const status = ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE')

  const load = async (next: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE'): Promise<void> => {
    const response = await $api.get<{ items: ThreadDto[]; threadsEnabled: boolean }>(
      apiPath`/projects/${slug}/threads`,
      { query: { status: next, size: '100' } },
    )
    threads.value = response.items
    threadsEnabled.value = response.threadsEnabled
    status.value = next
  }

  return { threads, threadsEnabled, status, load }
}