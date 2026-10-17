/**
 * Fleet S5b 1d (US-004): the signed-in user's own workspace threads.
 *
 * Thin client over the top-level GET /threads (workspace-threads.controller.ts): the API is the
 * authority on which threads exist and whether threads are enabled at all, and it already scopes
 * the list to the caller's own threads, so there is no project slug and no membership question.
 * The page owns the ACTIVE/ARCHIVED toggle via `status`.
 */
import { ref } from 'vue'
import type { ThreadDto } from '~/lib/thread-types'
import type { Ref } from 'vue'

export interface WorkspaceThreadList {
  threads: Ref<ThreadDto[]>
  threadsEnabled: Ref<boolean>
  status: Ref<'ACTIVE' | 'ARCHIVED'>
  load: (status?: 'ACTIVE' | 'ARCHIVED') => Promise<void>
}

/** The caller's workspace threads; `load()` defaults to the active ones. */
export function useWorkspaceThreads(): WorkspaceThreadList {
  const { $api } = useApi()
  const threads = ref<ThreadDto[]>([])
  const threadsEnabled = ref(true)
  const status = ref<'ACTIVE' | 'ARCHIVED'>('ACTIVE')

  const load = async (next: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE'): Promise<void> => {
    const response = await $api.get<{ items: ThreadDto[]; threadsEnabled: boolean }>(
      '/threads',
      { query: { status: next, size: '100' } },
    )
    threads.value = response.items
    threadsEnabled.value = response.threadsEnabled
    status.value = next
  }

  return { threads, threadsEnabled, status, load }
}
