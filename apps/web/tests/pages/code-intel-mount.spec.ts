import { describe, test, expect, jest } from '@jest/globals'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import vm from 'vm'

// ─────────────────────────────────────────────────────────────────────────────
// Resolve Bun-hoisted dev-tooling packages (e.g. @vue/compiler-sfc, esbuild)
// by walking up from __dirname to find a node_modules/.bun/<encoded-name>@*
// directory. This avoids hardcoded absolute machine paths and the
// version+content-hash suffix in Bun's hoisted layout.
function resolveBunPackage(pkgName: string): string {
  let dir: string = __dirname
  // Bun encodes scoped package names by replacing '/' with '+' in the
  // .bun folder name (e.g. "@vue/compiler-sfc" → "@vue+compiler-sfc").
  const bunName = pkgName.startsWith('@') ? pkgName.replace('/', '+') : pkgName
  // Walk up the directory tree until we either find the package or hit
  // the filesystem root. dir === join(dir, '..') at the root is the
  // termination condition (no parent directory exists).
  for (let i = 0; i < 100; i++) {
    const bunRoot = join(dir, 'node_modules', '.bun')
    if (existsSync(bunRoot) && statSync(bunRoot).isDirectory()) {
      const entries = (require('fs') as typeof import('fs')).readdirSync(bunRoot)
      const matches = entries
        .filter(e => e.startsWith(`${bunName}@`))
        .sort()
        .reverse()
      for (const entry of matches) {
        const inner = join(bunRoot, entry, 'node_modules', pkgName)
        if (existsSync(inner)) return inner
      }
    }
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not locate ${pkgName} in any node_modules/.bun/ from ${__dirname}`)
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sfc = require(resolveBunPackage('@vue/compiler-sfc'))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esbuild = require(resolveBunPackage('esbuild'))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Vue = require(resolveBunPackage('vue'))

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'code-intel.vue')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — compile the real SFC and mount it with stubbed globals.
// ─────────────────────────────────────────────────────────────────────────────

async function buildPageBundle(): Promise<string> {
  const source = readFileSync(pagePath, 'utf-8')
  const { descriptor } = sfc.parse(source)
  const scriptResult = sfc.compileScript(descriptor, { id: pagePath })

  const code = scriptResult.content
    .replace(/~\/composables\/useApi/g, join(webDir, 'composables/useApi'))
    .replace(
      'return __returned__',
      'globalThis.__CI_SETUP_STATE__ = __returned__;\n    return __returned__',
    )

  const result = await esbuild.build({
    stdin: { contents: code, resolveDir: webDir, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vue', 'lucide-vue-next'],
  })
  return result.outputFiles[0].text
}

interface MountOptions {
  slug: string
  fetchMock: jest.Mock
}

async function mountCodeIntelPage(opts: MountOptions) {
  const { slug, fetchMock } = opts
  const fetchCalls: Array<{ url: string; opts?: Record<string, unknown> }> = []
  const wrappedFetchMock = jest.fn(async (url: string, fetchOpts?: Record<string, unknown>) => {
    fetchCalls.push({ url, opts: fetchOpts })
    return await fetchMock(url, fetchOpts)
  })

  const toastInstance = { success: jest.fn(), error: jest.fn() }

  const pageBundle = await buildPageBundle()

  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    require,
    __dirname: webDir,
    __filename: pagePath,
    console,
    process,
    Buffer,
    setTimeout, clearTimeout,

    // Vue auto-imports (Nuxt normally provides these globally).
    ref: Vue.ref,
    computed: Vue.computed,

    useRoute: () => ({ params: { project: slug }, path: `/${slug}/code-intel` }),
    useI18n: () => ({ t: (k: string) => k, locale: { value: 'en' } }),
    useAppToast: () => toastInstance,
    definePageMeta: () => {},
    onMounted: (_fn: () => unknown) => {},
    useApi: () => ({
      $api: {
        get: async (url: string, fetchOpts?: Record<string, unknown>) => {
          const envelope = await wrappedFetchMock(url, fetchOpts)
          return envelope?.data ?? envelope
        },
      },
    }),
  }
  sandbox.globalThis = sandbox

  vm.createContext(sandbox as vm.Context)
  sandbox.module = { exports: {} }
  vm.runInContext(pageBundle, sandbox as vm.Context)

  const Comp = (sandbox.module as { exports: { default?: { setup?: (...args: unknown[]) => unknown } } }).exports.default
  const setupFn = Comp?.setup
  if (typeof setupFn !== 'function') {
    throw new Error('compiled page has no setup function')
  }

  const bindings = setupFn.call(null, {}, { expose: () => {}, attrs: {}, slots: {}, emit: () => {} }) as Record<string, unknown>

  return { bindings, fetchCalls, toast: toastInstance }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — Submitting the search box triggers $api.get('/code-intel/symbols')
//        with query.projectSlug=<slug> and query.q=<query>.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC1 (Behavioral SFC mount): handleSearch calls $api.get with the right path and query', () => {
  test('invoking handleSearch("foo") triggers $api.get("/code-intel/symbols") with projectSlug=acme and q=foo', async () => {
    const fetchMock = jest.fn(async () => ({ data: { items: [], total: 0 } }))

    const { fetchCalls, bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })

    // No fetch on mount (the page is read-only and user-driven).
    expect(fetchCalls).toHaveLength(0)

    const handleSearch = bindings.handleSearch as () => Promise<void>
    expect(typeof handleSearch).toBe('function')

    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'foo'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toBe('/code-intel/symbols')
    const query = (call.opts?.query ?? {}) as Record<string, string>
    expect(query.projectSlug).toBe('acme')
    expect(query.q).toBe('foo')
  })

  test('a second submit with a different query sends the new q value while keeping the same slug', async () => {
    const fetchMock = jest.fn(async () => ({ data: { items: [], total: 0 } }))

    const { fetchCalls, bindings } = await mountCodeIntelPage({ slug: 'proj-1', fetchMock })
    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }

    searchQuery.value = 'alpha'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 10))

    searchQuery.value = 'beta'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0].url).toBe('/code-intel/symbols')
    expect(fetchCalls[1].url).toBe('/code-intel/symbols')
    const q0 = (fetchCalls[0].opts?.query ?? {}) as Record<string, string>
    const q1 = (fetchCalls[1].opts?.query ?? {}) as Record<string, string>
    expect(q0.projectSlug).toBe('proj-1')
    expect(q0.q).toBe('alpha')
    expect(q1.projectSlug).toBe('proj-1')
    expect(q1.q).toBe('beta')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — Search response populates symbols so the page can render one row per
//        symbol with name, kind, and file (handled by the SSR tests in
//        code-intel.spec.ts; the behavioral aspect here is that the response
//        items are mapped into the symbols ref).
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC2 (Behavioral SFC mount): response items populate the symbols ref', () => {
  test('response.items is assigned to bindings.symbols after a successful search', async () => {
    const items = [
      { id: 's1', name: 'handleSearch', kind: 'function', file: 'pages/[project]/code-intel.vue' },
      { id: 's2', name: 'toggleSymbol', kind: 'function', file: 'pages/[project]/code-intel.vue' },
    ]
    const fetchMock = jest.fn(async () => ({ data: { items, total: 2 } }))

    const { bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })
    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'any'

    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    const symbols = bindings.symbols as { value: Array<{ id: string; name: string; kind: string; file: string }> }
    expect(symbols.value).toHaveLength(2)
    expect(symbols.value[0]).toEqual(items[0])
    expect(symbols.value[1]).toEqual(items[1])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — When $api.get rejects, toast.error(extractApiError(err)) is called.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC5 (Behavioral SFC mount): $api.get rejection surfaces extractApiError via toast', () => {
  test('when the search fetch rejects, toast.error is called with the extracted error message', async () => {
    const apiError = Object.assign(new Error('boom'), {
      data: { ret: 1, message: 'Symbol service unavailable' },
    })
    const fetchMock = jest.fn(() => Promise.reject(apiError))

    const { toast, fetchCalls, bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })
    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'foo'

    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('/code-intel/symbols')

    expect(toast.error).toHaveBeenCalledTimes(1)
    const calledWith = (toast.error as jest.Mock).mock.calls[0][0]
    expect(calledWith).toBe('Symbol service unavailable')
  })

  test('on rejection, the symbols ref is reset to empty (no rows rendered)', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('fail')))

    const { bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })
    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'foo'

    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 30))

    const symbols = bindings.symbols as { value: unknown[] }
    expect(symbols.value).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — toggleSymbol rejection path: when detail/callers/callees fetch
//        rejects, toast.error(extractApiError(err)) is called and detail
//        state is reset.
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC5 (Behavioral SFC mount): toggleSymbol rejection surfaces extractApiError via toast', () => {
  test('when the detail fetch rejects, toast.error is called and expandedSymbolId is reset', async () => {
    const searchItem = { id: 's1', name: 'handleSearch', kind: 'function', file: 'pages/code-intel.vue', signature: 'async function handleSearch(): Promise<void>' }
    const fetchMock = jest.fn(async (url: string) => {
      if (url === '/code-intel/symbols') return { data: { items: [searchItem], total: 1 } }
      throw new Error('detail fetch failed')
    })

    const { toast, bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })

    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'handleSearch'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    const toggleSymbol = bindings.toggleSymbol as (id: string) => Promise<void>
    await toggleSymbol('s1')
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(toast.error).toHaveBeenCalled()
    const calledWith = (toast.error as jest.Mock).mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].length > 0,
    )
    expect(calledWith).toBeDefined()

    const expandedSymbolId = bindings.expandedSymbolId as { value: string | null }
    expect(expandedSymbolId.value).toBeNull()
    const detailState = bindings.detailState as { value: unknown }
    expect(detailState.value).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — Clicking a result row fetches the symbol detail, callers, and callees
//        from the existing detail endpoints, then renders them as plain text.
//        The search response itself is intentionally lightweight and does NOT
//        include docComment/callers/callees — those come from the detail
//        endpoints (`/symbols/:id`, `/symbols/:id/callers`, `/symbols/:id/callees`).
// ─────────────────────────────────────────────────────────────────────────────

describe('Code-intel AC6 (Behavioral SFC mount): toggleSymbol fetches detail + callers + callees', () => {
  // The /code-intel/symbols search contract returns ONLY id, name, kind, file,
  // signature. The detail panel's docComment/callers/callees come from
  // separate endpoints that toggleSymbol must invoke.
  const searchItem = {
    id: 's1',
    name: 'handleSearch',
    kind: 'function',
    file: 'pages/[project]/code-intel.vue',
    signature: 'async function handleSearch(): Promise<void>',
  }
  const detailResponse = {
    id: 's1',
    name: 'handleSearch',
    kind: 'function',
    file: 'pages/[project]/code-intel.vue',
    signature: 'async function handleSearch(): Promise<void>',
    docComment: 'Runs the symbol search.',
  }
  const callersResponse = [
    { id: 'caller-1', name: 'onSearchSubmit', file: 'pages/[project]/code-intel.vue' },
  ]
  const calleesResponse = [
    { id: 'callee-1', name: '$api.get', file: 'composables/useApi.ts' },
  ]

  function makeFetchMock() {
    return jest.fn(async (url: string) => {
      if (url === '/code-intel/symbols') {
        return { data: { items: [searchItem], total: 1 } }
      }
      if (url === '/code-intel/symbols/s1') {
        return { data: detailResponse }
      }
      if (url === '/code-intel/symbols/s1/callers') {
        return { data: callersResponse }
      }
      if (url === '/code-intel/symbols/s1/callees') {
        return { data: calleesResponse }
      }
      throw new Error(`Unexpected URL in test: ${url}`)
    })
  }

  test('toggleSymbol fetches /symbols/:id, /symbols/:id/callers, /symbols/:id/callees (not the search payload)', async () => {
    const fetchMock = makeFetchMock()
    const { fetchCalls, bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })

    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'handleSearch'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    // Search fired — exactly one /code-intel/symbols call so far.
    const searchCalls = fetchCalls.filter(c => c.url === '/code-intel/symbols')
    expect(searchCalls.length).toBe(1)

    // Now click the row to expand.
    const toggleSymbol = bindings.toggleSymbol as (id: string) => Promise<void>
    await toggleSymbol('s1')
    await new Promise(resolve => setTimeout(resolve, 30))

    // toggleSymbol must have invoked the three detail endpoints with
    // projectSlug=acme.
    const detailCalls = fetchCalls.filter(c => c.url === '/code-intel/symbols/s1')
    const callerCalls = fetchCalls.filter(c => c.url === '/code-intel/symbols/s1/callers')
    const calleeCalls = fetchCalls.filter(c => c.url === '/code-intel/symbols/s1/callees')
    expect(detailCalls.length).toBe(1)
    expect(callerCalls.length).toBe(1)
    expect(calleeCalls.length).toBe(1)

    for (const call of [...detailCalls, ...callerCalls, ...calleeCalls]) {
      const query = (call.opts?.query ?? {}) as Record<string, string>
      expect(query.projectSlug).toBe('acme')
    }
  })

  test('expandedSymbol, expandedCallers, and expandedCallees populate from the detail endpoints (not from search items)', async () => {
    const fetchMock = makeFetchMock()
    const { bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })

    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'handleSearch'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    // Before clicking the row, no detail state is populated.
    const expandedSymbolBefore = bindings.expandedSymbol as { value: unknown }
    expect(expandedSymbolBefore.value).toBeNull()

    // Click the row.
    const toggleSymbol = bindings.toggleSymbol as (id: string) => Promise<void>
    await toggleSymbol('s1')
    await new Promise(resolve => setTimeout(resolve, 30))

    // expandedSymbol is populated from the /symbols/:id endpoint and
    // includes docComment — which the search payload does NOT provide.
    const expandedSymbol = bindings.expandedSymbol as { value: { id: string; signature: string; docComment: string } | null }
    expect(expandedSymbol.value).not.toBeNull()
    expect(expandedSymbol.value?.id).toBe('s1')
    expect(expandedSymbol.value?.signature).toBe('async function handleSearch(): Promise<void>')
    expect(expandedSymbol.value?.docComment).toBe('Runs the symbol search.')

    // expandedCallers comes from the /symbols/:id/callers endpoint.
    const expandedCallers = bindings.expandedCallers as { value: Array<{ id: string; name: string }> }
    expect(expandedCallers.value).toEqual(callersResponse)
    expect(expandedCallers.value[0].name).toBe('onSearchSubmit')

    // expandedCallees comes from the /symbols/:id/callees endpoint.
    const expandedCallees = bindings.expandedCallees as { value: Array<{ id: string; name: string }> }
    expect(expandedCallees.value).toEqual(calleesResponse)
    expect(expandedCallees.value[0].name).toBe('$api.get')
  })

  test('calling toggleSymbol on the same id again clears the detail state (no second fetch)', async () => {
    const fetchMock = makeFetchMock()
    const { fetchCalls, bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })

    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'handleSearch'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    const toggleSymbol = bindings.toggleSymbol as (id: string) => Promise<void>
    await toggleSymbol('s1')
    await new Promise(resolve => setTimeout(resolve, 30))

    const detailCallsBefore = fetchCalls.filter(c => c.url === '/code-intel/symbols/s1').length
    expect(detailCallsBefore).toBe(1)

    // Click the same row again — should clear without a second fetch.
    await toggleSymbol('s1')
    await new Promise(resolve => setTimeout(resolve, 10))

    const detailCallsAfter = fetchCalls.filter(c => c.url === '/code-intel/symbols/s1').length
    expect(detailCallsAfter).toBe(1)

    const expandedSymbolId = bindings.expandedSymbolId as { value: string | null }
    expect(expandedSymbolId.value).toBeNull()
    const expandedSymbol = bindings.expandedSymbol as { value: unknown }
    expect(expandedSymbol.value).toBeNull()
  })

  test('search payload carries NO docComment/callers/callees (contract sanity)', async () => {
    const fetchMock = makeFetchMock()
    const { bindings } = await mountCodeIntelPage({ slug: 'acme', fetchMock })

    const handleSearch = bindings.handleSearch as () => Promise<void>
    const searchQuery = bindings.searchQuery as { value: string }
    searchQuery.value = 'handleSearch'
    await handleSearch()
    await new Promise(resolve => setTimeout(resolve, 20))

    const symbols = bindings.symbols as { value: Array<Record<string, unknown>> }
    expect(symbols.value).toHaveLength(1)
    // The page must NOT rely on these fields from search — assert they are
    // absent so the contract mismatch is visible in the test if the API
    // ever changes.
    expect(symbols.value[0]).not.toHaveProperty('docComment')
    expect(symbols.value[0]).not.toHaveProperty('callers')
    expect(symbols.value[0]).not.toHaveProperty('callees')
  })
})
