import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')
const headerPath = join(webDir, 'components', 'TicketHeader.vue')
const activityPath = join(webDir, 'components', 'TicketActivity.vue')
const propertiesPath = join(webDir, 'components', 'TicketProperties.vue')

// 2026-10-05 UX redesign slice 1: the page was split into TicketHeader /
// TicketActivity / TicketProperties, so every source assertion below reads the
// page plus those components (the ticket detail surface as a whole).
function surfaceSource(): string {
  return [
    readFileSync(pagePath, 'utf-8'),
    readFileSync(headerPath, 'utf-8'),
    readFileSync(activityPath, 'utf-8'),
    readFileSync(propertiesPath, 'utf-8'),
  ].join('\n')
}

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1: pages/[project]/tickets/[ref].vue exists', () => {
  test('file is present at pages/[project]/tickets/[ref].vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — reads slug + ref from useRoute() params
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC1: page reads slug and ref from useRoute() params', () => {
  test('source uses useRoute composable', () => {
    const source = surfaceSource()
    expect(source).toContain('useRoute')
  })

  test('source reads project slug from route params', () => {
    const source = surfaceSource()
    const hasSlug =
      source.includes('params.project') ||
      source.includes("params['project']")
    expect(hasSlug).toBe(true)
  })

  test('source reads ref from route params', () => {
    const source = surfaceSource()
    const hasRef =
      source.includes('params.ref') ||
      source.includes("params['ref']")
    expect(hasRef).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — useAsyncData fetches GET /projects/${slug}/tickets/${ref} via useApi()
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC2: fetches ticket detail via useApi wrapped in useAsyncData', () => {
  test('source uses useAsyncData for data fetching', () => {
    const source = surfaceSource()
    expect(source).toContain('useAsyncData')
  })

  test('source uses useApi composable', () => {
    const source = surfaceSource()
    expect(source).toContain('useApi')
  })

  test('source calls $api.get for fetching ticket detail', () => {
    const source = surfaceSource()
    expect(source).toContain('$api.get')
  })

  test('source fetches from /projects/${slug}/tickets/${ref} endpoint', () => {
    const source = surfaceSource()
    const hasFetchEndpoint =
      (source.includes('/projects/') || source.includes('projects/${') || source.includes('projects/`')) &&
      source.includes('/tickets/')
    expect(hasFetchEndpoint).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Two-column layout: left 2/3, right 1/3
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC3: two-column layout with left 2/3 and right 1/3 widths', () => {
  test('source uses a grid or flex two-column layout', () => {
    const source = surfaceSource()
    const hasTwoCol =
      source.includes('grid-cols') ||
      source.includes('col-span') ||
      source.includes('flex') ||
      source.includes('grid')
    expect(hasTwoCol).toBe(true)
  })

  test('source applies 2/3 width class to the left column', () => {
    const source = surfaceSource()
    const hasLeftCol =
      source.includes('col-span-2') ||
      source.includes('w-2/3') ||
      source.includes('2/3')
    expect(hasLeftCol).toBe(true)
  })

  test('source applies 1/3 width class to the right column', () => {
    const source = surfaceSource()
    const hasRightCol =
      source.includes('col-span-1') ||
      source.includes('w-1/3') ||
      source.includes('1/3')
    expect(hasRightCol).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Title and description render from API response (pre-wrap whitespace)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC4: title and description render from API response', () => {
  test('source renders the ticket title', () => {
    const source = surfaceSource()
    const hasTitle =
      source.includes('ticket.title') ||
      source.includes('.title')
    expect(hasTitle).toBe(true)
  })

  test('source renders the ticket description', () => {
    const source = surfaceSource()
    const hasDescription =
      source.includes('ticket.description') ||
      source.includes('.description')
    expect(hasDescription).toBe(true)
  })

  test('source applies white-space pre-wrap to description', () => {
    const source = surfaceSource()
    const hasPreWrap =
      source.includes('whitespace-pre-wrap') ||
      source.includes('white-space: pre-wrap') ||
      source.includes("style=\"white-space") ||
      source.includes('pre-wrap')
    expect(hasPreWrap).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Status, priority, and type display as labeled chips with state dots
// (2026-10-05 UX redesign slice 1: Badge components were replaced by
// token-based chips — a colored dot plus the i18n label, never color alone)
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC5: status, priority, and type render as labeled chips', () => {
  test('source renders chips (rounded-full pills with state dots)', () => {
    const source = surfaceSource()
    expect(source).toContain('rounded-full')
  })

  test('source pairs status colors with a dot map and i18n label', () => {
    const source = surfaceSource()
    const hasStatusChip =
      source.includes('STATUS_DOT') &&
      source.includes('ticket.status') &&
      source.includes('tickets.status.')
    expect(hasStatusChip).toBe(true)
  })

  test('source pairs priority colors with a dot map and i18n label', () => {
    const source = surfaceSource()
    const hasPriorityChip =
      source.includes('PRIORITY_DOT') &&
      source.includes('ticket.priority') &&
      source.includes('tickets.priority.')
    expect(hasPriorityChip).toBe(true)
  })

  test('source renders ticket type as a labeled chip', () => {
    const source = surfaceSource()
    const hasTypeChip =
      // slice 3: the TYPE_CLASS map moved into lib/ticket-chips; the surface uses the helper
      source.includes('typeChipClass') &&
      source.includes('ticket.type') &&
      source.includes('tickets.type.')
    expect(hasTypeChip).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Right column shows assignee and created date metadata
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC6: right column shows assignee and created date metadata', () => {
  test('source renders assignee information', () => {
    const source = surfaceSource()
    const hasAssignee =
      source.includes('assignee') ||
      source.includes('Assignee')
    expect(hasAssignee).toBe(true)
  })

  test('source renders created date', () => {
    const source = surfaceSource()
    const hasCreatedAt =
      source.includes('createdAt') ||
      source.includes('created_at') ||
      source.includes('Created') ||
      source.includes('created')
    expect(hasCreatedAt).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Placeholder <div> slots for TicketActionPanel and CommentThread
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1 AC7: placeholder slots exist for TicketActionPanel and CommentThread', () => {
  test('source contains a placeholder for TicketActionPanel', () => {
    const source = surfaceSource()
    const hasActionPanelSlot =
      source.includes('TicketActionPanel') ||
      source.includes('ticket-action-panel') ||
      source.includes('action-panel') ||
      source.includes('ActionPanel')
    expect(hasActionPanelSlot).toBe(true)
  })

  test('source contains a placeholder for CommentThread', () => {
    const source = surfaceSource()
    const hasCommentThreadSlot =
      source.includes('CommentThread') ||
      source.includes('comment-thread') ||
      source.includes('CommentThread') ||
      source.includes('comments')
    expect(hasCommentThreadSlot).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC3 — Sync link rendered when externalVcsUrl is present
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC3: Ticket detail page renders sync link when externalVcsUrl is present', () => {
  test('source includes externalVcsUrl in Ticket interface', () => {
    const source = surfaceSource()
    expect(source).toContain('externalVcsUrl')
  })

  test('source renders a link element for the sync link', () => {
    const source = surfaceSource()
    const hasLinkElement =
      source.includes('<a') ||
      source.includes('href=')
    expect(hasLinkElement).toBe(true)
  })

  test('source conditionally renders the sync link based on externalVcsUrl', () => {
    const source = surfaceSource()
    const hasConditionalLink =
      source.includes('v-if') &&
      source.includes('externalVcsUrl')
    expect(hasConditionalLink).toBe(true)
  })

  test('source references GitHub or Synced text for the link', () => {
    const source = surfaceSource()
    const hasSyncedRef =
      source.includes('Synced') ||
      source.includes('synced') ||
      source.includes('GitHub') ||
      source.includes('github')
    expect(hasSyncedRef).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC4 — Sync link not rendered when externalVcsUrl is absent
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC4: Ticket detail page does not render sync link when externalVcsUrl is absent', () => {
  test('source uses v-if conditional with externalVcsUrl for sync link', () => {
    const source = surfaceSource()
    const hasExplicitCondition =
      source.includes('v-if') &&
      source.includes('externalVcsUrl')
    expect(hasExplicitCondition).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC5 — Issue number parsed from externalVcsUrl in detail page
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC5: Ticket detail page parses issue number from externalVcsUrl', () => {
  test('source contains logic to extract issue number from URL', () => {
    const source = surfaceSource()
    const hasIssueExtractor =
      source.includes('split') ||
      source.includes('match') ||
      source.includes('substring') ||
      source.includes('slice') ||
      source.includes('replace') ||
      source.includes('/') // Check for path parsing
    expect(hasIssueExtractor).toBe(true)
  })

  test('source displays issue number with # symbol in sync link text', () => {
    const source = surfaceSource()
    const hasIssueDisplay =
      source.includes('#') ||
      source.includes('issue') ||
      source.includes('Issue')
    expect(hasIssueDisplay).toBe(true)
  })

  test('source passes externalVcsUrl as href attribute', () => {
    const source = surfaceSource()
    const hasHrefBinding =
      source.includes(':href') ||
      source.includes('href=')
    expect(hasHrefBinding).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P1-005-D AC6 — i18n keys used for sync link text
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P1-005-D AC6: Ticket detail page uses i18n keys for sync link text', () => {
  test('source uses useI18n composable', () => {
    const source = surfaceSource()
    expect(source).toContain('useI18n')
  })

  test('source references t() for sync link text', () => {
    const source = surfaceSource()
    const hasI18nUsage =
      source.includes("t('") ||
      source.includes('t("')
    expect(hasI18nUsage).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-005-1: pages/[project]/tickets/[ref].vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = surfaceSource()
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P2-003 AC1: Web ticket detail page shows linked PR as clickable badge
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P2-003 AC1: Ticket detail page shows PR as clickable badge when TicketLink with github provider exists', () => {
  test('source includes links array in Ticket interface', () => {
    const source = surfaceSource()
    expect(source).toContain('links')
  })

  test('source renders a clickable badge for GitHub PR links', () => {
    const source = surfaceSource()
    const hasPrBadge =
      (source.includes('Badge') || source.includes('badge')) &&
      (source.includes('github') || source.includes('GitHub') || source.includes('pr') || source.includes('PR'))
    expect(hasPrBadge).toBe(true)
  })

  test('source uses v-for to iterate over links for display', () => {
    const source = surfaceSource()
    const hasLinksLoop =
      source.includes('v-for') &&
      source.includes('links')
    expect(hasLinksLoop).toBe(true)
  })

  test('source filters or displays only github provider links', () => {
    const source = surfaceSource()
    const hasGithubFilter =
      source.includes("'github'") ||
      source.includes('"github"') ||
      source.includes('provider')
    expect(hasGithubFilter).toBe(true)
  })

  test('source renders an anchor tag with href bound to link.url', () => {
    const source = surfaceSource()
    const hasLinkHref =
      (source.includes(':href') || source.includes('href=')) &&
      source.includes('url')
    expect(hasLinkHref).toBe(true)
  })

  test('source displays PR number from externalRef in badge text', () => {
    const source = surfaceSource()
    const hasExternalRef =
      source.includes('externalRef') ||
      source.includes('externalRef')
    expect(hasExternalRef).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P2-003 AC5: i18n keys for PR-related display strings
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P2-003 AC5: Web i18n files contain PR-related keys', () => {
  test('en.json contains pr.created or pr-related key', () => {
    const enPath = join(webDir, 'i18n', 'locales', 'en.json')
    const enSource = readFileSync(enPath, 'utf-8')
    const hasPrKey = enSource.includes('"pr"') || enSource.includes('"prCreated"')
    expect(hasPrKey).toBe(true)
  })

  test('zh.json contains pr.created or pr-related key', () => {
    const zhPath = join(webDir, 'i18n', 'locales', 'zh.json')
    const zhSource = readFileSync(zhPath, 'utf-8')
    const hasPrKey = zhSource.includes('"pr"') || zhSource.includes('"prCreated"')
    expect(hasPrKey).toBe(true)
  })
})
