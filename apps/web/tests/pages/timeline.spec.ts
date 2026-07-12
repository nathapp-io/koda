import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'timeline.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-Timeline: pages/[project]/timeline.vue exists', () => {
  test('file is present at pages/[project]/timeline.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — Timeline page is reachable with the default layout and uses the
//        existing page pattern (useApi().$api.get, route.params.project,
//        useI18n, useAppToast, extractApiError)
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC1: uses default layout and shared page pattern', () => {
  test('source declares default layout via definePageMeta', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]default['"]/)
  })

  test('source uses useApi composable', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useApi')
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
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — calls $api.get with the path `/projects/<slug>/timeline`
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC2: calls $api.get with /projects/<slug>/timeline', () => {
  test('source uses $api.get for the timeline request', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\$api\.get[\s<(]/)
  })

  test('source interpolates slug into /projects/<slug>/timeline path', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const matched = source.match(/\$api\.get[\s<(][^,;]*[`'"]\/projects\/\$\{slug\}\/timeline/)
    expect(matched).not.toBeNull()
  })

  test('source triggers the initial fetch on mount (onMounted calls loadEvents)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The page must wire an onMounted hook that invokes loadEvents,
    // otherwise AC1/AC2 (events rendered after mount, $api.get called on mount) cannot hold.
    const hasOnMounted = /\bonMounted\s*\(/.test(source)
    const callsLoadEventsInMount = /\bonMounted\s*\([\s\S]{0,200}loadEvents\s*\(\s*\)/.test(source)
    expect(hasOnMounted && callsLoadEventsInMount).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — pending → loading indicator, hides the table
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC3: shows loading indicator when pending', () => {
  test('source has v-if="..." guard referencing isLoading or pending', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasPendingGuard =
      /v-if=["']pending["']/.test(source) ||
      /v-if=["']isLoading["']/.test(source) ||
      /v-if=["'][^"']*isLoading[^"']*["']/.test(source)
    expect(hasPendingGuard).toBe(true)
  })

  test('source renders LoadingState component or loading i18n key while pending', () => {
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
// AC5 — error → toast.error(extractApiError(err)) and renders no rows
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC5: error path uses extractApiError and shows toast', () => {
  test('source catches errors from $api.get', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasTryCatch = /try\s*\{/.test(source) && /\bcatch\b/.test(source)
    expect(hasTryCatch).toBe(true)
  })

  test('source calls toast.error with extractApiError', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/toast\.error\(\s*extractApiError\(/)
  })

  test('source has error ref or branching (renders no rows on error)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasErrorGuard =
      source.includes('v-else-if="error"') ||
      source.includes("v-else-if='error'") ||
      source.includes('v-if="error"') ||
      source.includes("v-if='error'")
    expect(hasErrorGuard).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — event-type filter re-invokes $api.get with eventTypes query param
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC6: event-type filter re-invokes $api.get with eventTypes', () => {
  test('source contains a filter input/state for event types', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasFilterControl =
      source.includes('eventTypes') ||
      source.includes('eventType') ||
      source.includes('event_type') ||
      source.includes('timeline.filter.eventType')
    expect(hasFilterControl).toBe(true)
  })

  test('source passes eventTypes as $api.get query param (key set in buildQuery)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The query builder literal must set `eventTypes` as a key,
    // and the same literal block must be passed via $api.get's options.
    const setsEventTypes = /query\.eventTypes\s*=\s*/.test(source)
    const passesQuery = /\$api\.get[\s\S]{0,400}buildQuery\(\)/.test(source)
    expect(setsEventTypes && passesQuery).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC7 — from/to date filters re-invoke $api.get with from and to query params
// ──────────────────────────────────────────────────────────────────────────────────────

describe('Timeline AC7: from/to date filters re-invoke $api.get', () => {
  test('source exposes from and to controls/state', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasFrom = /\bfrom\b/.test(source)
    const hasTo = /\bto\b/.test(source)
    expect(hasFrom && hasTo).toBe(true)
  })

  test('source passes from and to as $api.get query params (keys set in buildQuery)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const setsFrom = /query\.from\s*=\s*/.test(source)
    const setsTo = /query\.to\s*=\s*/.test(source)
    const passesQuery = /\$api\.get[\s\S]{0,400}buildQuery\(\)/.test(source)
    expect(setsFrom && setsTo && passesQuery).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC8 — pagination: load more re-invokes $api.get with cursor; appends events
// ──────────────────────────────────────────────────────────────────────────────

describe('Timeline AC8: load more re-invokes $api.get with cursor and appends events', () => {
  test('source tracks a cursor state', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\bcursor\b/)
  })

  test('source passes cursor as $api.get query param (key set in buildQuery)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const setsCursor = /query\.cursor\s*=\s*/.test(source)
    const passesQuery = /\$api\.get[\s\S]{0,400}buildQuery\(\)/.test(source)
    expect(setsCursor && passesQuery).toBe(true)
  })

  test('source has a load more button that triggers pagination', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasLoadMore =
      source.includes('loadMore') ||
      source.includes('load more') ||
      source.includes('Load More') ||
      source.includes('timeline.loadMore') ||
      source.includes("t('timeline.loadMore')")
    expect(hasLoadMore).toBe(true)
  })

  test('source appends newly fetched events to the existing list (push or concat)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const appends =
      /\.value\.push\s*\(/.test(source) ||
      /\[\s*\.\.\.[^\]]*[a-zA-Z_$][^,]*,\s*\.\.\.[^\]]*[a-zA-Z_$][^\]]*\]/.test(source) ||
      /events\.value\s*=\s*\[\s*\.\.\./.test(source)
    expect(appends).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC9 — Renders the eventType, actorId, and action per row
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
