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

  return { tickets, hasNext, loadingMore, loadMoreTickets }
}
