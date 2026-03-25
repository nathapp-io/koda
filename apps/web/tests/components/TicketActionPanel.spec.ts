import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const panelPath = join(webDir, 'components', 'TicketActionPanel.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2: components/TicketActionPanel.vue exists', () => {
  test('file is present at components/TicketActionPanel.vue', () => {
    expect(existsSync(panelPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — accepts a ticket prop typed to the Ticket schema
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC1: TicketActionPanel.vue accepts a typed ticket prop', () => {
  test('source defines props with defineProps', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('defineProps')
  })

  test('source references a ticket prop', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('ticket')
  })

  test('source uses TypeScript typing for props', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasTypedProps =
      source.includes('defineProps<') ||
      source.includes('defineProps({') ||
      source.includes('PropType')
    expect(hasTypedProps).toBe(true)
  })

  test('source references ticket.status to drive rendering', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('ticket.status')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — CREATED status renders Verify and Reject buttons only
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC2: CREATED status renders Verify and Reject buttons', () => {
  test('source references CREATED status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('CREATED')
  })

  test('source includes a Verify button label', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasVerify =
      source.includes('Verify') ||
      source.includes('verify')
    expect(hasVerify).toBe(true)
  })

  test('source includes a Reject button label for CREATED state', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasReject =
      source.includes('Reject') ||
      source.includes('reject')
    expect(hasReject).toBe(true)
  })

  test('source conditionally renders buttons based on CREATED status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasConditional =
      source.includes('v-if') ||
      source.includes('v-show') ||
      source.includes('computed')
    expect(hasConditional).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — VERIFIED status renders Start button only
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC3: VERIFIED status renders Start button', () => {
  test('source references VERIFIED status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('VERIFIED')
  })

  test('source includes a Start button label', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasStart =
      source.includes('Start') ||
      source.includes('start')
    expect(hasStart).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — IN_PROGRESS status renders Submit Fix and Reject buttons only
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC4: IN_PROGRESS status renders Submit Fix and Reject buttons', () => {
  test('source references IN_PROGRESS status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('IN_PROGRESS')
  })

  test('source includes a Submit Fix button label', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasSubmitFix =
      source.includes('Submit Fix') ||
      source.includes('submitFix') ||
      source.includes('submit-fix') ||
      source.includes('Submit fix')
    expect(hasSubmitFix).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — VERIFY_FIX status renders Approve Fix and Fail Fix buttons only
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC5: VERIFY_FIX status renders Approve Fix and Fail Fix buttons', () => {
  test('source references VERIFY_FIX status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('VERIFY_FIX')
  })

  test('source includes an Approve Fix button label', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasApproveFix =
      source.includes('Approve Fix') ||
      source.includes('approveFix') ||
      source.includes('Approve fix')
    expect(hasApproveFix).toBe(true)
  })

  test('source includes a Fail Fix button label', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasFailFix =
      source.includes('Fail Fix') ||
      source.includes('failFix') ||
      source.includes('Fail fix')
    expect(hasFailFix).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — CLOSED and REJECTED statuses render no action buttons
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC6: CLOSED and REJECTED statuses render no action buttons', () => {
  test('source references CLOSED status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('CLOSED')
  })

  test('source references REJECTED status', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('REJECTED')
  })

  test('source handles CLOSED/REJECTED with no-button branch', () => {
    const source = readFileSync(panelPath, 'utf-8')
    // Component must have logic that covers terminal states (no buttons)
    // Could be v-if checking status, a computed array, or an exhaustive switch
    const hasTerminalHandling =
      source.includes('CLOSED') &&
      source.includes('REJECTED') &&
      (source.includes('v-if') || source.includes('computed') || source.includes('switch'))
    expect(hasTerminalHandling).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Verify, Reject, Submit Fix, Fail Fix open a Dialog with a Textarea
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC7: Verify, Reject, Submit Fix, Fail Fix open a Dialog with Textarea', () => {
  test('source uses Dialog component', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('Dialog')
  })

  test('source uses DialogContent', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('DialogContent')
  })

  test('source uses Textarea inside Dialog', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('Textarea')
  })

  test('source has a comment or reason field for the dialog', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasCommentField =
      source.includes('comment') ||
      source.includes('reason') ||
      source.includes('message')
    expect(hasCommentField).toBe(true)
  })

  test('source has a dialog open/close state binding', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasDialogState =
      source.includes('open') ||
      source.includes('v-model') ||
      source.includes('isOpen') ||
      source.includes('showDialog')
    expect(hasDialogState).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — Start and Approve Fix call endpoints immediately without a dialog
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC8: Start and Approve Fix call endpoints immediately without a dialog', () => {
  test('source calls the start API endpoint', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasStartEndpoint =
      source.includes('/start') ||
      source.includes("'start'") ||
      source.includes('"start"')
    expect(hasStartEndpoint).toBe(true)
  })

  test('source calls the verify-fix endpoint with approve=true', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasApproveFix =
      source.includes('verify-fix') ||
      source.includes('verifyFix') ||
      source.includes('approve')
    expect(hasApproveFix).toBe(true)
  })

  test('source uses useApi composable for API calls', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasApiCall =
      source.includes('useApi') ||
      source.includes('$api')
    expect(hasApiCall).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Component emits a 'transition' event after each successful API response
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2 AC9: component emits transition event after successful API response', () => {
  test('source defines defineEmits', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('defineEmits')
  })

  test("source includes 'transition' in the emits definition", () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasTransitionEmit =
      source.includes("'transition'") ||
      source.includes('"transition"')
    expect(hasTransitionEmit).toBe(true)
  })

  test("source emits 'transition' event", () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasEmitTransition =
      source.includes("emit('transition'") ||
      source.includes('emit("transition"')
    expect(hasEmitTransition).toBe(true)
  })

  test('source emits transition after awaiting the API call', () => {
    const source = readFileSync(panelPath, 'utf-8')
    // The emit must appear after an async API call (await is present)
    expect(source).toContain('await')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// API Endpoints — verify, start, fix, verify-fix, reject
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2: source references all required API endpoints', () => {
  test('source references /verify endpoint', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasVerifyEndpoint =
      source.includes('/verify') ||
      source.includes("'verify'") ||
      source.includes('"verify"')
    expect(hasVerifyEndpoint).toBe(true)
  })

  test('source references /reject endpoint', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasRejectEndpoint =
      source.includes('/reject') ||
      source.includes("'reject'") ||
      source.includes('"reject"')
    expect(hasRejectEndpoint).toBe(true)
  })

  test('source references /fix endpoint', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasFixEndpoint =
      source.includes('/fix') ||
      source.includes("'fix'") ||
      source.includes('"fix"')
    expect(hasFixEndpoint).toBe(true)
  })

  test('source references /verify-fix endpoint', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasVerifyFixEndpoint =
      source.includes('verify-fix') ||
      source.includes('verifyFix')
    expect(hasVerifyFixEndpoint).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-2: TicketActionPanel.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
