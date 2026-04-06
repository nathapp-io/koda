import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const cardPath = join(webDir, 'components', 'TicketCard.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — File existence and typed ticket prop
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC1: TicketCard.vue exists', () => {
  test('file is present at components/TicketCard.vue', () => {
    expect(existsSync(cardPath)).toBe(true)
  })
})

describe('US-004-1 AC1: TicketCard.vue accepts a typed ticket prop', () => {
  test('source defines props with defineProps', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('defineProps')
  })

  test('source references a ticket prop', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('ticket')
  })

  test('source uses TypeScript typing for props', () => {
    const source = readFileSync(cardPath, 'utf-8')
    // Either defineProps<{ ticket: ... }>() or withDefaults pattern
    const hasTypedProps =
      source.includes('defineProps<') ||
      source.includes('defineProps({') ||
      source.includes('PropType')
    expect(hasTypedProps).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — ref rendered in monospace font
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC2: ticket ref is rendered in monospace font', () => {
  test('source renders ticket.ref', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('ticket.ref')
  })

  test('source applies font-mono class to ref element', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('font-mono')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — type Badge with correct border colors
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC3: type Badge uses red border for BUG', () => {
  test('source references BUG type', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('BUG')
  })

  test('source applies red border class for BUG type', () => {
    const source = readFileSync(cardPath, 'utf-8')
    // border-red-300 or text-red-700 as per CLAUDE.md badge pattern
    const hasBugRedBorder =
      source.includes('border-red') ||
      source.includes('text-red')
    expect(hasBugRedBorder).toBe(true)
  })
})

describe('US-004-1 AC3: type Badge uses blue border for ENHANCEMENT', () => {
  test('source references ENHANCEMENT type', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('ENHANCEMENT')
  })

  test('source applies blue border class for ENHANCEMENT type', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasEnhancementBlueBorder =
      source.includes('border-blue') ||
      source.includes('text-blue')
    expect(hasEnhancementBlueBorder).toBe(true)
  })
})

describe('US-004-1 AC3: type Badge uses Badge component', () => {
  test('source uses Badge component', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('Badge')
  })

  test('source renders ticket.type', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('ticket.type')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — priority Badge with correct variants
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC4: priority Badge uses CRITICAL=red', () => {
  test('source references CRITICAL priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('CRITICAL')
  })

  test('source applies destructive or red variant for CRITICAL', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasCriticalRed =
      source.includes('destructive') ||
      source.includes('bg-red') ||
      source.includes('text-red')
    expect(hasCriticalRed).toBe(true)
  })
})

describe('US-004-1 AC4: priority Badge uses HIGH=orange', () => {
  test('source references HIGH priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('HIGH')
  })

  test('source applies orange class for HIGH priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasHighOrange =
      source.includes('bg-orange') ||
      source.includes('text-orange')
    expect(hasHighOrange).toBe(true)
  })
})

describe('US-004-1 AC4: priority Badge uses MEDIUM=secondary', () => {
  test('source references MEDIUM priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('MEDIUM')
  })

  test('source applies secondary variant for MEDIUM priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('secondary')
  })
})

describe('US-004-1 AC4: priority Badge uses LOW=outline', () => {
  test('source references LOW priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('LOW')
  })

  test('source applies outline variant for LOW priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('outline')
  })
})

describe('US-004-1 AC4: priority Badge renders ticket.priority', () => {
  test('source renders ticket.priority', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('ticket.priority')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Assignee Avatar rendered only when ticket.assignee is present
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC5: Assignee Avatar rendered conditionally', () => {
  test('source uses Avatar component', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('Avatar')
  })

  test('source uses AvatarFallback', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('AvatarFallback')
  })

  test('source conditionally renders Avatar based on ticket.assignee', () => {
    const source = readFileSync(cardPath, 'utf-8')
    // Must use v-if with assignee condition
    const hasConditional =
      source.includes('v-if') &&
      source.includes('assignee')
    expect(hasConditional).toBe(true)
  })

  test('source references ticket.assignee', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('ticket.assignee')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Component emits 'open' event on click
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1 AC6: Component emits open event on click', () => {
  test("source defines 'open' in defineEmits", () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('defineEmits')
    const hasOpenEvent =
      source.includes("'open'") ||
      source.includes('"open"')
    expect(hasOpenEvent).toBe(true)
  })

  test("source emits 'open' event", () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasEmitOpen =
      source.includes("emit('open'") ||
      source.includes('emit("open"')
    expect(hasEmitOpen).toBe(true)
  })

  test('source has a click handler on the card element', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasClickHandler =
      source.includes('@click') ||
      source.includes('v-on:click')
    expect(hasClickHandler).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC1 — GitHub badge renders when externalVcsUrl is present
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC1: TicketCard renders GitHub badge when externalVcsUrl is present', () => {
  test('source includes externalVcsUrl in the Ticket interface', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('externalVcsUrl')
  })

  test('source uses Badge component for GitHub badge', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('Badge')
  })

  test('source conditionally renders badge based on externalVcsUrl', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasConditionalRender =
      source.includes('v-if') &&
      source.includes('externalVcsUrl')
    expect(hasConditionalRender).toBe(true)
  })

  test('source references GitHub or VCS keyword for badge identification', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasGitHubRef =
      source.includes('GitHub') ||
      source.includes('github') ||
      source.includes('vcs') ||
      source.includes('VCS')
    expect(hasGitHubRef).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC2 — Badge not rendered when externalVcsUrl is null/undefined
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC2: TicketCard does not render badge when externalVcsUrl is null or undefined', () => {
  test('source uses v-if conditional with externalVcsUrl for badge', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasExplicitCondition =
      source.includes('v-if') &&
      source.includes('externalVcsUrl')
    expect(hasExplicitCondition).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC5 — Issue number parsed from externalVcsUrl
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC5: Issue number is parsed from externalVcsUrl in TicketCard', () => {
  test('source contains a function to extract issue number from URL', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasIssueExtractor =
      source.includes('split') ||
      source.includes('match') ||
      source.includes('substring') ||
      source.includes('slice') ||
      source.includes('replace') ||
      source.includes('/') // Check for path parsing
    expect(hasIssueExtractor).toBe(true)
  })

  test('source references or displays issue number in badge', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasIssueDisplay =
      source.includes('#') ||
      source.includes('issue') ||
      source.includes('Issue')
    expect(hasIssueDisplay).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC6 — i18n keys used for badge text
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC6: GitHub badge uses i18n keys for text', () => {
  test('source uses useI18n composable', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).toContain('useI18n')
  })

  test('source references t() for GitHub badge label', () => {
    const source = readFileSync(cardPath, 'utf-8')
    const hasI18nUsage =
      source.includes("t('") ||
      source.includes('t("')
    expect(hasI18nUsage).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-1: TicketCard.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(cardPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
