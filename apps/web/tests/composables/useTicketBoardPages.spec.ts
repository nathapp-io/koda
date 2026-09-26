import { describe, expect, jest, test } from '@jest/globals'
import { ref } from 'vue'
import { useTicketBoardPages, type TicketPage } from '../../composables/useTicketBoardPages'

interface Ticket { id: string }

function page(current: number, ids: string[], hasNext: boolean): TicketPage<Ticket> {
  return {
    records: ids.map(id => ({ id })),
    total: 3,
    current,
    size: 100,
    hasNext,
    hasPrev: current > 1,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useTicketBoardPages', () => {
  test('ignores a second load while the same page is in flight', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], true))
    const request = deferred<TicketPage<Ticket>>()
    const fetchPage = jest.fn((_current: number) => request.promise)
    const reportError = jest.fn((_error: unknown) => undefined)
    const board = useTicketBoardPages(firstPage, fetchPage, reportError)

    const firstLoad = board.loadMoreTickets()
    const secondLoad = board.loadMoreTickets()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith(2)

    request.resolve(page(2, ['b'], false))
    await Promise.all([firstLoad, secondLoad])
    expect(board.tickets.value.map(ticket => ticket.id)).toEqual(['a', 'b'])
    expect(board.hasNext.value).toBe(false)
  })

  test('discards a load-more response after the first page refreshes', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['old'], true))
    const request = deferred<TicketPage<Ticket>>()
    const board = useTicketBoardPages(firstPage, () => request.promise, jest.fn())

    const load = board.loadMoreTickets()
    firstPage.value = page(1, ['new'], true)
    request.resolve(page(2, ['old-page-two'], false))
    await load

    expect(board.tickets.value.map(ticket => ticket.id)).toEqual(['new'])
    expect(board.hasNext.value).toBe(true)
  })

  test('reports a failed page request and lets the user retry', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], true))
    const failure = new Error('network failed')
    const reportError = jest.fn((_error: unknown) => undefined)
    const fetchPage = jest.fn<(_current: number) => Promise<TicketPage<Ticket>>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(page(2, ['b'], false))
    const board = useTicketBoardPages(firstPage, fetchPage, reportError)

    await board.loadMoreTickets()
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(board.loadingMore.value).toBe(false)
    expect(board.tickets.value.map(ticket => ticket.id)).toEqual(['a'])

    await board.loadMoreTickets()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(board.tickets.value.map(ticket => ticket.id)).toEqual(['a', 'b'])
  })
})
