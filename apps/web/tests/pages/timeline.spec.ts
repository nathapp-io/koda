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
    // Extract the onMounted callback body and verify it contains a call
    // that chains through withToastError -> loadEvents.
    const onMountedMatch = source.match(/\bonMounted\s*\([\s\S]{0,400}\)/)
    expect(onMountedMatch).not.toBeNull()
    const mountedBlock = onMountedMatch?.[0] ?? ''

    // Must contain one of the wrapper functions that ultimately calls loadEvents
    const triggersLoad =
      /\b(loadAndToast|loadEvents|withToastError\s*\(\s*loadEvents)/.test(mountedBlock)
    expect(triggersLoad).toBe(true)
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

  test('event table appears AFTER the loading indicator in the template (chain)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The LoadingState block must come before the event table block so
    // that v-if="isLoading" controls visibility precedence.
    const loadingIdx = source.indexOf('LoadingState')
    const tableIdx = source.indexOf('<table')
    expect(loadingIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(-1)
    expect(loadingIdx).toBeLessThan(tableIdx)
  })

  test('event table is wrapped in v-else (exclusivity with the loading branch)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The block containing the <table> must be guarded by v-if/v-else-if/v-else,
    // and the immediately preceding sibling must be the loading block.
    const tableIdx = source.indexOf('<table')
    // The wrapper <div v-else ...> wrapping the table block:
    const vElseBeforeTable = /v-else(?!\s*-if)/.test(source.slice(Math.max(0, tableIdx - 400), tableIdx))
    expect(vElseBeforeTable).toBe(true)
  })

  test('template uses Complete v-if/v-else-if/v-else chain: isLoading -> empty -> error -> table', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Extract the template section
    const templateStart = source.indexOf('<template>')
    const templateEnd = source.indexOf('</template>', templateStart)
    const template = source.slice(templateStart, templateEnd)

    // Assertions that each guard appears in order (maintaining exclusivity)
    const loadingGuardMatch = template.match(/v-if=["']isLoading["']/)
    const emptyGuardMatch = template.match(/v-else-if=["']events\.length\s*===\s*0["']/)
    const errorGuardMatch = template.match(/v-else-if=["']error["']/)
    const tableGuardMatch = template.match(/v-else(?!\s*-if)/)

    expect(loadingGuardMatch).not.toBeNull()
    expect(emptyGuardMatch).not.toBeNull()
    expect(errorGuardMatch).not.toBeNull()
    expect(tableGuardMatch).not.toBeNull()

    // Verify ordering: loading -> empty -> error -> table
    const loadingIdx = loadingGuardMatch?.index ?? -1
    const emptyIdx = emptyGuardMatch?.index ?? -1
    const errorIdx = errorGuardMatch?.index ?? -1
    const tableIdx = tableGuardMatch?.index ?? -1
    expect(loadingIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeGreaterThan(-1)
    expect(errorIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(-1)
    expect(loadingIdx).toBeLessThan(emptyIdx)
    expect(emptyIdx).toBeLessThan(errorIdx)
    expect(errorIdx).toBeLessThan(tableIdx)
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

  test('source wraps loadEvents/loadMore calls in a try/catch wrapper so errors reach toast', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The page has a helper that catches errors from the composable (verified
    // behaviorally in tests/composables/useTimelineEvents.spec.ts) and feeds
    // them to extractApiError + toast.error. Either pattern is acceptable:
    //   1) try/catch directly around loadEvents/loadMore, OR
    //   2) a wrapper helper (e.g. withToastError) called from each handler.
    const inlineTryCatch = /\btry\s*\{[\s\S]{0,400}\b(load|apply)[A-Z]?[\s\S]{0,400}\bcatch\b[\s\S]{0,400}extractApiError/.test(source)
    const hasWrapperCalledWith = /\bwithToast[A-Za-z]*\s*\(/.test(source)
      && /extractApiError/.test(source)
      && /loadEvents|loadMore|applyFilters/.test(source)
    // Also verify that loadEvents, applyFilters, and loadMore are each passed through the wrapper
    const loadAndToastWired = /loadAndToast\b/.test(source) && /withToastError\s*\(\s*loadEvents\s*\)/.test(source)
    const applyAndToastWired = /applyAndToast\b/.test(source) && /withToastError\s*\(\s*applyFilters\s*\)/.test(source)
    const loadMoreAndToastWired = /loadMoreAndToast\b/.test(source) && /withToastError\s*\(\s*loadMore\s*\)/.test(source)
    expect(inlineTryCatch || (hasWrapperCalledWith && loadAndToastWired && applyAndToastWired && loadMoreAndToastWired)).toBe(true)
  })

  test('composable re-throws so the page wrapper receives the error', () => {
    // Cross-reference the composable source: loadEvents / loadMore / applyFilters
    // must re-throw errors, otherwise the page-level try/catch never sees them.
    const composableSource = readFileSync(composablePath, 'utf-8')
    const rethrows =
      /catch\s*\([^)]*\)\s*\{[\s\S]{0,200}throw\s+/.test(composableSource)
    expect(rethrows).toBe(true)
  })

  test('event table rendering is hidden when error is non-null (no rows on error)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The template must have a `v-if="error"` (or v-else-if) branch BEFORE
    // the event table block, so a failed load shows nothing.
    const errorGuardIdx = source.search(/v-else-if=["']error["']/)
    const tableIdx = source.indexOf('<table')
    expect(errorGuardIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(errorGuardIdx)

    // The error div itself must NOT render any event rows (no v-for inside it)
    const errorDivStart = errorGuardIdx
    const nextVGuardIdx = source.indexOf('v-else', errorDivStart)
    const errorBlock = source.slice(errorDivStart, nextVGuardIdx !== -1 ? nextVGuardIdx : undefined)
    // Error block should be self-closing or empty — it should not contain a v-for over events
    expect(errorBlock).not.toMatch(/v-for\s*=\s*['"]event\s+in\s+events['"]/)
    expect(errorBlock).not.toMatch(/event\.eventType/)
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
  test('the v-for body interpolates {{ event.eventType }} (binds the data field)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The composable returns events with field eventType; the template must
    // explicitly bind that field via interpolation (not just mention the name).
    expect(source).toMatch(/\{\{[^}]*event\.eventType[^}]*\}\}/)
  })

  test('the v-for body interpolates {{ event.actorId }} (binds the data field)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*event\.actorId[^}]*\}\}/)
  })

  test('the v-for body interpolates {{ event.action }} (binds the data field)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*event\.action[^}]*\}\}/)
  })

  test('eventType, actorId, action bindings are inside the v-for loop body', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Find the v-for that iterates over `events` (not the EVENT_TYPES <option>
    // loop, which is a UI constant).
    const eventsVFor = source.match(/v-for=["']event in events["']/)
    expect(eventsVFor).not.toBeNull()
    const vForIdx = (eventsVFor?.index ?? -1) as number
    // Walk back to the start of the containing <tr ... v-for=...> element
    const trStart = source.lastIndexOf('<tr', vForIdx)
    const trEnd = source.indexOf('</tr>', vForIdx)
    expect(trStart).toBeGreaterThan(-1)
    expect(trEnd).toBeGreaterThan(trStart)
    const rowBody = source.slice(trStart, trEnd)
    expect(rowBody).toMatch(/\{\{[^}]*event\.eventType[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*event\.actorId[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*event\.action[^}]*\}\}/)
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
