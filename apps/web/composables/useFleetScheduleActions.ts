import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { FleetSchedulesApi } from '~/composables/useFleetSchedules'
import type { ScheduleDto } from '~/lib/fleet-types'

/**
 * Enable, disable and delete, shared by the list and the detail page (D223). A refusal (409 owner lost access, 404
 * stale, 403) shows the server's message and calls `onStale` so the page reloads; nothing is retried.
 */
export function useFleetScheduleActions(api: Pick<FleetSchedulesApi, 'enable' | 'disable' | 'remove'>, onStale: () => void) {
  const { t } = useI18n()
  const toast = useAppToast()
  const busy = ref(false)

  async function run<T>(action: () => Promise<T>, successKey: string): Promise<T | null> {
    busy.value = true
    try {
      const result = await action()
      toast.success(t(successKey))
      return result
    }
    catch (err: unknown) {
      toast.error(extractApiError(err))
      onStale()
      return null
    }
    finally {
      busy.value = false
    }
  }

  const setEnabled = (s: ScheduleDto, enabled: boolean): Promise<ScheduleDto | null> =>
    run(() => (enabled ? api.enable(s.id) : api.disable(s.id)), enabled ? 'fleet.schedules.toast.enabled' : 'fleet.schedules.toast.disabled')

  /** True when the schedule is gone. */
  async function remove(s: ScheduleDto): Promise<boolean> {
    if (!window.confirm(t('fleet.schedules.deleteConfirm', { name: s.name }))) return false
    const done = await run(async () => {
      await api.remove(s.id)
      return true
    }, 'fleet.schedules.toast.deleted')
    return done === true
  }

  return { busy, setEnabled, remove }
}
