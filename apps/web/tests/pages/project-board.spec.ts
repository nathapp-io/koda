import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'index.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-4: pages/[project]/index.vue exists', () => {
  test('file is present at pages/[project]/index.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — reads slug from useRoute().params.project
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-4 AC1: page reads project slug from useRoute().params.project', () => {
  test('source imports or uses useRoute', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useRoute')
  })

  test('source accesses route.params.project or params.project', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasSlugRead =
      source.includes('params.project') ||
      source.includes("route.params['project']")
    expect(hasSlugRead).toBe(true)
  })

  test('source assigns the slug to a variable (slug or project)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasSlugVar =
      source.includes('slug') ||
      source.includes('projectSlug') ||
      source.match(/const\s+\w+\s*=\s*.*params\.project/) !== null
    expect(hasSlugVar).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — fetches GET /projects/${slug}/tickets via useApi() + useAsyncData()
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-4 AC2: fetches tickets via useApi wrapped in useAsyncData', () => {
  test('source uses useAsyncData for data fetching', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('source uses useApi composable', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source fetches from /projects/.../tickets endpoint', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasFetchEndpoint =
      source.includes('/tickets') &&
      (source.includes('/projects/') || source.includes('projects/${') || source.includes('projects/`'))
    expect(hasFetchEndpoint).toBe(true)
  })

  test('source calls $api.get for ticket fetching', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('source passes the ticket data to TicketBoard', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('TicketBoard')
    const hasTicketsBinding =
      source.includes(':tickets="') ||
      source.includes(":tickets='")
    expect(hasTicketsBinding).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — TicketBoard 'open-ticket' event navigates to /${slug}/tickets/${ref}
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-4 AC3: TicketBoard 'open-ticket' event navigates to ticket detail page", () => {
  test('source uses useRouter or navigateTo for navigation', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasNavigation =
      source.includes('useRouter') ||
      source.includes('navigateTo') ||
      source.includes('router.push')
    expect(hasNavigation).toBe(true)
  })

  test("source handles the 'open-ticket' event from TicketBoard", () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasOpenTicketHandler =
      source.includes('@open-ticket=') ||
      source.includes("@open-ticket='") ||
      source.includes('open-ticket') ||
      source.includes('openTicket')
    expect(hasOpenTicketHandler).toBe(true)
  })

  test('source navigates to /${slug}/tickets/${ref} path', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasTicketNavPath =
      source.includes('/tickets/') ||
      (source.includes('tickets') && source.includes('ref'))
    expect(hasTicketNavPath).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — TicketBoard 'create' event opens CreateTicketDialog with correct projectSlug
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-4 AC4: TicketBoard 'create' event opens CreateTicketDialog", () => {
  test('source uses CreateTicketDialog component', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('CreateTicketDialog')
  })

  test("source handles the 'create' event from TicketBoard", () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasCreateHandler =
      source.includes('@create=') ||
      source.includes("@create='") ||
      source.includes('onCreate') ||
      source.includes('handleCreate')
    expect(hasCreateHandler).toBe(true)
  })

  test('source passes projectSlug prop to CreateTicketDialog', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasProjectSlugProp =
      source.includes(':project-slug=') ||
      source.includes(':projectSlug=') ||
      source.includes('project-slug=') ||
      source.includes('projectSlug=')
    expect(hasProjectSlugProp).toBe(true)
  })

  test('source uses a reactive boolean to control CreateTicketDialog visibility', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasDialogOpen =
      source.includes('showCreateDialog') ||
      source.includes('createDialogOpen') ||
      source.includes('dialogOpen') ||
      source.includes('isDialogOpen') ||
      (source.includes(':open=') && source.includes('ref('))
    expect(hasDialogOpen).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — CreateTicketDialog 'created' event triggers board data refresh
// ──────────────────────────────────────────────────────────────────────────────

describe("US-004-4 AC5: CreateTicketDialog 'created' event triggers data refresh", () => {
  test("source handles the 'created' event from CreateTicketDialog", () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasCreatedHandler =
      source.includes('@created=') ||
      source.includes("@created='") ||
      source.includes('onCreated') ||
      source.includes('handleCreated')
    expect(hasCreatedHandler).toBe(true)
  })

  test('source calls refresh from useAsyncData on ticket created', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasRefresh =
      source.includes('refresh(') ||
      source.includes('refresh ')
    expect(hasRefresh).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-004-4: pages/[project]/index.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
