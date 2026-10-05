import { onBeforeUnmount, onMounted } from 'vue'
import { browserPollingDeps } from '~/composables/useVisiblePolling'
import type { PollingDeps } from '~/composables/useVisiblePolling'

/** Calls `fn` whenever the tab becomes visible; returns the unsubscribe. */
export function watchVisible(fn: () => void, deps: Pick<PollingDeps, 'onVisible'>): () => void {
  return deps.onVisible(fn)
}

/** Spec §5.2: refetch on tab focus, no polling. Browser-only (subscribes on mount). */
export function useRefetchOnVisible(fn: () => void): void {
  let stop: (() => void) | null = null
  onMounted(() => {
    if (typeof document === 'undefined') return
    stop = watchVisible(fn, browserPollingDeps())
  })
  onBeforeUnmount(() => {
    stop?.()
    stop = null
  })
}
