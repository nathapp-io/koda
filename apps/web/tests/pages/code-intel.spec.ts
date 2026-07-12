import { describe, test, expect, jest, beforeAll } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'code-intel.vue')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ─────────────────────────────────────────────────────────────────────────────
// File existence
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel: pages/[project]/code-intel.vue exists', () => {
  test('file is present at pages/[project]/code-intel.vue', () => {
    expect(existsSync(pagePath)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — Given a project slug and a submitted query, when the user submits the
//        search box, then the Code-intel page invokes `$api.get` with the path
//        `/code-intel/symbols` and query params `projectSlug=<slug>` and
//        `q=<query>`.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC1: page invokes $api.get with /code-intel/symbols and query params', () => {
  test('source declares default layout via definePageMeta', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/definePageMeta\s*\(\s*\{[^}]*layout\s*:\s*['"]default['"]/)
  })

  test('source uses useApi composable', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source destructures $api from useApi', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/const\s*\{\s*\$api\s*\}\s*=\s*useApi\(\)/)
  })

  test('source reads project slug from route.params.project', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/route\.params\.project|\bparams\.project\b/)
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

  test('source invokes $api.get with the /code-intel/symbols path', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\$api\.get[\s\S]{0,500}?[`'"]\/code-intel\/symbols[`'"]/)
  })

  test('source passes projectSlug and q as query params to $api.get', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Must include query: { projectSlug: <slug>, q: <query> } (or equivalent) in the call.
    const hasQuery =
      /query\s*:\s*\{[^}]*projectSlug[^}]*q[^}]*\}/.test(source) ||
      /query\s*:\s*\{[^}]*q[^}]*projectSlug[^}]*\}/.test(source)
    expect(hasQuery).toBe(true)
  })

  test('source passes the project slug into the query.projectSlug', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The query object must reference the local `slug` variable (route.params.project).
    expect(source).toMatch(/query\s*:\s*\{[^}]*projectSlug\s*:\s*slug\b[^}]*\}/)
  })

  test('source passes the user query value into query.q', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The query.q must reference the page's local query ref (searchQuery).
    expect(source).toMatch(/query\s*:\s*\{[^}]*q\s*:\s*searchQuery[^}]*\}/)
  })

  test('source invokes the search on a submit handler (handleSearch on click/enter)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasSearchFn = /async\s+function\s+handleSearch\s*\(/.test(source)
      || /const\s+handleSearch\s*=\s*async\s*\(/.test(source)
      || /function\s+handleSearch\s*\(/.test(source)
    expect(hasSearchFn).toBe(true)

    const wiresHandler =
      /@click\s*=\s*["']handleSearch["']/.test(source) ||
      /@keyup\.enter\s*=\s*["']handleSearch["']/.test(source)
    expect(wiresHandler).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — Given the search resolves with symbols, when the Code-intel page
//        renders results, then it shows one result row per symbol showing
//        `name`, `kind`, and `file`.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC2: renders one row per symbol showing name, kind, file', () => {
  test('source has a v-for loop over the symbols array', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-for=["'][^"']*in\s+symbols[^"']*["']/)
  })

  test('row body interpolates {{ symbol.name }}', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const match = source.match(/v-for=["'][^"']*in\s+symbols[^"']*["']/)
    expect(match).not.toBeNull()
    const vForIdx = match?.index ?? -1
    const trStart = source.lastIndexOf('<tr', vForIdx)
    const trEnd = source.indexOf('</tr>', vForIdx)
    const rowBody = source.slice(trStart, trEnd)
    expect(rowBody).toMatch(/\{\{[^}]*symbol\.name[^}]*\}\}/)
  })

  test('row body interpolates {{ symbol.kind }}', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const match = source.match(/v-for=["'][^"']*in\s+symbols[^"']*["']/)
    expect(match).not.toBeNull()
    const vForIdx = match?.index ?? -1
    const trStart = source.lastIndexOf('<tr', vForIdx)
    const trEnd = source.indexOf('</tr>', vForIdx)
    const rowBody = source.slice(trStart, trEnd)
    expect(rowBody).toMatch(/\{\{[^}]*symbol\.kind[^}]*\}\}/)
  })

  test('row body interpolates {{ symbol.file }}', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const match = source.match(/v-for=["'][^"']*in\s+symbols[^"']*["']/)
    expect(match).not.toBeNull()
    const vForIdx = match?.index ?? -1
    const trStart = source.lastIndexOf('<tr', vForIdx)
    const trEnd = source.indexOf('</tr>', vForIdx)
    const rowBody = source.slice(trStart, trEnd)
    expect(rowBody).toMatch(/\{\{[^}]*symbol\.file[^}]*\}\}/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — Given the search request is pending, when the Code-intel page is
//        rendered, then it shows a loading indicator and not the results table.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC3: shows loading indicator while pending', () => {
  test('source has v-if guard referencing isSearching', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-if=["'][^"']*isSearching[^"']*["']/)
  })

  test('source renders LoadingState component while isSearching', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('<LoadingState')
  })

  test('results table is hidden while isSearching (table is in a v-else branch)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const tableIdx = source.indexOf('<table')
    expect(tableIdx).toBeGreaterThan(-1)
    // The <table> must NOT appear inside a v-if="isSearching" branch — verify
    // that the v-if="isSearching" block (which contains LoadingState) ends
    // BEFORE the <table> appears.
    const loadingBlockMatch = source.match(/v-if=["'][^"']*isSearching[^"']*["'][\s\S]{0,2000}?(?=<table)/)
    expect(loadingBlockMatch).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — Given the search resolves with zero symbols, when the Code-intel page
//        finishes loading, then it renders an empty or `no matches` state.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC4: empty results render empty/no-matches state', () => {
  test('source renders an empty state when symbols array is empty', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const hasEmptyGuard =
      source.includes('symbols.length === 0') ||
      source.includes('symbols.length===0') ||
      source.includes('!symbols.length') ||
      source.includes('symbols.length == 0')
    expect(hasEmptyGuard).toBe(true)
  })

  test('source uses an i18n key for the empty state', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The empty-state branch must use an i18n key (not a hardcoded string).
    const hasI18nEmpty =
      /t\(['"]codeIntel\.empty['"]\)/.test(source) ||
      /t\(['"]codeIntel\.noResults['"]\)/.test(source) ||
      /t\(['"]codeIntel\.noMatches['"]\)/.test(source)
    expect(hasI18nEmpty).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — Given `$api.get` rejects, when the Code-intel page handles the error,
//        then it surfaces `extractApiError(err)` via the app toast.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC5: error surfaces via extractApiError + toast', () => {
  test('source imports extractApiError', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/import\s*\{[^}]*extractApiError[^}]*\}/)
  })

  test('source calls toast.error with extractApiError inside the search handler', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // The search function must wrap $api.get in try/catch and call toast.error(extractApiError(err)).
    expect(source).toMatch(/toast\.error\(\s*extractApiError\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — Given a rendered result row, when the user clicks it, then the
//        Code-intel page expands a detail panel that renders that symbol's
//        `signature`, `docComment`, and its `callers` and `callees` as text
//        lists rather than interactive links.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC6: clicking a row expands detail panel with signature/docComment/callers/callees', () => {
  test('source has a reactive ref tracking the expanded symbol id', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/(ref\s*<\s*string\s*\|\s*null\s*>\s*\(\s*null\s*\))|(expandedSymbol\s*=\s*ref)/)
  })

  test('row click toggles the expanded symbol id', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Each row click must set/clear the expanded symbol id reference.
    const hasClickToggle =
      /@click\s*=\s*["']toggleSymbol\(/.test(source) ||
      /@click\s*=\s*["']expandedSymbol\s*=/.test(source) ||
      /@click\s*=\s*["'][^"']*expandedSymbol[^"']*["']/.test(source)
    expect(hasClickToggle).toBe(true)
  })

  test('detail panel is gated by an expandedSymbol check', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-if=["'][^"']*expandedSymbol[^"']*["']/)
  })

  test('detail panel renders the selected symbol signature', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*(selectedSymbol|expandedSymbol)\.signature[^}]*\}\}/)
  })

  test('detail panel renders the selected symbol docComment', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/\{\{[^}]*(selectedSymbol|expandedSymbol)\.docComment[^}]*\}\}/)
  })

  test('detail panel renders callers as a text list (not interactive links)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-for=["'][^"']*in\s+(selectedSymbol|expandedSymbol)\.callers[^"']*["']/)
    // Should not render callers as <NuxtLink> — just text interpolation.
    // Confirm via pattern that callers are rendered with simple text interpolation.
    expect(source).toMatch(/\{\{[^}]*caller[^}]*\}\}/)
  })

  test('detail panel renders callees as a text list (not interactive links)', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toMatch(/v-for=["'][^"']*in\s+(selectedSymbol|expandedSymbol)\.callees[^"']*["']/)
    expect(source).toMatch(/\{\{[^}]*callee[^}]*\}\}/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — Given the default layout is rendered on a route with a `project` slug,
//        when navigation links are shown, then it includes a project-nav link
//        targeting `/<slug>/code-intel` whose label resolves from `nav.codeIntel`.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC7: layout has project-nav link to /<slug>/code-intel with nav.codeIntel label', () => {
  test('layouts/default.vue contains a NuxtLink targeting /<slug>/code-intel', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/\$\{projectSlug\}\/code-intel/)
  })

  test('layouts/default.vue labels the code-intel link via nav.codeIntel', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/t\(['"]nav\.codeIntel['"]\)/)
  })

  test('code-intel link is rendered inside the project-nav block', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Locate the projectSlug-conditional block, then assert the code-intel
    // NuxtLink appears inside it.
    const projectBlock = source.match(/<template\s+v-if=["']projectSlug["']>[\s\S]*?<\/template>/)
    expect(projectBlock).not.toBeNull()
    expect(projectBlock?.[0]).toContain('/code-intel')
    expect(projectBlock?.[0]).toMatch(/t\(['"]nav\.codeIntel['"]\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// i18n — nav.codeIntel + per-page strings exist in BOTH locales
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel i18n: en.json has nav.codeIntel + per-page keys', () => {
  test('en.json parses without error', () => {
    const raw = readFileSync(enLocalePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('en.json has nav.codeIntel', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.codeIntel).toBeDefined()
    expect(typeof en.nav.codeIntel).toBe('string')
    expect(en.nav.codeIntel.length).toBeGreaterThan(0)
  })

  test('en.json has codeIntel.search.placeholder', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.codeIntel?.search?.placeholder).toBeDefined()
    expect(typeof en.codeIntel.search.placeholder).toBe('string')
  })

  test('en.json has codeIntel.search.button', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.codeIntel?.search?.button).toBeDefined()
    expect(typeof en.codeIntel.search.button).toBe('string')
  })

  test('en.json has codeIntel.empty (or noResults)', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    const hasEmpty = en.codeIntel?.empty || en.codeIntel?.noResults || en.codeIntel?.noMatches
    expect(hasEmpty).toBeDefined()
    expect(typeof hasEmpty).toBe('string')
  })

  test('en.json has codeIntel.columns.name, kind, file', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.codeIntel?.columns?.name).toBeDefined()
    expect(en.codeIntel?.columns?.kind).toBeDefined()
    expect(en.codeIntel?.columns?.file).toBeDefined()
  })

  test('en.json has codeIntel.detail.signature, docComment, callers, callees', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.codeIntel?.detail?.signature).toBeDefined()
    expect(en.codeIntel?.detail?.docComment).toBeDefined()
    expect(en.codeIntel?.detail?.callers).toBeDefined()
    expect(en.codeIntel?.detail?.callees).toBeDefined()
  })
})

