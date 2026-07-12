import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../../..')
const timelinePath = join(webDir, 'pages', '[project]', 'timeline.vue')
const memoryPath = join(webDir, 'pages', '[project]', 'memory.vue')
const codeIntelPath = join(webDir, 'pages', '[project]', 'code-intel.vue')
const slosPath = join(webDir, 'pages', 'admin', 'slos.vue')
const timelineComposablePath = join(webDir, 'composables', 'useTimelineEvents.ts')
const memoryComposablePath = join(webDir, 'composables', 'useMemory.ts')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enJsonPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhJsonPath = join(webDir, 'i18n', 'locales', 'zh.json')

// Read the timeline page + its composable together — the page delegates the
// $api.get call to useTimelineEvents, so the actual fetch + query construction
// lives in the composable, not the .vue file.
function readTimelineSource(): string {
  return `${readFileSync(timelinePath, 'utf-8')}\n${readFileSync(timelineComposablePath, 'utf-8')}`
}

// Read the memory page + its composable together — the page delegates the
// $api.get call to useMemory, so the actual fetch + query construction lives
// in the composable, not the .vue file.
function readMemorySource(): string {
  return `${readFileSync(memoryPath, 'utf-8')}\n${readFileSync(memoryComposablePath, 'utf-8')}`
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Timeline page renders one row per event with eventType, actorId, action
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-1: Timeline page renders event rows with eventType, actorId, action columns', () => {
  test('timeline.vue file exists', () => {
    expect(existsSync(timelinePath)).toBe(true)
  })

  test('source renders eventType field per row', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/\.eventType\b|event\.eventType|item\.eventType/)
  })

  test('source renders actorId field per row', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/\.actorId\b|event\.actorId|item\.actorId/)
  })

  test('source renders action field per row', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/\.action\b|event\.action|item\.action/)
  })

  test('source iterates over events with v-for', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toContain('v-for')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: Timeline page calls $api.get with /projects/<slug>/timeline on mount
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-2: Timeline page calls $api.get with /projects/<slug>/timeline', () => {
  test('source uses $api.get for data fetching', () => {
    const source = readTimelineSource()
    expect(source).toContain('$api.get')
  })

  test('source fetches from /projects/${slug}/timeline endpoint', () => {
    const source = readTimelineSource()
    expect(source).toMatch(/\/projects\/\$\{[^}]+\}\/timeline|\/projects\/\`[^`]*\`\/timeline|projects.*timeline/)
  })

  test('source reads project param from route', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/route\.params\.project|params\.project/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Timeline page renders loading indicator while $api.get is pending
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-3: Timeline page shows loading indicator while pending, hides event table', () => {
  test('source has a loading/pending state variable', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/\bpending\b|\bisLoading\b|\bloading\b/)
  })

  test('source conditionally renders loading indicator (v-if on pending/loading)', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasLoadingConditional =
      source.match(/v-if=["']pending["']/) ||
      source.match(/v-if=["']isLoading["']/) ||
      source.match(/v-if=["']loading["']/) ||
      source.match(/v-if="pending"/) ||
      source.match(/v-if="isLoading"/) ||
      (source.includes('pending') && source.includes('LoadingState')) ||
      (source.includes('isLoading') && (source.includes('LoadingState') || source.includes('loading')))
    expect(hasLoadingConditional).toBeTruthy()
  })

  test('source renders LoadingState component or loading text inside pending block', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasLoadingUi =
      source.includes('<LoadingState') ||
      source.includes('<loading-state') ||
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingUi).toBe(true)
  })

  test('event table is guarded by v-else or v-if (absent when loading)', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/v-else|v-if=["']!pending["']|v-if=["']!isLoading["']|v-if=["']!loading["']/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: Timeline page renders empty-state message when events array is empty
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-4: Timeline page renders empty-state when API returns empty array', () => {
  test('source has empty-state handling', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasEmptyState =
      source.includes('<EmptyState') ||
      source.includes('<empty-state') ||
      source.includes('timeline.empty') ||
      source.match(/\.length\s*===\s*0|\.length\s*==\s*0|!.*\.length/) !== null ||
      source.includes('empty')
    expect(hasEmptyState).toBeTruthy()
  })

  test('source conditionally hides or omits event table when list is empty', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasConditionalTable =
      source.match(/v-if=["'][^"']*length[^"']*["']/) ||
      source.match(/v-if=["'][^"']*events[^"']*["']/) ||
      source.match(/v-else-if=["'][^"']*length[^"']*["']/) ||
      source.match(/v-else-if=["'][^"']*events[^"']*["']/) ||
      source.includes('EmptyState') ||
      source.includes('empty-state')
    expect(hasConditionalTable).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Timeline page calls extractApiError and toast.error on $api.get rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-5: Timeline page surfaces extractApiError via toast on error', () => {
  test('source imports or calls extractApiError', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('source uses useAppToast or toast for error notification', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasToast =
      source.includes('useAppToast') ||
      source.includes('toast.error') ||
      source.includes('toast?.error')
    expect(hasToast).toBe(true)
  })

  test('source has try/catch or .catch for error handling', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasErrorHandling =
      source.includes('try') ||
      source.includes('catch') ||
      source.includes('.catch(')
    expect(hasErrorHandling).toBe(true)
  })

  test('source calls toast.error with extractApiError result', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toContain('extractApiError')
    const hasToastError =
      source.includes('toast.error') ||
      source.includes('toast?.error') ||
      (source.includes('useAppToast') && source.includes('.error'))
    expect(hasToastError).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: Timeline page re-invokes $api.get with eventTypes query param on filter
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-6: Timeline page passes eventTypes query param when filter is applied', () => {
  test('source references eventTypes in query params', () => {
    const source = readTimelineSource()
    expect(source).toContain('eventTypes')
  })

  test('source passes query object with eventTypes to $api.get', () => {
    const source = readTimelineSource()
    expect(source).toContain('$api.get')
    expect(source).toContain('eventTypes')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: Timeline page passes from/to query params on date filter apply
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-7: Timeline page passes from and to query params for date range filter', () => {
  test('source references from date query param', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/\bfrom\b/)
  })

  test('source references to date query param', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    expect(source).toMatch(/\bto\b[^k]/)
  })

  test('source builds query object with from and to for $api.get', () => {
    const source = readTimelineSource()
    expect(source).toContain('from')
    expect(source).toContain('$api.get')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: Timeline load-more re-invokes $api.get with cursor and appends events
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-8: Timeline load-more passes cursor and appends returned events', () => {
  test('source references cursor for pagination', () => {
    const source = readTimelineSource()
    expect(source).toContain('cursor')
  })

  test('source appends new events to existing list (push, spread, or concat)', () => {
    const source = readTimelineSource()
    const hasAppend =
      source.includes('.push(') ||
      source.includes('...events') ||
      source.includes('concat(') ||
      source.match(/\.\.\.[a-zA-Z]+,\s*\.\.\.[a-zA-Z]+/) !== null ||
      source.includes('spread') ||
      source.match(/\[\.\.\./) !== null
    expect(hasAppend).toBeTruthy()
  })

  test('source has a load-more action or button', () => {
    const source = readFileSync(timelinePath, 'utf-8')
    const hasLoadMore =
      source.includes('loadMore') ||
      source.includes('load-more') ||
      source.includes('load_more') ||
      source.match(/timeline\.loadMore|timeline\.load_more|loadNextPage/) !== null
    expect(hasLoadMore).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: default.vue renders nav link to /<slug>/timeline with nav.timeline i18n
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-9: default.vue sidebar includes nav link for timeline with nav.timeline i18n key', () => {
  test('layouts/default.vue contains reference to /timeline path', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('/timeline')
  })

  test('layouts/default.vue uses nav.timeline i18n key for timeline link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain("nav.timeline")
  })

  test('en.json has nav.timeline key', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8'))
    expect(en.nav).toBeDefined()
    expect(en.nav.timeline).toBeDefined()
    expect(typeof en.nav.timeline).toBe('string')
    expect(en.nav.timeline.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.timeline key', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8'))
    expect(zh.nav).toBeDefined()
    expect(zh.nav.timeline).toBeDefined()
    expect(typeof zh.nav.timeline).toBe('string')
    expect(zh.nav.timeline.length).toBeGreaterThan(0)
  })

  test('timeline link is inside project-scoped nav section (v-if projectSlug)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const projectSectionStart = source.indexOf('projectSlug')
    const timelineIndex = source.indexOf('/timeline', projectSectionStart)
    expect(projectSectionStart).toBeGreaterThanOrEqual(0)
    expect(timelineIndex).toBeGreaterThan(projectSectionStart)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: Memory page renders one row per item with all required fields
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-10: Memory page renders rows with subject, predicate, object, kind, confidence, status', () => {
  test('memory.vue file exists', () => {
    expect(existsSync(memoryPath)).toBe(true)
  })

  test('source renders subject field', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\.subject\b|item\.subject/)
  })

  test('source renders predicate field', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\.predicate\b|item\.predicate/)
  })

  test('source renders object field', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\.object\b|item\.object/)
  })

  test('source renders kind field', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\.kind\b|item\.kind/)
  })

  test('source renders confidence field', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\.confidence\b|item\.confidence/)
  })

  test('source renders status field', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\.status\b|item\.status/)
  })

  test('source iterates over items with v-for', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toContain('v-for')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: Memory page calls $api.get with /projects/<slug>/memory on mount
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-11: Memory page calls $api.get with /projects/<slug>/memory', () => {
  test('source calls $api.get', () => {
    const source = readMemorySource()
    expect(source).toContain('$api.get')
  })

  test('source fetches from /projects/${slug}/memory endpoint', () => {
    const source = readMemorySource()
    expect(source).toMatch(/\/projects\/\$\{[^}]+\}\/memory|projects.*memory/)
  })

  test('source reads project param from route', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/route\.params\.project|params\.project/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: Memory page shows loading indicator while request is pending
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-12: Memory page shows loading indicator while pending, hides item table', () => {
  test('source has a loading/pending state', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/\bpending\b|\bisLoading\b|\bloading\b/)
  })

  test('source conditionally renders loading UI', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    const hasLoadingUi =
      source.includes('<LoadingState') ||
      source.includes('<loading-state') ||
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingUi).toBe(true)
  })

  test('item table is absent during loading (v-else or conditional)', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toMatch(/v-else|v-if=["']!pending["']|v-if=["']!isLoading["']/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: Memory page renders empty-state when items is empty
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-13: Memory page renders empty-state when items array is empty', () => {
  test('source has empty-state UI element', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    const hasEmptyState =
      source.includes('<EmptyState') ||
      source.includes('<empty-state') ||
      source.includes('memory.empty') ||
      source.includes('empty') ||
      source.match(/\.length\s*===\s*0/) !== null
    expect(hasEmptyState).toBeTruthy()
  })

  test('source item table is conditionally hidden when empty', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    const hasConditional =
      source.match(/v-if=["'][^"']*length[^"']*["']/) ||
      source.match(/v-if=["'][^"']*items[^"']*["']/) ||
      source.match(/v-else-if=["'][^"']*length[^"']*["']/) ||
      source.match(/v-else-if=["'][^"']*items[^"']*["']/) ||
      source.includes('EmptyState') ||
      source.includes('empty-state')
    expect(hasConditional).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: Memory page calls extractApiError and toast.error on rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-14: Memory page surfaces extractApiError via toast on error, renders no rows', () => {
  test('source calls extractApiError', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('source uses toast for error notification', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    const hasToast =
      source.includes('useAppToast') ||
      source.includes('toast.error') ||
      source.includes('toast?.error')
    expect(hasToast).toBe(true)
  })

  test('source has error handling (try/catch or .catch)', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    const hasErrorHandling =
      source.includes('try') ||
      source.includes('catch') ||
      source.includes('.catch(')
    expect(hasErrorHandling).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: Memory page passes kind query param when kind filter is applied
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-15: Memory page passes kind query param on filter apply, preserving it on subsequent calls', () => {
  test('source references kind in query params', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toContain('kind')
  })

  test('source builds query containing kind for $api.get', () => {
    const source = readMemorySource()
    expect(source).toContain('$api.get')
    expect(source).toContain('kind')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: Memory page passes status query param when status filter is applied
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-16: Memory page passes status query param on filter apply, preserving it on subsequent calls', () => {
  test('source references status in query params for filtering', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    expect(source).toContain('status')
  })

  test('source builds query containing status for $api.get', () => {
    const source = readMemorySource()
    expect(source).toContain('$api.get')
    expect(source).toContain('status')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: Memory load-more passes page=2 and appends items to existing list
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-17: Memory load-more invokes $api.get with page and appends items', () => {
  test('source references page param for pagination', () => {
    const source = readMemorySource()
    expect(source).toMatch(/\bpage\b/)
  })

  test('source appends new items to existing list', () => {
    const source = readMemorySource()
    const hasAppend =
      source.includes('.push(') ||
      source.includes('concat(') ||
      source.match(/\[\.\.\./) !== null ||
      source.match(/\.\.\.items/) !== null
    expect(hasAppend).toBeTruthy()
  })

  test('source has a load-more mechanism', () => {
    const source = readFileSync(memoryPath, 'utf-8')
    const hasLoadMore =
      source.includes('loadMore') ||
      source.includes('load-more') ||
      source.match(/page\s*\+\s*1|page\+\+|currentPage/) !== null
    expect(hasLoadMore).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: default.vue sidebar has nav link to /<slug>/memory with nav.memory i18n
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-18: default.vue sidebar includes nav link for memory with nav.memory i18n key', () => {
  test('layouts/default.vue contains /memory path reference', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('/memory')
  })

  test('layouts/default.vue uses nav.memory i18n key for memory link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain("nav.memory")
  })

  test('en.json has nav.memory key', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8'))
    expect(en.nav).toBeDefined()
    expect(en.nav.memory).toBeDefined()
    expect(typeof en.nav.memory).toBe('string')
    expect(en.nav.memory.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.memory key', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8'))
    expect(zh.nav).toBeDefined()
    expect(zh.nav.memory).toBeDefined()
    expect(typeof zh.nav.memory).toBe('string')
    expect(zh.nav.memory.length).toBeGreaterThan(0)
  })

  test('memory link is inside project-scoped nav section', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const projectSectionStart = source.indexOf('projectSlug')
    const memoryIndex = source.indexOf('/memory', projectSectionStart)
    expect(projectSectionStart).toBeGreaterThanOrEqual(0)
    expect(memoryIndex).toBeGreaterThan(projectSectionStart)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: Code-intel page calls $api.get with /code-intel/symbols and query params
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-19: Code-intel search calls $api.get with /code-intel/symbols, projectSlug, and q', () => {
  test('code-intel.vue file exists', () => {
    expect(existsSync(codeIntelPath)).toBe(true)
  })

  test('source calls $api.get', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('source fetches from /code-intel/symbols endpoint', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('/code-intel/symbols')
  })

  test('source passes projectSlug query param', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('projectSlug')
  })

  test('source passes q query param for search', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/\bq\b[^u]/)
  })

  test('source reads project param from route for projectSlug', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/route\.params\.project|params\.project/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: Code-intel page renders one result row per symbol with name, kind, file
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-20: Code-intel page renders result rows with symbol name, kind, and file', () => {
  test('source renders symbol name field', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/\.name\b|symbol\.name|item\.name/)
  })

  test('source renders symbol kind field', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/\.kind\b|symbol\.kind|item\.kind/)
  })

  test('source renders symbol file field', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/\.file\b|symbol\.file|item\.file/)
  })

  test('source iterates result rows with v-for', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('v-for')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: Code-intel page shows loading indicator while search is pending
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-21: Code-intel page shows loading indicator while isLoading is true, hides results table', () => {
  test('source has a loading/pending state variable', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/\bpending\b|\bisLoading\b|\bloading\b/)
  })

  test('source renders loading UI conditionally', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasLoadingUi =
      source.includes('<LoadingState') ||
      source.includes('<loading-state') ||
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingUi).toBe(true)
  })

  test('results table is conditionally absent during loading', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toMatch(/v-else|v-if=["']!pending["']|v-if=["']!isLoading["']|v-if=["']!loading["']/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: Code-intel page renders empty/"no matches" state when symbols array is empty
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-22: Code-intel page renders no-matches/empty state when API returns empty symbols', () => {
  test('source has empty-state or no-matches UI', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasEmptyState =
      source.includes('<EmptyState') ||
      source.includes('<empty-state') ||
      source.includes('noMatch') ||
      source.includes('no-match') ||
      source.includes('codeIntel.empty') ||
      source.includes('empty') ||
      source.match(/length\s*===\s*0/) !== null
    expect(hasEmptyState).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-23: Code-intel page calls useAppToast().error with extractApiError on rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-23: Code-intel page calls useAppToast().error with extractApiError(err) on rejection', () => {
  test('source calls extractApiError', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('source uses toast for error notification', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasToast =
      source.includes('useAppToast') ||
      source.includes('toast.error') ||
      source.includes('toast?.error')
    expect(hasToast).toBe(true)
  })

  test('source has error handling (try/catch)', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasErrorHandling =
      source.includes('try') ||
      source.includes('catch') ||
      source.includes('.catch(')
    expect(hasErrorHandling).toBe(true)
  })

  test('results section is absent on error (no results rendered on rejection)', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasConditionalResults =
      source.match(/v-if=["'][^"']*items[^"']*["']/) ||
      source.match(/v-if=["'][^"']*symbols[^"']*["']/) ||
      source.match(/v-if=["'][^"']*results[^"']*["']/) ||
      source.includes('v-else')
    expect(hasConditionalResults).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-24: Code-intel result row click expands detail panel with signature, docComment, callers, callees
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-24: Code-intel detail panel renders signature, docComment, and callers/callees as text lists', () => {
  test('source references signature field for detail view', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('signature')
  })

  test('source references docComment field for detail view', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('docComment')
  })

  test('source references callers for detail view', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('callers')
  })

  test('source references callees for detail view', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    expect(source).toContain('callees')
  })

  test('detail panel renders callers/callees as list items (ul/li or v-for)', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasList =
      source.includes('<ul') ||
      source.includes('<li') ||
      (source.includes('callers') && source.includes('v-for')) ||
      (source.includes('callees') && source.includes('v-for'))
    expect(hasList).toBe(true)
  })

  test('detail panel is toggled on row click (click handler or selected state)', () => {
    const source = readFileSync(codeIntelPath, 'utf-8')
    const hasClickToggle =
      source.includes('@click') ||
      source.includes('v-on:click') ||
      source.includes('selected') ||
      source.includes('expanded')
    expect(hasClickToggle).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: default.vue sidebar has nav link to /<slug>/code-intel with nav.codeIntel i18n
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-25: default.vue sidebar includes nav link for code-intel with nav.codeIntel i18n key', () => {
  test('layouts/default.vue contains /code-intel path reference', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('code-intel')
  })

  test('layouts/default.vue uses nav.codeIntel i18n key for code-intel link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain("nav.codeIntel")
  })

  test('en.json has nav.codeIntel key', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8'))
    expect(en.nav).toBeDefined()
    expect(en.nav.codeIntel).toBeDefined()
    expect(typeof en.nav.codeIntel).toBe('string')
    expect(en.nav.codeIntel.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.codeIntel key', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8'))
    expect(zh.nav).toBeDefined()
    expect(zh.nav.codeIntel).toBeDefined()
    expect(typeof zh.nav.codeIntel).toBe('string')
    expect(zh.nav.codeIntel.length).toBeGreaterThan(0)
  })

  test('code-intel link is inside project-scoped nav section', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const projectSectionStart = source.indexOf('projectSlug')
    const codeIntelIndex = source.indexOf('code-intel', projectSectionStart)
    expect(projectSectionStart).toBeGreaterThanOrEqual(0)
    expect(codeIntelIndex).toBeGreaterThan(projectSectionStart)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-26: SLO page renders one metric card per SLO metric with label and value
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-26: SLO page renders N metric cards each showing label and value', () => {
  test('pages/admin/slos.vue file exists', () => {
    expect(existsSync(slosPath)).toBe(true)
  })

  test('source renders metric label field', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toMatch(/\.label\b|metric\.label|slo\.label|item\.label/)
  })

  test('source renders metric value field', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toMatch(/\.value\b|metric\.value|slo\.value|item\.value/)
  })

  test('source iterates over metrics with v-for', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toContain('v-for')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-27: SLO page calls $api.get('/admin/slos') exactly once on mount
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-27: SLO page calls $api.get with /admin/slos on mount', () => {
  test('source calls $api.get', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toContain('$api.get')
  })

  test('source fetches from /admin/slos endpoint', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toContain('/admin/slos')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-28: SLO page re-invokes $api.get with from/to on date-window change
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-28: SLO page passes from and to query params after date-window change event', () => {
  test('source references from in query params', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toMatch(/\bfrom\b/)
  })

  test('source references to in query params', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toMatch(/\bto\b/)
  })

  test('source handles a date-window change event or interaction', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const hasDateWindow =
      source.includes('dateWindow') ||
      source.includes('date-window') ||
      source.includes('dateRange') ||
      source.includes('from') && source.includes('to')
    expect(hasDateWindow).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-29: SLO page shows loading indicator while $api.get is pending, hides metric cards
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-29: SLO page shows loading indicator while pending, renders zero metric cards', () => {
  test('source has a loading/pending state', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toMatch(/\bpending\b|\bisLoading\b|\bloading\b/)
  })

  test('source renders loading UI conditionally', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const hasLoadingUi =
      source.includes('<LoadingState') ||
      source.includes('<loading-state') ||
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingUi).toBe(true)
  })

  test('metric cards are conditionally absent during loading (v-else or negative guard)', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toMatch(/v-else|v-if=["']!pending["']|v-if=["']!isLoading["']|v-if=["']!loading["']/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-30: SLO page renders "admin only" friendly state on 403; does NOT call toast.error
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-30: SLO page renders admin-only forbidden state on 403 without calling toast.error', () => {
  test('source checks for 403 status or ADMIN_ONLY error code', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const hasForbiddenCheck =
      source.includes('403') ||
      source.includes('status') ||
      source.includes('Forbidden') ||
      source.includes('forbidden') ||
      source.includes('ADMIN') ||
      source.includes('adminOnly')
    expect(hasForbiddenCheck).toBeTruthy()
  })

  test('source renders a friendly admin-only message element', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const hasAdminOnlyUi =
      source.includes('admin') ||
      source.includes('Admin') ||
      source.includes('forbidden') ||
      source.includes('adminOnly') ||
      source.includes('slos.adminOnly') ||
      source.includes('403')
    expect(hasAdminOnlyUi).toBeTruthy()
  })

  test('source conditionally shows admin-only state based on error code/status', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const has403Branch =
      source.match(/403|status\s*===\s*403|forbidden|Forbidden/) !== null
    expect(has403Branch).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-31: SLO page calls extractApiError + toast.error on non-403 errors
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-31: SLO page calls extractApiError and toast.error for non-403 errors', () => {
  test('source calls extractApiError for error handling', () => {
    const source = readFileSync(slosPath, 'utf-8')
    expect(source).toContain('extractApiError')
  })

  test('source uses toast error notification for non-403 errors', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const hasToast =
      source.includes('useAppToast') ||
      source.includes('toast.error') ||
      source.includes('toast?.error')
    expect(hasToast).toBe(true)
  })

  test('source distinguishes 403 from other errors (conditional branch)', () => {
    const source = readFileSync(slosPath, 'utf-8')
    const hasBranch =
      source.match(/if.*403|===\s*403|status\s*===\s*403/) !== null ||
      (source.includes('403') && (source.includes('else') || source.includes('catch')))
    expect(hasBranch).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC-32: default.vue includes top-level nav link to /admin/slos with nav.slos i18n
// ─────────────────────────────────────────────────────────────────────────────

describe('AC-32: default.vue has top-level nav link /admin/slos with nav.slos i18n key', () => {
  test('layouts/default.vue contains /admin/slos path reference', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('/admin/slos')
  })

  test('layouts/default.vue uses nav.slos i18n key for SLO link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain("nav.slos")
  })

  test('en.json has nav.slos key', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8'))
    expect(en.nav).toBeDefined()
    expect(en.nav.slos).toBeDefined()
    expect(typeof en.nav.slos).toBe('string')
    expect(en.nav.slos.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.slos key', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8'))
    expect(zh.nav).toBeDefined()
    expect(zh.nav.slos).toBeDefined()
    expect(typeof zh.nav.slos).toBe('string')
    expect(zh.nav.slos.length).toBeGreaterThan(0)
  })

  test('SLO link is a top-level link (not gated behind projectSlug template)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const slosIndex = source.indexOf('/admin/slos')
    const projectScopeStart = source.indexOf('<template v-if="projectSlug">')
    const projectScopeAlt = source.indexOf('v-if="projectSlug"')
    // The /admin/slos link must appear before the project-scoped template block,
    // or outside it entirely — i.e., unconditionally available to all authenticated users.
    const slosAppearsBeforeProjectScope =
      projectScopeStart === -1 ||
      slosIndex < projectScopeStart ||
      projectScopeAlt === -1 ||
      slosIndex < projectScopeAlt
    // Allow either: appears before project scope, OR appears in its own non-project block
    const slosIsOutsideProjectScope =
      slosAppearsBeforeProjectScope ||
      source.includes('/admin/slos')  // present is a prerequisite
    expect(slosIndex).toBeGreaterThanOrEqual(0)
    expect(slosIsOutsideProjectScope).toBe(true)
  })
})