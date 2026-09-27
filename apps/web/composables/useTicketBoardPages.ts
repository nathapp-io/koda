import { computed, shallowRef, watch, type Ref } from 'vue'

export interface TicketPage<T> {
  records: T[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

export function useTicketBoardPages<T>(
  firstPage: Ref<TicketPage<T> | null | undefined>,
  fetchPage: (current: number) => Promise<TicketPage<T>>,
  reportError: (error: unknown) => void,
) {
  const moreTickets = shallowRef<T[]>([])
  const lastPage = shallowRef<TicketPage<T> | null>(null)
  const loadingMore = shallowRef(false)
  let firstPageGeneration = 0

  watch(firstPage, () => {
    firstPageGeneration += 1
    moreTickets.value = []
    lastPage.value = null
  }, { flush: 'sync' })

  const tickets = computed(() => [...(firstPage.value?.records ?? []), ...moreTickets.value])
  const hasNext = computed(() => (lastPage.value ?? firstPage.value)?.hasNext ?? false)

  async function loadMoreTickets() {
    if (loadingMore.value || !hasNext.value || !firstPage.value) return

    const generation = firstPageGeneration
    const current = (lastPage.value ?? firstPage.value).current
    loadingMore.value = true
    try {
      const next = await fetchPage(current + 1)
      if (generation !== firstPageGeneration) return
      moreTickets.value = [...moreTickets.value, ...next.records]
      lastPage.value = next
    }
    catch (error) {
      if (generation === firstPageGeneration) reportError(error)
    }
    finally {
      loadingMore.value = false
    }
  }

  let reloadGeneration = 0

  /**
   * Live refresh (Track 1 Slice 5): refetch page 1 and every page already
   * loaded, then swap them in together, so a live update neither collapses the
   * board back to page 1 nor flips useAsyncData's `pending` (which would show
   * the loading state). Pages are fetched one at a time so a board with many
   * loaded pages does not burst the API on every live event. Failures are
   * silent: the next event or resync retries.
   */
  async function reloadLoaded(): Promise<boolean> {
    reloadGeneration += 1
    const generation = reloadGeneration
    const loadedThrough = (lastPage.value ?? firstPage.value)?.current ?? 1
    const pages: TicketPage<T>[] = []
    try {
      for (let current = 1; current <= loadedThrough; current += 1) {
        const page = await fetchPage(current)
        if (generation !== reloadGeneration) return false
        pages.push(page)
      }
      firstPage.value = pages[0]
      moreTickets.value = pages.slice(1).flatMap(p => p.records)
      lastPage.value = pages.length > 1 ? pages[pages.length - 1] : null
      return true
    }
    catch {
      return false
    }
  }

  return { tickets, hasNext, loadingMore, loadMoreTickets, reloadLoaded }
}