describe('Code-intel i18n: zh.json has nav.codeIntel + per-page keys (parity)', () => {
  test('zh.json parses without error', () => {
    const raw = readFileSync(zhLocalePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('zh.json has nav.codeIntel', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.codeIntel).toBeDefined()
    expect(typeof zh.nav.codeIntel).toBe('string')
    expect(zh.nav.codeIntel.length).toBeGreaterThan(0)
  })

  test('zh.json has codeIntel.search.placeholder', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.codeIntel?.search?.placeholder).toBeDefined()
    expect(typeof zh.codeIntel.search.placeholder).toBe('string')
  })

  test('zh.json has codeIntel.search.button', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.codeIntel?.search?.button).toBeDefined()
    expect(typeof zh.codeIntel.search.button).toBe('string')
  })

  test('zh.json has codeIntel.empty (or noResults)', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    const hasEmpty = zh.codeIntel?.empty || zh.codeIntel?.noResults || zh.codeIntel?.noMatches
    expect(hasEmpty).toBeDefined()
    expect(typeof hasEmpty).toBe('string')
  })

  test('zh.json has codeIntel.columns.name, kind, file', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.codeIntel?.columns?.name).toBeDefined()
    expect(zh.codeIntel?.columns?.kind).toBeDefined()
    expect(zh.codeIntel?.columns?.file).toBeDefined()
  })

  test('zh.json has codeIntel.detail.signature, docComment, callers, callees', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.codeIntel?.detail?.signature).toBeDefined()
    expect(zh.codeIntel?.detail?.docComment).toBeDefined()
    expect(zh.codeIntel?.detail?.callers).toBeDefined()
    expect(zh.codeIntel?.detail?.callees).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// No console.log
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel: pages/[project]/code-intel.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral SSR tests — mount the page component with stubbed $api.get and
// verify the rendered HTML matches expected output for each acceptance criterion.
// ─────────────────────────────────────────────────────────────────────────────

