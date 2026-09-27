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

  test('reloadLoaded refetches every loaded page and keeps the extra pages', async () => {
    let version = 1
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], true))
    const fetchPage = jest.fn(async (current: number) =>
      current === 1 ? page(1, [`a${version}`], true) : page(2, [`b${version}`], false))
    const board = useTicketBoardPages(firstPage, fetchPage, jest.fn())
    await board.loadMoreTickets()
    expect(board.tickets.value.map(t => t.id)).toEqual(['a', 'b1'])

    version = 2
    await expect(board.reloadLoaded()).resolves.toBe(true)

    expect(fetchPage).toHaveBeenCalledWith(1)
    expect(board.tickets.value.map(t => t.id)).toEqual(['a2', 'b2'])
    expect(board.hasNext.value).toBe(false)
  })

  test('reloadLoaded refetches loaded pages one at a time, not all at once', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], true))
    let active = 0
    let maxActive = 0
    const fetchPage = jest.fn(async (current: number) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return current === 1 ? page(1, ['a'], true) : page(2, ['b'], false)
    })
    const board = useTicketBoardPages(firstPage, fetchPage, jest.fn())

    await board.loadMoreTickets()
    maxActive = 0
    await board.reloadLoaded()

    expect(maxActive).toBe(1)
  })

  test('reloadLoaded with only the first page fetches page 1 only', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], false))
    const fetchPage = jest.fn(async (_current: number) => page(1, ['a-new'], false))
    const board = useTicketBoardPages(firstPage, fetchPage, jest.fn())

    await board.reloadLoaded()

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(board.tickets.value.map(t => t.id)).toEqual(['a-new'])
  })

  test('a failed reload keeps the current tickets and reports nothing', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], false))
    const reportError = jest.fn()
    const board = useTicketBoardPages(firstPage, async () => { throw new Error('offline') }, reportError)

    await expect(board.reloadLoaded()).resolves.toBe(false)

    expect(board.tickets.value.map(t => t.id)).toEqual(['a'])
    expect(reportError).not.toHaveBeenCalled()
  })

  test('an older reload that finishes last is discarded', async () => {
    const firstPage = ref<TicketPage<Ticket> | null>(page(1, ['a'], false))
    const slow = deferred<TicketPage<Ticket>>()
    const fetchPage = jest.fn()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(async () => page(1, ['newest'], false))
    const board = useTicketBoardPages(firstPage, fetchPage as (current: number) => Promise<TicketPage<Ticket>>, jest.fn())

    const older = board.reloadLoaded()
    await board.reloadLoaded()
    slow.resolve(page(1, ['stale'], false))
    await expect(older).resolves.toBe(false)

    expect(board.tickets.value.map(t => t.id)).toEqual(['newest'])
  })
})
