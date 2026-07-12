import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'timeline.vue')
const composablePath = join(webDir, 'composables', 'useTimelineEvents.ts')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-Timeline: pages/[project]/timeline.vue exists', () => {
  test('file is present at pages/[project]/timeline.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })

  test('useTimelineEvents composable is extracted at composables/useTimelineEvents.ts', () => {
    // The page delegates data access to a composable that the suite can
    // exercise behaviorally (see tests/composables/useTimelineEvents.spec.ts).
    expect(existsSync(composablePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1/AC2 — Mount-time fetch + page pattern.
// The actual $api.get call is exercised behaviorally in tests/composables/
// useTimelineEvents.spec.ts (AC2/AC5/AC6/AC7/AC8). These source assertions
// confirm the page is wired to the composable and triggers the fetch on mount.
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC1: page pattern + composable delegation', () => {
  test('source declares default layout via definePageMeta', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]default['"]/)
  })

  test('source delegates data access to useTimelineEvents', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useTimelineEvents')
  })

  test('source uses useI18n composable', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useI18n')
  })

  test('source uses useAppToast', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useAppToast')
  })

  test('source imports extractApiError from ~/composables/useApi', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/import\s*\{[^}]*extractApiError[^}]*\}\s*from\s*['"]~?\/composables\/useApi['"]/)
  })

  test('source reads project slug from route.params.project', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/route\.params\.project|\bparams\.project\b/)
  })

  test('source triggers the initial fetch on mount (onMounted invokes the loadEvents wrapper)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The page must wire an onMounted hook that triggers loading.
    const hasOnMounted = /\bonMounted\s*\(/.test(source)
    const callsLoadInMount = /\bonMounted\s*\([\s\S]{0,400}(loadEvents|load[A-Z][A-Za-z]+\(\))[\s\S]{0,40}\)/.test(source)
    expect(hasOnMounted && callsLoadInMount).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — pending → loading indicator, hides the table
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC3: shows loading indicator when pending', () => {
  test('source has v-if guard referencing isLoading', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasPendingGuard =
      /v-if=["']pending["']/.test(source) ||
      /v-if=["']isLoading["']/.test(source) ||
      /v-if=["'][^"']*isLoading[^"']*["']/.test(source)
    expect(hasPendingGuard).toBe(true)
  })

  test('source renders LoadingState component while isLoading', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasLoadingText =
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")') ||
      source.includes('<LoadingState') ||
      source.includes('<loading-state') ||
      source.includes('LoadingState')
    expect(hasLoadingText).toBe(true)
  })

  test('event table is hidden while pending (no row rendering until data ready)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasVFor = /v-for=.*in (events|timeline|items)/.test(source)
    const hasPendingGuard =
      /v-if=["']pending["']/.test(source) ||
      /v-if=["'][^"']*isLoading[^"']*["']/.test(source)
    expect(hasVFor && hasPendingGuard).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — empty response → empty-state message instead of the table
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC4: empty response shows empty-state message', () => {
  test('source renders an empty state when events.length === 0', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasEmptyGuard =
      source.includes('events.length === 0') ||
      source.includes('events.length===0') ||
      source.includes('!events.length') ||
      source.includes("t('timeline.empty')") ||
      source.includes('t("timeline.empty")')
    expect(hasEmptyGuard).toBe(true)
  })

  test('source uses an i18n key for the empty state', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/t\(['"]timeline\.empty['"]\)/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — error path: source uses extractApiError + toast.error in the page's
//        wrapper. The composable's error behavior is exercised behaviorally
//        in tests/composables/useTimelineEvents.spec.ts.
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC5: page-level error wrapper uses extractApiError and toast', () => {
  test('source imports extractApiError', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/import\s*\{[^}]*extractApiError[^}]*\}/)
  })

  test('source calls toast.error with extractApiError', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/toast\.error\(\s*extractApiError\(/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Filter UI: page drives the composable's eventTypeFilter from a select
//        that calls applyFilters on change. The actual $api.get behavior
//        with eventTypes is exercised behaviorally in useTimelineEvents.spec.ts.
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC6: event-type filter UI re-invokes loadEvents', () => {
  test('source contains an event-type select bound to the composable filter', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-model=["']eventTypeFilter["']/)
  })

  test('page re-invokes loadEvents when the filter changes', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The select @change handler must call applyFilters or loadEvents.
    const reInvokes =
      /@change=[\s\S]{0,40}(apply[A-Za-z]*|loadEvents)/.test(source)
    expect(reInvokes).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — Date filters: page drives fromFilter / toFilter on `<Input type="date">`
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC7: from/to date filter UI re-invokes loadEvents', () => {
  test('source binds from / to inputs and re-invokes loadEvents on change', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-model=["']fromFilter["']/)
    expect(source).toMatch(/v-model=["']toFilter["']/)
    const reInvokesOnChange = /@change=[\s\S]{0,40}(apply[A-Za-z]*|loadEvents)/.test(source)
    expect(reInvokesOnChange).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — pagination: load more button wired to loadMore.
//        The actual cursor/append behavior is exercised behaviorally in
//        useTimelineEvents.spec.ts.
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC8: load more button wired to loadMore', () => {
  test('source has a load more button', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasLoadMore =
      source.includes('loadMore') ||
      source.includes('load more') ||
      source.includes('Load More') ||
      source.includes('timeline.loadMore') ||
      source.includes("t('timeline.loadMore')")
    expect(hasLoadMore).toBe(true)
  })

  test('load more button is only shown when there is a next cursor (hasMore)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-if=["']hasMore["']/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Renders the eventType, actorId, and action per row (template)
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC9: each row renders eventType, actorId, action', () => {
  test('source renders eventType per event row', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/event\.eventType|\.eventType|\beventType\b/)
  })

  test('source renders actorId per event row', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\.actorId\b|\bactorId\b/)
  })

  test('source renders action per event row', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\.action\b|\baction\b/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// i18n — navigation label and per-page strings present in BOTH locales
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline i18n: en.json has nav.timeline and timeline.* keys', () => {
  test('en.json parses without error', () => {
    const raw = readFileSync(enLocalePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('en.json has nav.timeline', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.timeline).toBeDefined()
    expect(typeof en.nav.timeline).toBe('string')
    expect(en.nav.timeline.length).toBeGreaterThan(0)
  })

  test('en.json has timeline.empty', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.timeline?.empty).toBeDefined()
    expect(typeof en.timeline.empty).toBe('string')
  })

  test('en.json has timeline.loadMore', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.timeline?.loadMore).toBeDefined()
    expect(typeof en.timeline.loadMore).toBe('string')
  })
})

describe('Timeline i18n: zh.json has nav.timeline and timeline.* keys (parity)', () => {
  test('zh.json parses without error', () => {
    const raw = readFileSync(zhLocalePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('zh.json has nav.timeline', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.timeline).toBeDefined()
    expect(typeof zh.nav.timeline).toBe('string')
    expect(zh.nav.timeline.length).toBeGreaterThan(0)
  })

  test('zh.json has timeline.empty', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.timeline?.empty).toBeDefined()
    expect(typeof zh.timeline.empty).toBe('string')
  })

  test('zh.json has timeline.loadMore', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.timeline?.loadMore).toBeDefined()
    expect(typeof zh.timeline.loadMore).toBe('string')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// No console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline: pages/[project]/timeline.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
