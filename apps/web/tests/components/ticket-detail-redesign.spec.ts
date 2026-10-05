import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')
const headerPath = join(webDir, 'components', 'TicketHeader.vue')
const activityPath = join(webDir, 'components', 'TicketActivity.vue')
const propertiesPath = join(webDir, 'components', 'TicketProperties.vue')
const panelPath = join(webDir, 'components', 'TicketActionPanel.vue')
// Slice 3 moved the chip token maps into the shared lib; the surface follows them (same
// reasoning as slice 1 reading page + components as one surface).
const chipsPath = join(webDir, 'lib', 'ticket-chips.ts')

function src(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('UX redesign slice 1: ticket detail components exist', () => {
  test.each([
    ['pages/[project]/tickets/[ref].vue', pagePath],
    ['components/TicketHeader.vue', headerPath],
    ['components/TicketActivity.vue', activityPath],
    ['components/TicketProperties.vue', propertiesPath],
  ])('%s is present', (_name, path) => {
    expect(existsSync(path)).toBe(true)
  })
})

describe('UX redesign slice 1: state colors come from tokens, never raw hex', () => {
  const surface = () => [src(headerPath), src(propertiesPath), src(chipsPath)].join('\n')

  test('status dots use the status-* token classes', () => {
    expect(surface()).toContain('bg-status-todo')
    expect(surface()).toContain('bg-status-active')
    expect(surface()).toContain('bg-status-review')
    expect(surface()).toContain('bg-status-done')
    expect(surface()).toContain('bg-status-rejected')
  })

  test('priority dots use the priority-* token classes', () => {
    expect(surface()).toContain('bg-priority-critical')
    expect(surface()).toContain('bg-priority-high')
    expect(surface()).toContain('bg-priority-medium')
    expect(surface()).toContain('bg-priority-low')
  })

  test('no raw hex colors in the ticket detail surface', () => {
    const sources = [src(pagePath), surface(), src(activityPath)].join('\n')
    expect(sources).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('UX redesign slice 1: two-column layout with sticky properties', () => {
  test('page uses a 3-column grid at lg with col-span-2 main and col-span-1 rail', () => {
    const source = src(pagePath)
    expect(source).toContain('lg:grid-cols-3')
    expect(source).toContain('lg:col-span-2')
    expect(source).toContain('lg:col-span-1')
  })

  test('properties rail is sticky below the app header on lg', () => {
    const source = src(pagePath)
    expect(source).toContain('lg:sticky')
    expect(source).toContain('lg:top-[72px]')
  })

  test('properties panels collapse under the title below lg via details/summary', () => {
    const source = src(propertiesPath)
    expect(source).toContain('<details')
    expect(source).toContain('<summary')
    expect(source).toContain('lg:pointer-events-none')
  })
})

describe('UX redesign slice 1: next-step hierarchy in TicketActionPanel', () => {
  test('exactly one primary action is chosen from the forward transitions', () => {
    const source = src(panelPath)
    expect(source).toContain('PRIMARY_ORDER')
    expect(source).toContain('primaryAction')
  })

  test('secondary actions render as outline, reject stays destructive', () => {
    const source = src(panelPath)
    expect(source).toContain('variant="outline"')
    expect(source).toContain('variant="destructive"')
  })

  test('dialog-required actions still open the dialog', () => {
    const source = src(panelPath)
    expect(source).toContain("openDialog('close')")
    expect(source).toContain("openDialog('verify-fix-approve')")
  })
})

describe('UX redesign slice 1: untrusted text rules', () => {
  test('description HTML is rendered through renderMarkdownOrEscape only', () => {
    const source = src(activityPath)
    expect(source).toContain('renderMarkdownOrEscape')
    expect(source).toContain('v-html')
  })

  test('no v-html anywhere in header or properties', () => {
    expect(src(headerPath)).not.toContain('v-html')
    expect(src(propertiesPath)).not.toContain('v-html')
  })
})

describe('UX redesign slice 1: keyboard access', () => {
  test('page binds a keydown handler with E for edit and Escape for cancel', () => {
    const source = src(pagePath)
    expect(source).toContain('onPageKeydown')
    expect(source).toContain("'Escape'")
  })
})

describe('UX redesign slice 1: i18n keys exist in both locales', () => {
  const newKeys = [
    'activity',
    'properties',
    'nextStep',
    'nextHint',
    'linked',
    'opened',
    'copyRef',
  ]

  test.each(newKeys)('tickets.detail.%s exists in en and zh', (key) => {
    const en = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'en.json'), 'utf-8')) as {
      tickets: { detail: Record<string, unknown> }
    }
    const zh = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'zh.json'), 'utf-8')) as {
      tickets: { detail: Record<string, unknown> }
    }
    expect(typeof en.tickets.detail[key]).toBe('string')
    expect(typeof zh.tickets.detail[key]).toBe('string')
    expect(en.tickets.detail[key]).toBeTruthy()
    expect(zh.tickets.detail[key]).toBeTruthy()
  })
})
