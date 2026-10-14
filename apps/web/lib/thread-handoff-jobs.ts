import { shallowRef } from 'vue'
import type { Ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { HandoffJobs } from '~/lib/thread-timeline'
import type { ThreadHandoff } from '~/lib/thread-types'

export interface HandoffJobsDeps {
  api: { get: <T = unknown>(path: string) => Promise<T> }
  slug: string
}

export interface HandoffJobsController {
  jobs: Ref<HandoffJobs>
  sync: (handoff: ThreadHandoff) => Promise<void>
  refreshJob: (jobId: string) => Promise<void>
  isHandoffJob: (jobId: string) => boolean
}

/** Loads the detail records backing a thread's latest PLAN and RUN cards. */
export function createHandoffJobs(deps: HandoffJobsDeps): HandoffJobsController {
  const jobs = shallowRef<HandoffJobs>({ plan: null, run: null })
  let handoff: ThreadHandoff = { plan: null, run: null }
  const setSlot = (slot: keyof HandoffJobs, job: FleetJobDto | null): void => {
    jobs.value = { ...jobs.value, [slot]: job }
  }

  // Latest request per slot; a response only applies while it is still the newest for a job still in the handoff.
  const tickets: Record<keyof HandoffJobs, number> = { plan: 0, run: 0 }
  const isCurrent = (slot: keyof HandoffJobs, ticket: number, jobId: string): boolean =>
    tickets[slot] === ticket && handoff[slot]?.jobId === jobId

  const fetchSlot = async (slot: keyof HandoffJobs, jobId: string): Promise<void> => {
    tickets[slot] += 1
    const ticket = tickets[slot]
    try {
      const job = await deps.api.get<FleetJobDto>(apiPath`/projects/${deps.slug}/fleet/jobs/${jobId}`)
      if (isCurrent(slot, ticket, jobId)) setSlot(slot, job)
    } catch {
      if (isCurrent(slot, ticket, jobId) && jobs.value[slot]?.id !== jobId) setSlot(slot, null)
    }
  }

  const sync = async (next: ThreadHandoff): Promise<void> => {
    handoff = next
    await Promise.all((['plan', 'run'] as const).map(async slot => {
      const entry = next[slot]
      if (entry === null) {
        tickets[slot] += 1
        setSlot(slot, null)
        return
      }
      const cached = jobs.value[slot]
      if (cached?.id === entry.jobId && cached.state === entry.state) return
      await fetchSlot(slot, entry.jobId)
    }))
  }

  const isHandoffJob = (jobId: string): boolean =>
    handoff.plan?.jobId === jobId || handoff.run?.jobId === jobId

  const refreshJob = async (jobId: string): Promise<void> => {
    if (!isHandoffJob(jobId)) return
    const slot = handoff.plan?.jobId === jobId ? 'plan' : 'run'
    await fetchSlot(slot, jobId)
  }

  return { jobs, sync, refreshJob, isHandoffJob }
}
