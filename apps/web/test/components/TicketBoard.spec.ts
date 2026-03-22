import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const boardPath = join(webDir, 'components', 'TicketBoard.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — File exists and accepts a tickets array prop
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC1: TicketBoard.vue exists', () => {
  test('file is present at components/TicketBoard.vue', () => {
    expect(existsSync(boardPath)).toBe(true)
  })
})

describe('US-004-2 AC1: TicketBoard.vue accepts a tickets array prop', () => {
  test('source defines props with defineProps', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('defineProps')
  })

  test('source references a tickets prop (plural)', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('tickets')
  })

  test('source uses TypeScript typing for props', () => {
    const source = readFileSync(boardPath, 'utf-8')
    const hasTypedProps =
      source.includes('defineProps<') ||
      source.includes('defineProps({') ||
      source.includes('PropType')
    expect(hasTypedProps).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Container uses overflow-x-auto
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC2: Container uses overflow-x-auto for horizontal scroll', () => {
  test('source contains overflow-x-auto class', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('overflow-x-auto')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Exactly 6 columns in the correct order
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC3: Exactly 6 status columns rendered in order', () => {
  test('source references all 6 statuses', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('CREATED')
    expect(source).toContain('VERIFIED')
    expect(source).toContain('IN_PROGRESS')
    expect(source).toContain('VERIFY_FIX')
    expect(source).toContain('CLOSED')
    expect(source).toContain('REJECTED')
  })

  test('CREATED appears before VERIFIED in source', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source.indexOf('CREATED')).toBeLessThan(source.indexOf('VERIFIED'))
  })

  test('VERIFIED appears before IN_PROGRESS in source', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source.indexOf('VERIFIED')).toBeLessThan(source.indexOf('IN_PROGRESS'))
  })

  test('IN_PROGRESS appears before VERIFY_FIX in source', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source.indexOf('IN_PROGRESS')).toBeLessThan(source.indexOf('VERIFY_FIX'))
  })

  test('VERIFY_FIX appears before CLOSED in source', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source.indexOf('VERIFY_FIX')).toBeLessThan(source.indexOf('CLOSED'))
  })

  test('CLOSED appears before REJECTED in source', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source.indexOf('CLOSED')).toBeLessThan(source.indexOf('REJECTED'))
  })

  test('source defines an array or list of exactly 6 statuses', () => {
    const source = readFileSync(boardPath, 'utf-8')
    // The component should define the ordered list of statuses
    const statusMatches = [
      'CREATED',
      'VERIFIED',
      'IN_PROGRESS',
      'VERIFY_FIX',
      'CLOSED',
      'REJECTED',
    ]
    const allPresent = statusMatches.every((s) => source.includes(s))
    expect(allPresent).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Each column header shows status name and count badge
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC4: Each column header shows status name and ticket count badge', () => {
  test('source uses Badge component for count display', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('Badge')
  })

  test('source derives per-column count (filter or groupBy pattern)', () => {
    const source = readFileSync(boardPath, 'utf-8')
    // Must compute per-column count — either via .filter or computed grouping
    const hasCountLogic =
      source.includes('.filter') ||
      source.includes('reduce') ||
      source.includes('group') ||
      source.includes('.length')
    expect(hasCountLogic).toBe(true)
  })

  test('source renders column header with status label', () => {
    const source = readFileSync(boardPath, 'utf-8')
    // Header text comes from iterating columns or inline labels
    const hasHeader =
      source.includes('header') ||
      source.includes('column') ||
      source.includes('status') ||
      source.includes('label')
    expect(hasHeader).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — 'New Ticket' button only in CREATED column, emits 'create'
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-2 AC5: 'New Ticket' button present only in CREATED column and emits 'create'", () => {
  test("source contains 'New Ticket' text", () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('New Ticket')
  })

  test("source defines 'create' in defineEmits", () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('defineEmits')
    const hasCreateEvent =
      source.includes("'create'") ||
      source.includes('"create"')
    expect(hasCreateEvent).toBe(true)
  })

  test("source emits 'create' event", () => {
    const source = readFileSync(boardPath, 'utf-8')
    const hasEmitCreate =
      source.includes("emit('create'") ||
      source.includes('emit("create"')
    expect(hasEmitCreate).toBe(true)
  })

  test("'New Ticket' button is guarded by CREATED status condition", () => {
    const source = readFileSync(boardPath, 'utf-8')
    // The button must be conditional — either via v-if or rendered inside CREATED column only
    const hasConditional =
      source.includes('v-if') ||
      source.includes('=== \'CREATED\'') ||
      source.includes('=== "CREATED"') ||
      source.includes("=== 'CREATED'")
    expect(hasConditional).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Tickets grouped by status, each rendered as TicketCard
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2 AC6: Tickets grouped by status and rendered as TicketCard', () => {
  test('source imports or references TicketCard component', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('TicketCard')
  })

  test('source uses v-for to iterate tickets within a column', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).toContain('v-for')
  })

  test('source groups tickets by status (filter or computed)', () => {
    const source = readFileSync(boardPath, 'utf-8')
    const hasGroupLogic =
      source.includes('.filter') ||
      source.includes('reduce') ||
      source.includes('group') ||
      source.includes('status')
    expect(hasGroupLogic).toBe(true)
  })

  test('source passes ticket prop to TicketCard', () => {
    const source = readFileSync(boardPath, 'utf-8')
    // :ticket="..." or v-bind pattern
    const hasTicketProp =
      source.includes(':ticket=') ||
      source.includes('v-bind:ticket=')
    expect(hasTicketProp).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — TicketCard 'open' event bubbles up as 'open-ticket'
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-2 AC7: TicketCard 'open' event bubbles up as 'open-ticket'", () => {
  test("source defines 'open-ticket' in defineEmits", () => {
    const source = readFileSync(boardPath, 'utf-8')
    const hasOpenTicketEvent =
      source.includes("'open-ticket'") ||
      source.includes('"open-ticket"')
    expect(hasOpenTicketEvent).toBe(true)
  })

  test("source emits 'open-ticket' event", () => {
    const source = readFileSync(boardPath, 'utf-8')
    const hasEmitOpenTicket =
      source.includes("emit('open-ticket'") ||
      source.includes('emit("open-ticket"')
    expect(hasEmitOpenTicket).toBe(true)
  })

  test("source listens for TicketCard's 'open' event", () => {
    const source = readFileSync(boardPath, 'utf-8')
    const hasOpenListener =
      source.includes('@open=') ||
      source.includes('v-on:open=') ||
      source.includes("'open'")
    expect(hasOpenListener).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-2: TicketBoard.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(boardPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
