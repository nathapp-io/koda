import { describe, test, expect, jest, beforeAll } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'memory.vue')
const composablePath = join(webDir, 'composables', 'useMemory.ts')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ─────────────────────────────────────────────────────────────────────────────
// File existence
// ─────────────────────────────────────────────────────────────────────────────

describe('US-Memory: pages/[project]/memory.vue exists', () => {
  test('file is present at pages/[project]/memory.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })

  test('useMemory composable is extracted at composables/useMemory.ts', () => {
    expect(existsSync(composablePath)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1/AC2 — Page pattern + composable delegation
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC1/AC2: page pattern + composable delegation', () => {
  test('source declares default layout via definePageMeta', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]default['"]/)
  })

  test('source delegates data access to useMemory', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useMemory')
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

  test('source triggers the initial fetch on mount (onMounted invokes the loadMemory wrapper)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const onMountedMatch = source.match(/\bonMounted\s*\([\s\S]{0,400}\)/)
    expect(onMountedMatch).not.toBeNull()
    const mountedBlock = onMountedMatch?.[0] ?? ''

    const triggersLoad =
      /\b(loadAndToast|loadMemory|withToastError\s*\(\s*loadMemory)/.test(mountedBlock)
    expect(triggersLoad).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — pending → loading indicator, hides the table
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC3: shows loading indicator when pending', () => {
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

  test('item table is hidden while pending (no row rendering until data ready)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasVFor = /v-for=.*in (items|memory|memories)/.test(source)
    const hasPendingGuard =
      /v-if=["']pending["']/.test(source) ||
      /v-if=["'][^"']*isLoading[^"']*["']/.test(source)
    expect(hasVFor && hasPendingGuard).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — empty response → empty-state message instead of the table
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC4: empty response shows empty-state message', () => {
  test('source renders an empty state when items.length === 0', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasEmptyGuard =
      source.includes('items.length === 0') ||
      source.includes('items.length===0') ||
      source.includes('!items.length') ||
      source.includes("t('memory.empty')") ||
      source.includes('t("memory.empty")')
    expect(hasEmptyGuard).toBe(true)
  })

  test('source uses an i18n key for the empty state', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/t\(['"]memory\.empty['"]\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — error path: extractApiError + toast.error in the page wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC5: page-level error wrapper uses extractApiError and toast', () => {
  test('source imports extractApiError', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/import\s*\{[^}]*extractApiError[^}]*\}/)
  })

  test('source calls toast.error with extractApiError', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/toast\.error\(\s*extractApiError\(/)
  })

  test('source wraps loadMemory/loadMore calls in a try/catch wrapper so errors reach toast', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const inlineTryCatch = /\btry\s*\{[\s\S]{0,400}\b(load|apply)[A-Z]?[\s\S]{0,400}\bcatch\b[\s\S]{0,400}extractApiError/.test(source)
    const hasWrapperCalledWith = /\bwithToast[A-Za-z]*\s*\(/.test(source)
      && /extractApiError/.test(source)
      && /loadMemory|loadMore|applyFilters/.test(source)
    const loadAndToastWired = /loadAndToast\b/.test(source) && /withToastError\s*\(\s*loadMemory\s*\)/.test(source)
    const applyAndToastWired = /applyAndToast\b/.test(source) && /withToastError\s*\(\s*applyFilters\s*\)/.test(source)
    const loadMoreAndToastWired = /loadMoreAndToast\b/.test(source) && /withToastError\s*\(\s*loadMore\s*\)/.test(source)
    expect(inlineTryCatch || (hasWrapperCalledWith && loadAndToastWired && applyAndToastWired && loadMoreAndToastWired)).toBe(true)
  })

  test('composable re-throws so the page wrapper receives the error', () => {
    const composableSource = readFileSync(composablePath, 'utf-8')
    // The composable's catch handler must re-throw the original error so the
    // page-level `withToastError` wrapper sees it. Match the catch block's
    // body with a generous window so additional state-recovery logic
    // (clearing items, restoring page) doesn't break the assertion.
    const rethrows = /catch\s*\([^)]*\)\s*\{[\s\S]*?throw\s+err[\s\S]*?\}/.test(composableSource)
    expect(rethrows).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6/AC7 — Filter UI: page drives kindFilter / statusFilter
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC6/AC7: filter UI re-invokes loadMemory', () => {
  test('source contains a kind select bound to the composable filter', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-model=["']kindFilter["']/)
  })

  test('source contains a status select bound to the composable filter', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-model=["']statusFilter["']/)
  })

  test('page re-invokes loadMemory when filters change', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const reInvokes =
      /@change=[\s\S]{0,40}(apply[A-Za-z]*|loadMemory)/.test(source)
    expect(reInvokes).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — pagination: load more button wired to loadMore
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC8: load more button wired to loadMore', () => {
  test('source has a load more button', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasLoadMore =
      source.includes('loadMore') ||
      source.includes('load more') ||
      source.includes('Load More') ||
      source.includes('memory.loadMore') ||
      source.includes("t('memory.loadMore')")
    expect(hasLoadMore).toBe(true)
  })

  test('load more button is only shown when hasMore is true', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-if=["']hasMore["']/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — Each row renders subject, predicate, object, kind, confidence, status
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC1: each row renders subject, predicate, object, kind, confidence, status', () => {
  test('the v-for body interpolates item.subject', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*item\.subject[^}]*\}\}/)
  })

  test('the v-for body interpolates item.predicate', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*item\.predicate[^}]*\}\}/)
  })

  test('the v-for body interpolates item.object', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*item\.object[^}]*\}\}/)
  })

  test('the v-for body interpolates item.kind', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*item\.kind[^}]*\}\}/)
  })

  test('the v-for body interpolates item.confidence', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*item\.confidence[^}]*\}\}/)
  })

  test('the v-for body interpolates item.status', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*item\.status[^}]*\}\}/)
  })

  test('all six field bindings are inside the v-for loop body', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const vForMatch = source.match(/v-for=["']item in items["']/)
    expect(vForMatch).not.toBeNull()
    const vForIdx = (vForMatch?.index ?? -1) as number
    const trStart = source.lastIndexOf('<tr', vForIdx)
    const trEnd = source.indexOf('</tr>', vForIdx)
    expect(trStart).toBeGreaterThan(-1)
    expect(trEnd).toBeGreaterThan(trStart)
    const rowBody = source.slice(trStart, trEnd)
    expect(rowBody).toMatch(/\{\{[^}]*item\.subject[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*item\.predicate[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*item\.object[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*item\.kind[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*item\.confidence[^}]*\}\}/)
    expect(rowBody).toMatch(/\{\{[^}]*item\.status[^}]*\}\}/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// i18n — navigation label and per-page strings present in BOTH locales
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory i18n: en.json has nav.memory and memory.* keys', () => {
  test('en.json parses without error', () => {
    const raw = readFileSync(enLocalePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('en.json has nav.memory', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.memory).toBeDefined()
    expect(typeof en.nav.memory).toBe('string')
    expect(en.nav.memory.length).toBeGreaterThan(0)
  })

  test('en.json has memory.empty', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.memory?.empty).toBeDefined()
    expect(typeof en.memory.empty).toBe('string')
  })

  test('en.json has memory.loadMore', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.memory?.loadMore).toBeDefined()
    expect(typeof en.memory.loadMore).toBe('string')
  })
})

