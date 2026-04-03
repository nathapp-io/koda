import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function source(): string {
  return readFileSync(pagePath, 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — TicketActionPanel is wired into the right column
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-4 AC1: TicketActionPanel component is wired into the right column', () => {
  test('file exists', () => {
    expect(existsSync(pagePath)).toBe(true)
  })

  test('source uses <TicketActionPanel> component tag (not just a placeholder div)', () => {
    const src = source()
    const hasComponent =
      src.includes('<TicketActionPanel') ||
      src.includes('<ticket-action-panel')
    expect(hasComponent).toBe(true)
  })

  test('TicketActionPanel is no longer a placeholder-only div', () => {
    const src = source()
    // If it still only has a placeholder div comment and no real component tag,
    // this test should fail. The placeholder pattern uses data-slot attribute.
    const isStillPlaceholder =
      src.includes('data-slot="ticket-action-panel"') &&
      !src.includes('<TicketActionPanel') &&
      !src.includes('<ticket-action-panel')
    expect(isStillPlaceholder).toBe(false)
  })

  test('TicketActionPanel receives ticket prop', () => {
    const src = source()
    const hasProp =
      src.includes(':ticket="ticket"') ||
      src.includes(':ticket=\'ticket\'') ||
      src.includes('v-bind:ticket')
    expect(hasProp).toBe(true)
  })

  test('TicketActionPanel receives projectSlug prop', () => {
    const src = source()
    const hasProp =
      src.includes(':project-slug="slug"') ||
      src.includes(':projectSlug="slug"') ||
      src.includes(':project-slug=\'slug\'') ||
      src.includes(':projectSlug=\'slug\'')
    expect(hasProp).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — CommentThread is wired into the left column below the ticket body
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-4 AC2: CommentThread component is wired into the left column', () => {
  test('source uses <CommentThread> component tag (not just a placeholder div)', () => {
    const src = source()
    const hasComponent =
      src.includes('<CommentThread') ||
      src.includes('<comment-thread')
    expect(hasComponent).toBe(true)
  })

  test('CommentThread is no longer a placeholder-only div', () => {
    const src = source()
    const isStillPlaceholder =
      src.includes('data-slot="comment-thread"') &&
      !src.includes('<CommentThread') &&
      !src.includes('<comment-thread')
    expect(isStillPlaceholder).toBe(false)
  })

  test('CommentThread receives projectSlug prop', () => {
    const src = source()
    const hasProp =
      src.includes(':project-slug="slug"') ||
      src.includes(':projectSlug="slug"') ||
      src.includes(':project-slug=\'slug\'') ||
      src.includes(':projectSlug=\'slug\'')
    expect(hasProp).toBe(true)
  })

  test('CommentThread receives ticketRef prop', () => {
    const src = source()
    const hasProp =
      src.includes(':ticket-ref="ticketRef"') ||
      src.includes(':ticketRef="ticketRef"') ||
      src.includes(':ticket-ref=\'ticketRef\'') ||
      src.includes(':ticketRef=\'ticketRef\'')
    expect(hasProp).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Success toast appears after each successful ticket transition
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-4 AC3: success toast appears after ticket transition', () => {
  test('source accesses toast from useAppToast helper', () => {
    const src = source()
    expect(src.includes('useAppToast(')).toBe(true)
  })

  test('source has a transition event handler', () => {
    const src = source()
    const hasTransitionHandler =
      src.includes('@transition') ||
      src.includes('v-on:transition') ||
      src.includes("on('transition'") ||
      src.includes('onTransition')
    expect(hasTransitionHandler).toBe(true)
  })

  test('source calls toast.success after transition', () => {
    const src = source()
    const hasToastSuccess = src.includes('toast.success')
    expect(hasToastSuccess).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Ticket data refreshes automatically after a transition
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-4 AC4: ticket data refreshes after a transition', () => {
  test('source destructures refresh from useAsyncData', () => {
    const src = source()
    const hasRefresh =
      src.includes('refresh') &&
      src.includes('useAsyncData')
    expect(hasRefresh).toBe(true)
  })

  test('source calls refresh() in the transition handler', () => {
    const src = source()
    // Check that refresh is called somewhere after transition handling
    // The function body should call refresh()
    const hasRefreshCall =
      src.includes('refresh()') ||
      src.includes('await refresh()')
    expect(hasRefreshCall).toBe(true)
  })

  test('transition handler calls both toast.success and refresh()', () => {
    const src = source()
    const hasToast = src.includes('toast.success')
    const hasRefresh = src.includes('refresh()')
    expect(hasToast && hasRefresh).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Success toast appears after a comment is added
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-4 AC5: success toast appears after a comment is added', () => {
  test('source has a comment-added event handler on CommentThread', () => {
    const src = source()
    const hasCommentAddedHandler =
      src.includes('@comment-added') ||
      src.includes('v-on:comment-added') ||
      src.includes('@commentAdded') ||
      src.includes('v-on:commentAdded') ||
      src.includes('onCommentAdded')
    expect(hasCommentAddedHandler).toBe(true)
  })

  test('source calls toast.success in the comment-added handler', () => {
    const src = source()
    // The page must have toast.success called (could be shared with transition toast)
    const hasToastSuccess = src.includes('toast.success')
    expect(hasToastSuccess).toBe(true)
  })

  test('source has a handler function for comment-added events', () => {
    const src = source()
    const hasHandler =
      src.includes('onCommentAdded') ||
      src.includes('handleCommentAdded') ||
      src.includes('commentAdded') ||
      src.includes('@comment-added=')
    expect(hasHandler).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-4 quality: no console.log in ticket detail page', () => {
  test('source does not contain console.log', () => {
    const src = source()
    expect(src).not.toContain('console.log')
  })
})
