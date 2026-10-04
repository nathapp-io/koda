import { describe, expect, test } from '@jest/globals'
import type { EntriesPageRequest } from '~/lib/fleet-log-query'
import type { FleetJobLogEntriesDto, FleetJobLogEntryDto } from '~/lib/fleet-log-types'
import { createLogViewer, FOLLOW_PAGE_LIMIT, LOG_PAGE_LIMIT, type LogViewerState } from '~/lib/fleet-log-viewer'

const line = (i: number): FleetJobLogEntryDto => ({ offset: i * 10, length: 10, text: `l${i}` })
const lines = (from: number, to: number): FleetJobLogEntryDto[] => Array.from({ length: to - from }, (_, k) => line(from + k))
const page = (over: Partial<FleetJobLogEntriesDto>): FleetJobLogEntriesDto => ({
  entries: [], nextCursor: 0, scannedFrom: 0, scannedTo: 0, atEnd: true, size: 0, complete: false, truncated: false, ...over,
})
const apiError = (code: number): Error & { code: number } => Object.assign(new Error(`ret ${code}`), { code })

function deferred<T>() {
  let resolve = (_v: T): void => undefined
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** A viewer over scripted answers; each fetchPage call takes the next answer (a page, an error, or a deferred). */
function harness(answers: Array<FleetJobLogEntriesDto | Error | Promise<FleetJobLogEntriesDto>>, opts: { follow?: boolean; filtered?: boolean } = {}) {
  const calls: EntriesPageRequest[] = []
  const states: LogViewerState[] = []
  const sleeps: number[] = []
  const viewer = createLogViewer({
    fetchPage: async (p) => {
      calls.push(p)
      const next = answers.shift()
      if (next === undefined) throw new Error('unexpected fetch')
      if (next instanceof Error) throw next
      return next
    },
    sleep: async (ms) => { sleeps.push(ms) },
    filtered: opts.filtered ?? false,
    onChange: (s) => { states.push(s) },
    describeError: (e) => (e as Error).message,
  }, { follow: opts.follow ?? true })
  const last = (): LogViewerState => states[states.length - 1]
  return { viewer, calls, states, sleeps, last }
}

const opening = page({ entries: lines(5, 8), nextCursor: 50, scannedFrom: 50, scannedTo: 80, atEnd: false, size: 80 })

describe('createLogViewer (spec §4.1)', () => {
  test('open reads backward from the visible end and shows the rows', async () => {
    const h = harness([opening])
    await h.viewer.open()
    expect(h.calls).toEqual([{ direction: 'backward', limit: LOG_PAGE_LIMIT }])
    expect(h.last()).toMatchObject({ loading: false, follow: true, error: null })
    expect(h.last().view?.rows.map((r) => r.offset)).toEqual([50, 60, 70])
  })

  test('growth while following fetches forward from the tail', async () => {
    const h = harness([opening, page({ entries: lines(8, 9), nextCursor: 90, atEnd: true, size: 90 })])
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls[1]).toEqual({ direction: 'forward', cursor: 80, limit: FOLLOW_PAGE_LIMIT })
    expect(h.last().view?.rows.map((r) => r.offset)).toEqual([50, 60, 70, 80])
  })

  test('growth notices during a request are coalesced into exactly one follow-up fetch', async () => {
    const slow = deferred<FleetJobLogEntriesDto>()
    const h = harness([opening, slow.promise, page({ entries: lines(9, 10), nextCursor: 100, atEnd: true, size: 100 })])
    await h.viewer.open()
    const first = h.viewer.onGrowth()
    await h.viewer.onGrowth()
    await h.viewer.onGrowth()
    slow.resolve(page({ entries: lines(8, 9), nextCursor: 90, atEnd: true, size: 90 }))
    await first
    expect(h.calls.map((c) => c.cursor)).toEqual([undefined, 80, 90])
    expect(h.last().view?.rows).toHaveLength(5)
  })

  test('following catches up a burst page by page until atEnd', async () => {
    const h = harness([
      opening,
      page({ entries: lines(8, 9), nextCursor: 90, atEnd: false, size: 200 }),
      page({ entries: lines(9, 20), nextCursor: 200, atEnd: true, size: 200 }),
    ])
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls.map((c) => c.cursor)).toEqual([undefined, 80, 90])
    expect(h.last().view?.tail).toBe(200)
  })

  test('a filtered follow stops on an empty page that is not at the end and offers Keep searching (criterion 3)', async () => {
    const h = harness([opening, page({ entries: [], nextCursor: 2_000_080, scannedFrom: 80, scannedTo: 2_000_080, atEnd: false, size: 9_000_000 })], { filtered: true })
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls).toHaveLength(2)
    expect(h.last().view?.searching).toEqual({ direction: 'forward', scannedFrom: 80, scannedTo: 2_000_080 })
  })

  test('Keep searching sends exactly one request in the searching direction', async () => {
    const backward = page({ entries: [], nextCursor: 40, scannedFrom: 40, scannedTo: 80, atEnd: false, size: 80 })
    const h = harness([backward, page({ entries: lines(1, 2), nextCursor: 10, scannedFrom: 10, scannedTo: 40, atEnd: false, size: 80 })], { filtered: true, follow: false })
    await h.viewer.open()
    expect(h.last().view?.searching?.direction).toBe('backward')
    await h.viewer.keepSearching()
    expect(h.calls[1]).toEqual({ direction: 'backward', cursor: 40, limit: LOG_PAGE_LIMIT })
    expect(h.last().view?.searching).toBeNull()
  })

  test('with follow off, growth does nothing; Load more fetches one forward page', async () => {
    const h = harness([opening, page({ entries: lines(8, 9), nextCursor: 90, atEnd: false, size: 200 })], { follow: false })
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.calls).toHaveLength(1)
    await h.viewer.loadMore()
    expect(h.calls[1]).toEqual({ direction: 'forward', cursor: 80, limit: LOG_PAGE_LIMIT })
    expect(h.last().view?.atEnd).toBe(false)
  })

  test('Load earlier reads backward from the head and is a no-op at the start', async () => {
    const h = harness([opening, page({ entries: lines(0, 5), nextCursor: 0, scannedFrom: 0, scannedTo: 50, atEnd: true, size: 80 })])
    await h.viewer.open()
    await h.viewer.loadEarlier()
    expect(h.calls[1]).toEqual({ direction: 'backward', cursor: 50, limit: LOG_PAGE_LIMIT })
    await h.viewer.loadEarlier()
    expect(h.calls).toHaveLength(2)
    expect(h.last().view?.atStart).toBe(true)
  })

  test('429 backs off 2 s, 4 s, 8 s with a quiet flag, and recovers', async () => {
    const h = harness([apiError(429), apiError(429), apiError(429), opening])
    await h.viewer.open()
    expect(h.sleeps).toEqual([2000, 4000, 8000])
    expect(h.states.some((s) => s.rateLimited)).toBe(true)
    expect(h.last()).toMatchObject({ rateLimited: false, error: null })
    expect(h.last().view).not.toBeNull()
  })

  test('a fourth 429 gives up with an error and no further request', async () => {
    const h = harness([apiError(429), apiError(429), apiError(429), apiError(429)])
    await h.viewer.open()
    expect(h.calls).toHaveLength(4)
    expect(h.last()).toMatchObject({ rateLimited: false, error: 'ret 429', loading: false })
  })

  test('410 marks the stream expired, clears the rows and stops following', async () => {
    const h = harness([opening, apiError(410)])
    await h.viewer.open()
    await h.viewer.onGrowth()
    expect(h.last()).toMatchObject({ expired: true, view: null, follow: false, error: null })
  })

  test('any other failure is an error; the next action clears it', async () => {
    const h = harness([new Error('boom'), opening])
    await h.viewer.open()
    expect(h.last()).toMatchObject({ error: 'boom', view: null })
    await h.viewer.open()
    expect(h.last()).toMatchObject({ error: null })
  })

  test('Jump to latest reopens at the end with follow on', async () => {
    const h = harness([opening, page({ entries: lines(20, 22), nextCursor: 200, scannedFrom: 200, scannedTo: 220, atEnd: false, size: 220 })], { follow: false })
    await h.viewer.open()
    await h.viewer.jumpToLatest()
    expect(h.calls[1]).toEqual({ direction: 'backward', limit: LOG_PAGE_LIMIT })
    expect(h.last()).toMatchObject({ follow: true })
    expect(h.last().view?.rows.map((r) => r.offset)).toEqual([200, 210])
  })

  test('after dispose a pending answer changes nothing', async () => {
    const slow = deferred<FleetJobLogEntriesDto>()
    const h = harness([slow.promise])
    const opened = h.viewer.open()
    const seen = h.states.length
    h.viewer.dispose()
    slow.resolve(opening)
    await opened
    expect(h.states).toHaveLength(seen)
  })

  test('setFollow(false) from a scroll, then growth sends nothing', async () => {
    const h = harness([opening])
    await h.viewer.open()
    h.viewer.setFollow(false)
    await h.viewer.onGrowth()
    expect(h.calls).toHaveLength(1)
    expect(h.last().follow).toBe(false)
  })
})
