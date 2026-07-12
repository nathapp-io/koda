import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import vm from 'vm'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sfc = require('/Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda/node_modules/.bun/@vue+compiler-sfc@3.5.39/node_modules/@vue/compiler-sfc')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const esbuild = require('/Users/williamkhoo/workspace/subrina-coder/projects/koda/repos/koda/node_modules/.bun/esbuild@0.25.12/node_modules/esbuild')

const webDir = join(__dirname, '../..')
const pagePath = join(webDir, 'pages', '[project]', 'memory.vue')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — compile the real SFC and mount it with stubbed globals.
// ─────────────────────────────────────────────────────────────────────────────

async function buildPageBundle(): Promise<string> {
  const source = readFileSync(pagePath, 'utf-8')
  const { descriptor } = sfc.parse(source)
  // Compile WITHOUT inlineTemplate so setup() returns the bindings object
  // (instead of a render function). We need direct access to items / loadMore
  // / etc. to drive the load-more interaction.
  const scriptResult = sfc.compileScript(descriptor, { id: pagePath })

  // Path aliases + Nuxt auto-imports: substitute to make the bundle self-contained.
  const code = scriptResult.content
    .replace(/~\/composables\/useApi/g, join(webDir, 'composables/useApi'))
    // Free useMemory() call (no explicit import) — route through sandbox global
    .replace(/useMemory\(/g, 'globalThis.__useMemory__(')
    // Capture setup's return value on globalThis for test access
    .replace(
      'return __returned__',
      'globalThis.__MEMORY_SETUP_STATE__ = __returned__;\n    return __returned__',
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

async function buildUseMemoryBundle(): Promise<string> {
  const source = readFileSync(join(webDir, 'composables/useMemory.ts'), 'utf-8')
  const result = await esbuild.build({
    stdin: { contents: source, resolveDir: webDir, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vue'],
  })
  return result.outputFiles[0].text
}

interface MountOptions {
  slug: string
  fetchMock: jest.Mock
}

async function mountMemoryPage(opts: MountOptions) {
  const { slug, fetchMock } = opts
  const fetchCalls: Array<{ url: string; opts?: Record<string, unknown> }> = []
  const wrappedFetchMock = jest.fn(async (url: string, fetchOpts?: Record<string, unknown>) => {
    fetchCalls.push({ url, opts: fetchOpts })
    return await fetchMock(url, fetchOpts)
  })

  // Capture the toast instance so tests can assert on toast.error(...) calls.
  const toastInstance = { success: jest.fn(), error: jest.fn() }

  const useMemoryBundle = await buildUseMemoryBundle()
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

    useRoute: () => ({ params: { project: slug }, path: `/${slug}/memory` }),
    useI18n: () => ({ t: (k: string) => k, locale: { value: 'en' } }),
    useAppToast: () => toastInstance,
    definePageMeta: () => {},
    onMounted: (fn: () => unknown) => { fn() },
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
  // Evaluate the real useMemory bundle inside the sandbox so globalThis.useApi
  // resolves to our stub.
  vm.runInContext(useMemoryBundle, sandbox as vm.Context)
  // Wire __useMemory__ to the useMemory module exported from the bundle.
  // The bundle exports via __toCommonJS — access as sandbox.__useMemoryReal__
  // (set by the bundle) or fall back to the default export.
  const memModule = sandbox.module as { exports: Record<string, unknown> }
  const useMemoryImpl = (memModule.exports.useMemory ?? memModule.exports.default?.useMemory) as
    | ((s: string) => unknown)
    | undefined
  if (typeof useMemoryImpl !== 'function') {
    throw new Error('useMemory bundle did not export useMemory function')
  }
  sandbox.__useMemory__ = useMemoryImpl
  // Reset module.exports for the page bundle evaluation.
  sandbox.module = { exports: {} }
  // Evaluate the page bundle — it references globalThis.__useMemory__ which
  // resolves to the useMemory module exported above.
  vm.runInContext(pageBundle, sandbox as vm.Context)

  const Comp = (sandbox.module as { exports: { default?: { setup?: (...args: unknown[]) => unknown } } }).exports.default
  const setupFn = Comp?.setup
  if (typeof setupFn !== 'function') {
    throw new Error('compiled page has no setup function')
  }

  // Invoke setup to run onMounted (sandbox override fires it synchronously).
  const bindings = setupFn.call(null, {}, { expose: () => {}, attrs: {}, slots: {}, emit: () => {} }) as Record<string, unknown>

  // Wait for the loadMemory promise to resolve.
  await new Promise(resolve => setTimeout(resolve, 20))

  return { bindings, fetchCalls, toast: toastInstance }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — Mount-time fetch with the project slug interpolated into the path
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC2 (Behavioral SFC mount): page calls $api.get with /projects/<slug>/memory on mount', () => {
  test('mounting the memory page with project=acme triggers $api.get(\'/projects/acme/memory\')', async () => {
    const { fetchCalls } = await mountMemoryPage({
      slug: 'acme',
      fetchMock: async () => ({ data: { items: [], total: 0 } }),
    })

    const memoryCalls = fetchCalls.filter(c => c.url === '/projects/acme/memory')
    expect(memoryCalls.length).toBeGreaterThanOrEqual(1)
  })

  test('mounting the memory page with project=other-project uses that slug in the API path', async () => {
    const { fetchCalls } = await mountMemoryPage({
      slug: 'other-project',
      fetchMock: async () => ({ data: { items: [], total: 0 } }),
    })

    const memoryCalls = fetchCalls.filter(c => c.url === '/projects/other-project/memory')
    expect(memoryCalls.length).toBeGreaterThanOrEqual(1)
    expect(fetchCalls.some(c => c.url === '/projects/acme/memory')).toBe(false)
  })

  test('the mount-time call sends an empty query object (no kind/status/page filters)', async () => {
    const { fetchCalls } = await mountMemoryPage({
      slug: 'acme',
      fetchMock: async () => ({ data: { items: [], total: 0 } }),
    })

    const mountCall = fetchCalls.find(c => c.url === '/projects/acme/memory')
    expect(mountCall).toBeDefined()
    const query = (mountCall?.opts?.query ?? {}) as Record<string, unknown>
    expect(query).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — load-more button: invoking loadMore re-invokes $api.get with the next
//        page value and appends the returned items to the existing list.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC8 (Behavioral SFC mount): invoking load-more re-invokes $api.get with page=2 and appends items', () => {
  test('invoking loadMore sends page=2 query and appends the second batch of items', async () => {
    const firstPage = {
      data: {
        items: [
          { id: 'm1', subject: 'ticket:1', predicate: 'status', object: 'open', kind: 'FACT', confidence: 0.9, status: 'active' },
        ],
        total: 3,
      },
    }
    const secondPage = {
      data: {
        items: [
          { id: 'm2', subject: 'ticket:2', predicate: 'status', object: 'closed', kind: 'FACT', confidence: 0.8, status: 'active' },
        ],
        total: 3,
      },
    }
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)

    const { fetchCalls, bindings } = await mountMemoryPage({ slug: 'acme', fetchMock })

    // First fetch happened on mount.
    expect(fetchCalls).toHaveLength(1)
    const itemsRef = bindings.items as { value: Array<{ id: string; subject: string }> }
    expect(itemsRef.value.length).toBe(1)
    expect(itemsRef.value[0].subject).toBe('ticket:1')

    // Now exercise load-more: the page wires the click handler to
    // loadMoreAndToast, which calls loadMore. Invoke loadMore directly to
    // assert the API contract.
    const loadMore = bindings.loadMore as () => Promise<void>
    expect(typeof loadMore).toBe('function')
    await loadMore()
    await new Promise(resolve => setTimeout(resolve, 20))

    // Now we should have a second fetch call with page=2.
    expect(fetchCalls).toHaveLength(2)
    const page2Call = fetchCalls[1]
    expect(page2Call.url).toBe('/projects/acme/memory')
    const query = (page2Call.opts?.query ?? {}) as Record<string, string>
    expect(query.page).toBe('2')

    // And items should have been appended (length 2, second item from page 2).
    expect(itemsRef.value.length).toBe(2)
    expect(itemsRef.value[1].id).toBe('m2')
    expect(itemsRef.value[1].subject).toBe('ticket:2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — Error path: when $api.get rejects, the page must call
//        useAppToast().error(extractApiError(err)) and render no rows.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC5 (Behavioral SFC mount): $api.get rejection surfaces extractApiError via toast', () => {
  test('mounting with a fetch that rejects causes toast.error to be called with extractApiError(err)', async () => {
    const networkError = Object.assign(new Error('boom'), {
      data: { ret: 1, message: 'Memory service unavailable' },
    })
    const fetchMock = jest.fn(() => Promise.reject(networkError))

    const { toast, fetchCalls } = await mountMemoryPage({ slug: 'acme', fetchMock })

    // The fetch was attempted once on mount.
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('/projects/acme/memory')

    // Wait for the async chain: loadMemory rejects → withToastError catches
    // → toast.error(extractApiError(err)) is invoked.
    await new Promise(resolve => setTimeout(resolve, 30))

    // toast.error was called exactly once.
    expect(toast.error).toHaveBeenCalledTimes(1)
    // The argument is the extracted error message from extractApiError.
    const calledWith = (toast.error as jest.Mock).mock.calls[0][0]
    expect(calledWith).toBe('Memory service unavailable')
  })

  test('on rejection, the items ref stays empty (no rows rendered)', async () => {
    const fetchMock = jest.fn(() => Promise.reject(new Error('fail')))

    const { bindings, fetchCalls } = await mountMemoryPage({ slug: 'acme', fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(fetchCalls).toHaveLength(1)
    const itemsRef = bindings.items as { value: unknown[] }
    expect(itemsRef.value).toEqual([])
    // error ref is set so the template can suppress row rendering.
    const errorRef = bindings.error as { value: unknown }
    expect(errorRef.value).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — kind filter: changing the kind select re-invokes $api.get with the
//        kind query param set to the chosen value.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC6 (Behavioral SFC mount): kind filter re-invokes $api.get with the chosen kind', () => {
  test('setting kindFilter to FACT and applying triggers a new fetch with kind=FACT', async () => {
    const initial = { data: { items: [], total: 0 } }
    const afterFilter = { data: { items: [], total: 0 } }
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(afterFilter)

    const { fetchCalls, bindings } = await mountMemoryPage({ slug: 'acme', fetchMock })
    expect(fetchCalls).toHaveLength(1)

    // Mutate the kind filter and invoke applyFilters (which is what the
    // page wires to @change on the kind <select>).
    const kindFilter = bindings.kindFilter as { value: string }
    expect(kindFilter.value).toBe('')

    kindFilter.value = 'FACT'
    const applyFilters = bindings.applyFilters as () => Promise<void>
    await applyFilters()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls).toHaveLength(2)
    const filterCall = fetchCalls[1]
    expect(filterCall.url).toBe('/projects/acme/memory')
    const query = (filterCall.opts?.query ?? {}) as Record<string, string>
    expect(query.kind).toBe('FACT')
    // status and page are not set when kind is the only filter applied.
    expect(query.status).toBeUndefined()
  })

  test('changing kind filter to INCIDENT_PATTERN sends that value in the query', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ data: { items: [], total: 0 } }))

    const { fetchCalls, bindings } = await mountMemoryPage({ slug: 'acme', fetchMock })
    expect(fetchCalls).toHaveLength(1)

    const kindFilter = bindings.kindFilter as { value: string }
    kindFilter.value = 'INCIDENT_PATTERN'
    const applyFilters = bindings.applyFilters as () => Promise<void>
    await applyFilters()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls).toHaveLength(2)
    const query = (fetchCalls[1].opts?.query ?? {}) as Record<string, string>
    expect(query.kind).toBe('INCIDENT_PATTERN')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — status filter: changing the status select re-invokes $api.get with
//        the status query param set to the chosen value.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-004 AC7 (Behavioral SFC mount): status filter re-invokes $api.get with the chosen status', () => {
  test('setting statusFilter to active and applying triggers a new fetch with status=active', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ data: { items: [], total: 0 } }))

    const { fetchCalls, bindings } = await mountMemoryPage({ slug: 'acme', fetchMock })
    expect(fetchCalls).toHaveLength(1)

    const statusFilter = bindings.statusFilter as { value: string }
    expect(statusFilter.value).toBe('')

    statusFilter.value = 'active'
    const applyFilters = bindings.applyFilters as () => Promise<void>
    await applyFilters()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls).toHaveLength(2)
    const filterCall = fetchCalls[1]
    expect(filterCall.url).toBe('/projects/acme/memory')
    const query = (filterCall.opts?.query ?? {}) as Record<string, string>
    expect(query.status).toBe('active')
    expect(query.kind).toBeUndefined()
  })

  test('changing status filter to superseded sends that value in the query', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ data: { items: [], total: 0 } }))

    const { fetchCalls, bindings } = await mountMemoryPage({ slug: 'acme', fetchMock })
    expect(fetchCalls).toHaveLength(1)

    const statusFilter = bindings.statusFilter as { value: string }
    statusFilter.value = 'superseded'
    const applyFilters = bindings.applyFilters as () => Promise<void>
    await applyFilters()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls).toHaveLength(2)
    const query = (fetchCalls[1].opts?.query ?? {}) as Record<string, string>
    expect(query.status).toBe('superseded')
  })

  test('applying both kind and status filters sends both query params', async () => {
    const fetchMock = jest.fn(() => Promise.resolve({ data: { items: [], total: 0 } }))

    const { fetchCalls, bindings } = await mountMemoryPage({ slug: 'acme', fetchMock })
    expect(fetchCalls).toHaveLength(1)

    const kindFilter = bindings.kindFilter as { value: string }
    const statusFilter = bindings.statusFilter as { value: string }
    kindFilter.value = 'DECISION'
    statusFilter.value = 'rejected'
    const applyFilters = bindings.applyFilters as () => Promise<void>
    await applyFilters()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls).toHaveLength(2)
    const query = (fetchCalls[1].opts?.query ?? {}) as Record<string, string>
    expect(query.kind).toBe('DECISION')
    expect(query.status).toBe('rejected')
  })
})