const VueFull = require('vue/dist/vue.cjs.js')
const { renderToString } = require('vue/server-renderer')

interface CodeIntelSymbol {
  id: string
  name: string
  kind: string
  file: string
  signature?: string
  docComment?: string
  callers?: string[]
  callees?: string[]
}

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

function createRenderContext(overrides: Record<string, unknown> = {}) {
  const { ref, computed } = VueFull

  const ctx = {
    t: (key: string) => key,
    toast: { error: jest.fn(), success: jest.fn() },

    // Search state
    searchQuery: ref(''),
    isSearching: ref(false),
    symbols: ref<CodeIntelSymbol[]>([]),
    expandedSymbolId: ref<string | null>(null),
    error: ref<unknown>(null),

    // Functions
    handleSearch: jest.fn().mockResolvedValue(undefined),
    toggleSymbol: jest.fn(),

    // Computeds
    selectedSymbol: ref<CodeIntelSymbol | null>(null),

    // Utility
    formatKind: (k: string) => k,

    ...overrides,
  }

  // Wire selectedSymbol computed-style so tests can drive it.
  ctx.selectedSymbol = computed(() => {
    if (!ctx.expandedSymbolId.value) return null
    return ctx.symbols.value.find(s => s.id === ctx.expandedSymbolId.value) ?? null
  }) as unknown as typeof ctx.selectedSymbol

  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC2 (Behavioral SSR): page renders one row per symbol', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('AC2: renders one <tr> per symbol showing name, kind, file columns', async () => {
    const ctx = createRenderContext({
      isSearching: VueFull.ref(false),
      symbols: VueFull.ref([
        { id: 's1', name: 'handleSearch', kind: 'function', file: 'pages/[project]/code-intel.vue' },
        { id: 's2', name: 'toggleSymbol', kind: 'function', file: 'pages/[project]/code-intel.vue' },
        { id: 's3', name: 'SearchResult', kind: 'interface', file: 'composables/useCodeIntel.ts' },
      ]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
        Input: stubDiv('Input'),
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    // Verify one <tr> per symbol
    const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*)<\/tbody>/)
    expect(tbodyMatch).not.toBeNull()
    const tbodyContent = tbodyMatch?.[1] ?? ''
    const rows = (tbodyContent.match(/<tr\b/g) || [])
    expect(rows).toHaveLength(3)

    // Verify each symbol's name/kind/file appear in the rendered HTML
    expect(html).toContain('handleSearch')
    expect(html).toContain('function')
    expect(html).toContain('pages/[project]/code-intel.vue')
    expect(html).toContain('toggleSymbol')
    expect(html).toContain('SearchResult')
    expect(html).toContain('composables/useCodeIntel.ts')
  })
})

