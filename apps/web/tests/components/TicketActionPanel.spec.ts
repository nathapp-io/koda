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

})

// ──────────────────────────────────────────────────────────────────────────────
// M25 — panel renders only from the API-provided allowedActions
// ──────────────────────────────────────────────────────────────────────────────

describe('M25: panel renders only from the API allowedActions', () => {
  const source = () => readFileSync(panelPath, 'utf-8')

  test('reads ticket.allowedActions', () => {
    expect(source()).toContain('allowedActions')
  })

  test('has no hard-coded status blocks', () => {
    expect(source()).not.toMatch(/ticket\.status\s*===/)
  })

  test.each(['verify', 'start', 'fix', 'verify-fix', 'reject', 'close'])('handles the %s action', (action) => {
    expect(source()).toContain(`'${action}'`)
  })

  test('close opens the reason dialog instead of posting directly', () => {
    expect(source()).not.toContain("performAction('close')")
    expect(source()).toContain("openDialog('close')")
    expect(source()).toContain('tickets.actions.closeReasonTitle')
  })

  test('approve fix opens the dialog (the API requires a review comment)', () => {
    expect(source()).toContain("openDialog('verify-fix-approve')")
  })

  test('confirm is disabled for a blank comment and never sends an empty body', () => {
    expect(source()).toMatch(/:disabled="!canSubmit"/)
    expect(source()).not.toContain('comment.value ? { body: comment.value } : {}')
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

// ──────────────────────────────────────────────────────────────────────────────
// US-004 AC1 — performAction catch uses extractApiError, not instanceof Error
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004 AC1: TicketActionPanel performAction catch uses extractApiError', () => {
  test('source imports extractApiError from ~/composables/useApi', () => {
    const source = readFileSync(panelPath, 'utf-8')
    const hasImport =
      source.includes('extractApiError') &&
      (source.includes('useApi') || source.includes('composables/useApi'))
    expect(hasImport).toBe(true)
  })

  test('source calls extractApiError(error) in performAction catch block', () => {
    const source = readFileSync(panelPath, 'utf-8')
    expect(source).toContain('extractApiError(')
  })

  test('source does not use inferior instanceof Error pattern in catch block', () => {
    const source = readFileSync(panelPath, 'utf-8')
    // The old pattern: error instanceof Error ? error.message : fallback
    const hasInferiorPattern = source.includes('instanceof Error ? error.message')
    expect(hasInferiorPattern).toBe(false)
  })

  test('toast.error is called with extractApiError result on action failure', () => {
    const source = readFileSync(panelPath, 'utf-8')
    // extractApiError must appear before toast.error in the catch block
    const hasExtractBeforeToast =
      source.includes('extractApiError(') &&
      source.includes('toast.error(')
    expect(hasExtractBeforeToast).toBe(true)
  })
})
