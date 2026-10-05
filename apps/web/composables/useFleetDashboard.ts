import { computed, ref, shallowRef } from 'vue'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { useVisiblePolling } from '~/composables/useVisiblePolling'
import type { PollingDeps } from '~/composables/useVisiblePolling'
import { apiPath } from '~/lib/api-path'
import { CLOCK_TICK_MS, DASHBOARD_POLL_MS, hhmm, serverNow } from '~/lib/fleet-dashboard'
import type { DashboardScope, FleetDashboard } from '~/lib/fleet-dashboard-types'

/** Spec §1.1: one snapshot route per scope. */
export function dashboardPath(scope: DashboardScope): string {
  return scope.kind === 'global' ? '/fleet/dashboard' : apiPath`/projects/${scope.slug}/fleet/dashboard`
}

/**
 * Fleet S2b (c) spec §4.1 (D420, D421): the fleet health snapshot for one scope, refreshed every 10 s while the tab
 * is visible, plus a 1 s clock so ages advance between polls. A failed poll keeps the last snapshot; a 403 stops
 * everything. The page calls `start` in onMounted and `stop` in onBeforeUnmount.
 */
export function useFleetDashboard(scope: DashboardScope, deps: { polling?: PollingDeps; clock?: () => number } = {}) {
  const { $api } = useApi()
  const clock = deps.clock ?? ((): number => Date.now())
  const data = shallowRef<FleetDashboard | null>(null)
  const error = shallowRef<unknown>(null)
  const pending = ref(false)
  const forbidden = ref(false)
  const lastSuccessAt = ref<number | null>(null)
  const receivedAt = ref(0)
  const clientNow = ref(clock())

  async function refresh(): Promise<void> {
    if (forbidden.value) return
    pending.value = true
    try {
      const next = await $api.get<FleetDashboard>(dashboardPath(scope))
      const at = clock()
      data.value = next
      error.value = null
      receivedAt.value = at
      clientNow.value = at
      lastSuccessAt.value = at
    } catch (err: unknown) {
      error.value = err
      if (isForbidden(err)) {
        forbidden.value = true
        stop()
      }
    } finally {
      pending.value = false
    }
  }

  const poller = useVisiblePolling(refresh, DASHBOARD_POLL_MS, deps.polling)
  const ticker = useVisiblePolling(async () => { clientNow.value = clock() }, CLOCK_TICK_MS, deps.polling)

  function start(): void {
    void poller.runNow()
    poller.start()
    ticker.start()
  }

  function stop(): void {
    poller.stop()
    ticker.stop()
  }

  /** D416: server time now; before the first snapshot, the client clock (nothing is aged yet). */
  const now = computed(() =>
    data.value ? serverNow(data.value.generatedAt, receivedAt.value, clientNow.value) : new Date(clientNow.value))

  /** D420: no snapshot yet and the last load failed (the page shows ErrorState with Retry). */
  const failed = computed(() => error.value !== null && data.value === null)
  /** D420: a later poll failed; the client time of the last success, as HH:MM. */
  const staleSince = computed(() =>
    (error.value !== null && data.value !== null && lastSuccessAt.value !== null ? hhmm(lastSuccessAt.value) : null))

  return { data, error, pending, forbidden, lastSuccessAt, now, failed, staleSince, refresh, start, stop }
}
