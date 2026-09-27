import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const board = read('pages', '[project]', 'index.vue')
const detail = read('pages', '[project]', 'tickets', '[ref].vue')
const ticketBoard = read('components', 'TicketBoard.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('board live wiring', () => {
  test('subscribes to project events and reloads loaded pages, debounced', () => {
    expect(board).toContain('useProjectEvents(slug')
    expect(board).toContain('reloadLoaded')
    expect(board).toContain('createDebouncer(')
  })

  test('ignores comments and never calls the pending-flipping refresh() from live handlers', () => {
    const handlers = liveHandlers(board)
    expect(handlers).toContain("'commented'")
    expect(handlers).not.toContain('refresh(')
  })

  test('cancels the pending reload on unmount', () => {
    expect(board).toMatch(/onBeforeUnmount\(\(\) => liveReload\.cancel\(\)\)/)
  })

  test('board columns carry a status test id', () => {
    expect(ticketBoard).toContain(':data-testid="`board-column-${status}`"')
  })
})

describe('ticket detail live wiring', () => {
  test('only reacts to events for the open ticket', () => {
    expect(liveHandlers(detail)).toContain('event.ticketId !== ticket.value.id')
  })

  test('updates the ticket in place instead of refresh() (keeps an open edit form)', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).not.toContain('refresh(')
    expect(detail).toMatch(/ticketData\.value = await/)
  })

  test('refreshes comments through the CommentThread cache key without touching the component', () => {
    expect(detail).toContain('useNuxtData(`comments-${slug}-${ref}`)')
  })

  test('reloads comments for any event on the open ticket, not only commented', () => {
    const handlers = liveHandlers(detail)
    expect(handlers).toContain('void reloadCommentsSilently()')
    expect(handlers).not.toContain("event.action === 'commented'")
  })

  test('shows a notice instead of refetching a deleted ticket', () => {
    expect(detail).toContain("event.action === 'deleted'")
    expect(detail).toContain('data-testid="ticket-deleted-notice"')
    expect(detail).toContain("t('tickets.live.deleted')")
  })
})
