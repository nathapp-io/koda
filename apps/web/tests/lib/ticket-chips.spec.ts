import { describe, test, expect } from '@jest/globals'
import {
  PRIORITY_DOT, PRIORITY_STRIPE, STATUS_DOT, TYPE_CLASS, priorityDotClass, priorityStripeClass, statusDotClass, typeChipClass,
} from '../../lib/ticket-chips'

// Slice 3: the chip token maps moved out of TicketHeader/TicketBoard/TicketCard/HomeNeedsYou into
// one lib. These pins are the per-level contract the old per-component copies used to encode.

describe('ticket-chips token maps', () => {
  test('every ticket status has a status-* dot token', () => {
    expect(STATUS_DOT).toEqual({
      CREATED: 'bg-status-todo',
      VERIFIED: 'bg-status-todo',
      IN_PROGRESS: 'bg-status-active',
      VERIFY_FIX: 'bg-status-review',
      CLOSED: 'bg-status-done',
      REJECTED: 'bg-status-rejected',
    })
  })

  test('every priority has a priority-* dot token and card stripe', () => {
    expect(PRIORITY_DOT).toEqual({
      CRITICAL: 'bg-priority-critical',
      HIGH: 'bg-priority-high',
      MEDIUM: 'bg-priority-medium',
      LOW: 'bg-priority-low',
    })
    expect(PRIORITY_STRIPE).toEqual({
      CRITICAL: 'border-l-priority-critical',
      HIGH: 'border-l-priority-high',
      MEDIUM: 'border-l-priority-medium',
      LOW: 'border-l-priority-low',
    })
  })

  test('type tints are token-based (no raw palette colors)', () => {
    expect(TYPE_CLASS.BUG).toContain('text-status-rejected')
    expect(TYPE_CLASS.BUG).toContain('border-status-rejected/40')
    expect(TYPE_CLASS.ENHANCEMENT).toContain('text-status-active')
    expect(TYPE_CLASS.ENHANCEMENT).toContain('border-status-active/40')
    expect(JSON.stringify(TYPE_CLASS)).not.toMatch(/border-red|text-blue|bg-orange/)
  })

  test('helpers fall back to neutral tokens for unknown codes', () => {
    expect(statusDotClass('MYSTERY')).toBe('bg-muted-foreground')
    expect(priorityDotClass('MYSTERY')).toBe('bg-muted-foreground')
    expect(priorityStripeClass('MYSTERY')).toBe(PRIORITY_STRIPE.LOW)
    expect(typeChipClass('MYSTERY')[1]).toBe(TYPE_CLASS.TASK)
    expect(typeChipClass('BUG')).toEqual([expect.stringContaining('rounded-full'), TYPE_CLASS.BUG])
  })
})