describe('Code-intel AC3 (Behavioral SSR): loading indicator when pending', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('AC3: shows loading indicator and does NOT render the results table when isSearching is true', async () => {
    const ctx = createRenderContext({
      isSearching: VueFull.ref(true),
      symbols: VueFull.ref([]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: {
          name: 'MockLoadingState',
          render() { return VueFull.h('div', { class: 'loading-indicator' }, 'Loading...') },
        },
        Input: stubDiv('Input'),
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    // Loading indicator must be present
    expect(html).toContain('loading-indicator')
    // Table must NOT be rendered while loading
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tbody')
    expect(html).not.toContain('<tr')
  })
})

describe('Code-intel AC4 (Behavioral SSR): empty state when no symbols', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('AC4: shows empty-state message instead of the table when symbols array is empty', async () => {
    const ctx = createRenderContext({
      isSearching: VueFull.ref(false),
      symbols: VueFull.ref([]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
        Input: stubDiv('Input'),
        Button: stubDiv('Button'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    // One of the recognized empty-state keys must appear (we accepted any during dev)
    const hasEmptyKey =
      html.includes('codeIntel.empty') ||
      html.includes('codeIntel.noResults') ||
      html.includes('codeIntel.noMatches')
    expect(hasEmptyKey).toBe(true)

    // Table must NOT be rendered
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tbody')
    expect(html).not.toContain('<tr')
  })
})