describe('Memory i18n: zh.json has nav.memory and memory.* keys (parity)', () => {
  test('zh.json parses without error', () => {
    const raw = readFileSync(zhLocalePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('zh.json has nav.memory', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.memory).toBeDefined()
    expect(typeof zh.nav.memory).toBe('string')
    expect(zh.nav.memory.length).toBeGreaterThan(0)
  })

  test('zh.json has memory.empty', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.memory?.empty).toBeDefined()
    expect(typeof zh.memory.empty).toBe('string')
  })

  test('zh.json has memory.loadMore', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.memory?.loadMore).toBeDefined()
    expect(typeof zh.memory.loadMore).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — Layout navigation: project-nav link to /<slug>/memory
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC9: default layout includes a project-nav link targeting /<slug>/memory', () => {
  test('layouts/default.vue contains a NuxtLink targeting /<projectSlug>/memory', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The layout source contains a literal ${projectSlug}/memory string
    // within a template literal attribute. Match on the slash + memory
    // suffix which is unambiguous in this file.
    expect(source).toMatch(/\$\{projectSlug\}\/memory/)
  })

  test('the project-memory link label uses nav.memory i18n key', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The link must reference the nav.memory i18n key (in the same nav block).
    expect(source).toContain("t('nav.memory')")
  })

  test('the project-memory link uses NuxtLink', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The ${projectSlug}/memory path is inside a NuxtLink element
    const memoryLinkIdx = source.indexOf('${projectSlug}/memory')
    expect(memoryLinkIdx).toBeGreaterThan(-1)
    const precedingNuxtLink = source.lastIndexOf('NuxtLink', memoryLinkIdx)
    expect(precedingNuxtLink).toBeGreaterThan(-1)
    expect(precedingNuxtLink).toBeLessThan(memoryLinkIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// No console.log
// ─────────────────────────────────────────────────────────────────────────────

describe('Memory: pages/[project]/memory.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral SSR tests — mount the page component with stubbed composable
// and verify the rendered HTML matches expected output for each AC.
// ─────────────────────────────────────────────────────────────────────────────

const VueFull = require('vue/dist/vue.cjs.js')
const { renderToString } = require('vue/server-renderer')

function extractTemplateSfc(sfcSource: string): string {
  const m = sfcSource.match(/<template>([\s\S]*)<\/template>/)
  if (!m) throw new Error('No template found in SFC source')
  return m[1]
}

function stubDiv(tag: string): VueFull.Component {
  const { h } = VueFull
  return {
    name: `Stub${tag}`,
    render() {
      const slots = this.$slots.default?.()
      const attrs: Record<string, unknown> = {}
      for (const key of Object.keys(this.$attrs ?? {})) {
        const val = (this.$attrs as Record<string, unknown>)?.[key]
        if (val !== undefined) attrs[`data-${key}`] = val
      }
      return h('div', { ...attrs, class: 'stub' }, slots)
    },
  }
}

interface MemoryItem {
  id: string
  subject: string
  predicate: string
  object: string
  kind: string
  confidence: number
  status: string
}

function createRenderContext(overrides: Record<string, unknown> = {}) {
  const { ref } = VueFull

  const ctx = {
    t: (key: string) => key,
    toast: { error: jest.fn(), success: jest.fn() },

    items: ref<MemoryItem[]>([]),
    isLoading: ref(false),
    error: ref<unknown>(null),
    hasMore: ref(false),
    kindFilter: ref(''),
    statusFilter: ref(''),
    loadMemory: jest.fn(),
    applyFilters: jest.fn(),
    loadMore: jest.fn(),

    loadAndToast: jest.fn().mockResolvedValue(undefined),
    applyAndToast: jest.fn().mockResolvedValue(undefined),
    loadMoreAndToast: jest.fn().mockResolvedValue(undefined),

    formatConfidence: (v: number) => v.toFixed(2),
    KIND_OPTIONS: ['', 'FACT', 'INCIDENT_PATTERN', 'DECISION'],
    STATUS_OPTIONS: ['', 'active', 'superseded', 'rejected'],

    ...overrides,
  }

  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Memory AC1/AC3/AC4/AC5 (Behavioral SSR): page renders correctly with stubbed data', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('AC1: renders one <tr> per item showing subject, predicate, object, kind, confidence, status', async () => {
    const ctx = createRenderContext({
      items: VueFull.ref([
        { id: 'm1', subject: 'ticket:42', predicate: 'status', object: 'open', kind: 'FACT', confidence: 0.95, status: 'active' },
        { id: 'm2', subject: 'agent:7',  predicate: 'role',   object: 'developer', kind: 'FACT', confidence: 0.8, status: 'active' },
        { id: 'm3', subject: 'svc:db',   predicate: 'uses',  object: 'postgres', kind: 'INCIDENT_PATTERN', confidence: 0.6, status: 'superseded' },
      ]),
      isLoading: VueFull.ref(false),
      error: VueFull.ref(null),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*)<\/tbody>/)
    expect(tbodyMatch).not.toBeNull()
    const tbodyContent = tbodyMatch?.[1] ?? ''
    const rows = (tbodyContent.match(/<tr\b/g) || [])
    expect(rows).toHaveLength(3)

    // Subject / predicate / object fields rendered
    expect(html).toContain('ticket:42')
    expect(html).toContain('status')
    expect(html).toContain('open')
    expect(html).toContain('agent:7')
    expect(html).toContain('developer')
    expect(html).toContain('svc:db')
    expect(html).toContain('postgres')

    // Kind / confidence / status fields rendered
    expect(html).toContain('FACT')
    expect(html).toContain('INCIDENT_PATTERN')
    expect(html).toContain('0.95')
    expect(html).toContain('0.8')
    expect(html).toContain('active')
    expect(html).toContain('superseded')
  })

  test('AC3: shows loading indicator and does NOT render the items table when isLoading is true', async () => {
    const ctx = createRenderContext({
      isLoading: VueFull.ref(true),
      items: VueFull.ref([]),
      error: VueFull.ref(null),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: {
          name: 'MockLoadingState',
          render(this: { title: string }) { return VueFull.h('div', { class: 'loading-indicator' }, this.title || 'Loading...') },
        },
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    expect(html).toContain('loading-indicator')
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tbody')
    expect(html).not.toContain('<tr')
  })

  test('AC4: shows empty-state message instead of the table when items array is empty (and not loading, no error)', async () => {
    const ctx = createRenderContext({
      isLoading: VueFull.ref(false),
      items: VueFull.ref([]),
      error: VueFull.ref(null),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    expect(html).toContain('memory.empty')
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tbody')
    expect(html).not.toContain('<tr')
  })

  test('AC5: when error is set (non-null), the page renders no rows and no table', async () => {
    const ctx = createRenderContext({
      isLoading: VueFull.ref(false),
      items: VueFull.ref([]),
      error: VueFull.ref(new Error('Memory service unavailable')),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: {
          name: 'MockLoadingState',
          render(this: { title: string }) { return VueFull.h('div', { class: 'loading-indicator' }, this.title || 'Loading...') },
        },
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tbody')
    expect(html).not.toContain('<tr')
    expect(html).not.toContain('loading-indicator')
    // The error branch must render (not the empty-state copy), proving
    // the template checks `error` before `items.length === 0`.
    expect(html).toContain('memory.error')
  })
})

describe('Memory AC6/AC7 (Behavioral SSR): filter UI renders with correct bindings', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  function makeFilterApp(kind: string, status: string) {
    const ctx = createRenderContext({
      kindFilter: VueFull.ref(kind),
      statusFilter: VueFull.ref(status),
      isLoading: VueFull.ref(false),
      items: VueFull.ref([
        { id: 'm1', subject: 's', predicate: 'p', object: 'o', kind: 'FACT', confidence: 0.9, status: 'active' },
      ]),
      error: VueFull.ref(null),
    })

    return VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })
  }

  test('AC6: kind select renders with options including FACT and INCIDENT_PATTERN, selected value bound to kindFilter', async () => {
    const app = makeFilterApp('FACT', '')
    const html = await renderToString(app)

    expect(html).toContain('<option value="FACT" selected>')
    // When kindFilter is 'FACT', the FACT option must be marked selected
    // and INCIDENT_PATTERN (or other kinds) must NOT be selected.
    expect(html).not.toMatch(/<option value="INCIDENT_PATTERN" selected>/)
  })

  test('AC6: re-rendering with a different kindFilter shows the new value as selected', async () => {
    const app = makeFilterApp('INCIDENT_PATTERN', '')
    const html = await renderToString(app)

    expect(html).toContain('<option value="INCIDENT_PATTERN" selected>')
    expect(html).not.toContain('<option value="FACT" selected>')
  })

  test('AC7: status select renders with selected value bound to statusFilter', async () => {
    const app = makeFilterApp('', 'active')
    const html = await renderToString(app)

    expect(html).toContain('<option value="active" selected>')
  })

  test('AC7: re-rendering with a different statusFilter shows the new value as selected', async () => {
    const app = makeFilterApp('', 'superseded')
    const html = await renderToString(app)

    expect(html).toContain('<option value="superseded" selected>')
    expect(html).not.toMatch(/<option value="active" selected>/)
  })
})
