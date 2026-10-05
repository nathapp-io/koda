import { ref } from 'vue'
import type { Ref } from 'vue'

export type PanelStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * D393: one analytics query's state. A refetch keeps the old data on screen (no flicker back to loading); an error
 * clears it; an answer older than the latest run is dropped. The panel reports, the page decides what to show.
 */
export function useAnalyticsPanel<T>(load: () => Promise<T>, isEmpty: (data: T) => boolean) {
  const status = ref<PanelStatus>('idle')
  const data = ref(null) as Ref<T | null>
  let latest = 0

  async function run(): Promise<void> {
    const id = ++latest
    if (data.value === null) status.value = 'loading'
    try {
      const next = await load()
      if (id !== latest) return
      data.value = next
      status.value = isEmpty(next) ? 'empty' : 'ready'
    } catch {
      if (id !== latest) return
      data.value = null
      status.value = 'error'
    }
  }

  return { status, data, run }
}
