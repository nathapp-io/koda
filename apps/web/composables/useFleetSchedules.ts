import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { sortSchedules } from '~/lib/fleet-schedules'
import type { NewScheduleBody, ScheduleDto, SchedulePatchBody } from '~/lib/fleet-types'

export const scheduleRoot = (slug: string): string => apiPath`/projects/${slug}/fleet/schedules`
export const scheduleItem = (slug: string, id: string): string => apiPath`/projects/${slug}/fleet/schedules/${id}`

/**
 * Mutation epoch shared by every instance on the page (D224): a load that started before a successful mutation is
 * dropped, the next one brings fresh rows. Same reasoning as useFleetBudgets.
 */
let mutationEpoch = 0

/** The schedules of one project (S1b §3.4): a plain array, no paging (3a D202). */
export function useFleetSchedules(slug: string) {
  const { $api } = useApi()
  const schedules = ref<ScheduleDto[]>([])
  let latestLoadId = 0

  async function load(): Promise<void> {
    const loadId = ++latestLoadId
    const epoch = mutationEpoch
    const rows = await $api.get<ScheduleDto[]>(scheduleRoot(slug))
    if (loadId !== latestLoadId || epoch !== mutationEpoch) return
    schedules.value = sortSchedules(rows ?? [])
  }

  const get = async (id: string): Promise<ScheduleDto | null> => {
    const epoch = mutationEpoch
    const row = await $api.get<ScheduleDto>(scheduleItem(slug, id))
    return epoch === mutationEpoch ? row : null
  }

  /** Puts a saved row in the list (replacing the same id) and invalidates in-flight loads. */
  function apply(saved: ScheduleDto): void {
    mutationEpoch += 1
    schedules.value = sortSchedules([...schedules.value.filter((s) => s.id !== saved.id), saved])
  }

  async function applied(request: Promise<ScheduleDto>): Promise<ScheduleDto> {
    const saved = await request
    apply(saved)
    return saved
  }

  const create = (body: NewScheduleBody): Promise<ScheduleDto> => applied($api.post<ScheduleDto>(scheduleRoot(slug), { ...body }))
  const update = (id: string, patch: SchedulePatchBody): Promise<ScheduleDto> =>
    applied($api.patch<ScheduleDto>(scheduleItem(slug, id), { ...patch }))
  const enable = (id: string): Promise<ScheduleDto> => applied($api.post<ScheduleDto>(`${scheduleItem(slug, id)}/enable`))
  const disable = (id: string): Promise<ScheduleDto> => applied($api.post<ScheduleDto>(`${scheduleItem(slug, id)}/disable`))

  async function remove(id: string): Promise<void> {
    await $api.delete(scheduleItem(slug, id))
    mutationEpoch += 1
    schedules.value = schedules.value.filter((s) => s.id !== id)
  }

  return { schedules, load, get, apply, create, update, enable, disable, remove }
}

export type FleetSchedulesApi = ReturnType<typeof useFleetSchedules>
