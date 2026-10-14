import { watch } from 'vue'
import type { Ref } from 'vue'
import { createHandoffJobs } from '~/lib/thread-handoff-jobs'
import type { HandoffJobsController } from '~/lib/thread-handoff-jobs'
import type { ThreadDetailDto } from '~/lib/thread-types'

/** Reactively loads and refreshes the latest PLAN and RUN details for the current thread. */
export function useThreadHandoffJobs(
  slug: string,
  thread: Ref<ThreadDetailDto | null>,
): HandoffJobsController {
  const { $api } = useApi()
  const controller = createHandoffJobs({ slug, api: $api })
  watch(() => thread.value?.handoff, handoff => {
    if (handoff !== undefined && handoff !== null) void controller.sync(handoff)
  }, { immediate: true })
  return controller
}
