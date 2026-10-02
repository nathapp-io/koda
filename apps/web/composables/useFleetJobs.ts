import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { bundleFileName, pickActiveJob } from '~/lib/fleet-jobs'
import type { DispatchBody, DispatchResultDto, FleetJobDto, FleetJobEventDto, FleetPage } from '~/lib/fleet-types'
import { saveBlob } from '~/lib/save-blob'

export const FLEET_JOB_PAGE_SIZE = 20
export const FLEET_EVENT_PAGE_SIZE = 50

export interface FleetJobFilters {
  state?: string
  repoId?: string
  runnerId?: string
  requestedById?: string
  scheduleId?: string
  page?: number
}

/** Only set filters reach the query; `current` only past page 1 (same rule as the admin users page). */
export function buildJobQuery(filters: FleetJobFilters): Record<string, string> {
  const entries: Array<[string, string | undefined]> = [
    ['state', filters.state],
    ['repoId', filters.repoId],
    ['runnerId', filters.runnerId],
    ['requestedById', filters.requestedById],
    ['scheduleId', filters.scheduleId],
  ]
  const query = Object.fromEntries(entries.filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0))
  return {
    ...query,
    size: String(FLEET_JOB_PAGE_SIZE),
    ...(filters.page && filters.page > 1 ? { current: String(filters.page) } : {}),
  }
}

/** Fleet jobs of one project (S1 spec §3.4). Every call goes through useApi; nothing here is page state but the list. */
export function useFleetJobs(slug: string) {
  const { $api } = useApi()
  const base = apiPath`/projects/${slug}/fleet/jobs`
  const jobPath = (id: string): string => apiPath`/projects/${slug}/fleet/jobs/${id}`

  const jobs = ref<FleetJobDto[]>([])
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)
  let latestLoadId = 0

  async function load(filters: FleetJobFilters = {}): Promise<boolean> {
    const loadId = ++latestLoadId
    try {
      const res = await $api.get<FleetPage<FleetJobDto>>(base, { query: buildJobQuery(filters) })
      if (loadId !== latestLoadId) return false
      jobs.value = res.records ?? []
      total.value = res.total ?? 0
      page.value = res.current ?? 1
      hasNext.value = res.hasNext === true
      return true
    }
    catch (error) {
      if (loadId === latestLoadId) throw error
      return false
    }
  }

  const get = (id: string): Promise<FleetJobDto> => $api.get<FleetJobDto>(jobPath(id))

  const events = (id: string, current: number): Promise<FleetPage<FleetJobEventDto>> =>
    $api.get<FleetPage<FleetJobEventDto>>(apiPath`/projects/${slug}/fleet/jobs/${id}/events`, {
      query: { current: String(current), size: String(FLEET_EVENT_PAGE_SIZE) },
    })

  const dispatch = (body: DispatchBody): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(base, { ...body })

  const cancel = (id: string): Promise<FleetJobDto> => $api.post<FleetJobDto>(apiPath`/projects/${slug}/fleet/jobs/${id}/cancel`)

  const requeue = (id: string): Promise<DispatchResultDto> =>
    $api.post<DispatchResultDto>(apiPath`/projects/${slug}/fleet/jobs/${id}/requeue`)

  /** D121: the job behind a dispatch 409 (at most one active job per repo and feature). */
  async function findActiveJob(repoId: string, feature: string): Promise<FleetJobDto | null> {
    const res = await $api.get<FleetPage<FleetJobDto>>(base, { query: { repoId, feature, size: '20' } })
    return pickActiveJob(res.records ?? [])
  }

  /** D127: fetch the bundle as a Blob (an API error propagates, no file is made), then save it. */
  async function downloadBundle(id: string): Promise<void> {
    saveBlob(await $api.download(apiPath`/projects/${slug}/fleet/jobs/${id}/bundle`), bundleFileName(id))
  }

  return { jobs, total, page, hasNext, load, get, events, dispatch, cancel, requeue, findActiveJob, downloadBundle }
}
