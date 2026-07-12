import { describe, test, expect, jest } from '@jest/globals'
import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import vm from 'vm'

// ─────────────────────────────────────────────────────────────────────────────
// Resolve Bun-hoisted dev-tooling packages (e.g. @vue/compiler-sfc, esbuild)
// by walking up from __dirname to find a node_modules/.bun/<encoded-name>@*
// directory. This avoids hardcoded absolute machine paths and the
// version+content-hash suffix in Bun's hoisted layout.
function resolveBunPackage(pkgName: string): string {
  let dir: string = __dirname
  const bunName = pkgName.startsWith('@') ? pkgName.replace('/', '+') : pkgName
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
const pagePath = join(webDir, 'pages', 'admin', 'slos.vue')

// Minimal stub of the real API response shape (apps/api SloMetrics) used
// for tests that don't care about the metric contents — the page flattens
// this object into the `metrics` array via flattenSloMetrics().
function emptySloResponse() {
  return {
    retrievalLatency: { p50: 0, p95: 0, p99: 0, sampleCount: 0 },
    staleHitRate: 0,
    provenanceCoverage: 0,
    leakageIncidents: 0,
    memoryGrowthRate: 0,
  }
}

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
      'globalThis.__SLOS_SETUP_STATE__ = __returned__;\n    return __returned__',
    )

  const result = await esbuild.build({
    stdin: { contents: code, resolveDir: webDir, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vue', 'lucide-vue-next', join(webDir, 'composables/useApi')],
  })
  return result.outputFiles[0].text
}

interface MountOptions {
  fetchMock: jest.Mock
}

async function mountSlosPage(opts: MountOptions) {
  const { fetchMock } = opts
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

    ref: Vue.ref,
    computed: Vue.computed,

    useRoute: () => ({ path: '/admin/slos' }),
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
  sandbox.module = { exports: {} }
  vm.runInContext(pageBundle, sandbox as vm.Context)

  const Comp = (sandbox.module as { exports: { default?: { setup?: (...args: unknown[]) => unknown } } }).exports.default
  const setupFn = Comp?.setup
  if (typeof setupFn !== 'function') {
    throw new Error('compiled page has no setup function')
  }

  const bindings = setupFn.call(null, {}, { expose: () => {}, attrs: {}, slots: {}, emit: () => {} }) as Record<string, unknown>

  // Allow the onMounted-initiated fetch (and any error path) to resolve.
  await new Promise(resolve => setTimeout(resolve, 20))

  return { bindings, fetchCalls, toast: toastInstance }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — When $api.get resolves SLO metrics, the page renders a metric card per
//       returned metric with its label and value.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC1 (Behavioral SFC mount): page renders one metric card per returned metric', () => {
  test('mounting with a SloMetrics payload produces one card per flattened metric with label and value bindings', async () => {
    const fetchMock = jest.fn(async () => ({
      data: {
        retrievalLatency: { p50: 80, p95: 120, p99: 200, sampleCount: 1000 },
        staleHitRate: 0.05,
        provenanceCoverage: 0.92,
        leakageIncidents: 1,
        memoryGrowthRate: 0.02,
      },
    }))

    const { bindings } = await mountSlosPage({ fetchMock })

    const metrics = bindings.metrics as { value: Array<{ label: string; value: number }> }
    expect(Array.isArray(metrics.value)).toBe(true)
    expect(metrics.value).toHaveLength(8)
    const labels = metrics.value.map(m => m.label)
    expect(labels).toContain('slos.metrics.retrievalLatencyP50')
    expect(labels).toContain('slos.metrics.retrievalLatencyP95')
    expect(labels).toContain('slos.metrics.retrievalLatencyP99')
    expect(labels).toContain('slos.metrics.retrievalLatencySamples')
    expect(labels).toContain('slos.metrics.staleHitRate')
    expect(labels).toContain('slos.metrics.provenanceCoverage')
    expect(labels).toContain('slos.metrics.leakageIncidents')
    expect(labels).toContain('slos.metrics.memoryGrowthRate')

    const p50 = metrics.value.find(m => m.label === 'slos.metrics.retrievalLatencyP50')
    expect(p50?.value).toBe(80)
    const samples = metrics.value.find(m => m.label === 'slos.metrics.retrievalLatencySamples')
    expect(samples?.value).toBe(1000)
    const stale = metrics.value.find(m => m.label === 'slos.metrics.staleHitRate')
    expect(stale?.value).toBe(0.05)
  })

  test('mounting with a SloMetrics payload whose numeric fields are zero produces eight zero-valued cards', async () => {
    const fetchMock = jest.fn(async () => ({
      data: {
        retrievalLatency: { p50: 0, p95: 0, p99: 0, sampleCount: 0 },
        staleHitRate: 0,
        provenanceCoverage: 0,
        leakageIncidents: 0,
        memoryGrowthRate: 0,
      },
    }))

    const { bindings } = await mountSlosPage({ fetchMock })

    const metrics = bindings.metrics as { value: Array<{ label: string; value: number }> }
    expect(metrics.value).toHaveLength(8)
    expect(metrics.value.every(m => m.value === 0)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — The page calls $api.get with the path /admin/slos.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC2 (Behavioral SFC mount): page calls $api.get with /admin/slos on mount', () => {
  test('mounting triggers $api.get("/admin/slos") at least once', async () => {
    const fetchMock = jest.fn(async () => ({ data: emptySloResponse() }))

    const { fetchCalls } = await mountSlosPage({ fetchMock })

    const slosCalls = fetchCalls.filter(c => c.url === '/admin/slos')
    expect(slosCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — Changing date-window controls re-invokes $api.get with from and to
//       query params carrying the selected window.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC3 (Behavioral SFC mount): changing the date window re-invokes $api.get with from/to query', () => {
  test('mutating the from ref and triggering reload re-invokes $api.get with from and to set', async () => {
    const fetchMock = jest.fn(async () => ({ data: emptySloResponse() }))

    const { fetchCalls, bindings } = await mountSlosPage({ fetchMock })
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>
    expect(typeof reload).toBe('function')

    from.value = '2026-01-01'
    to.value = '2026-01-31'
    await reload()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)
    const lastCall = fetchCalls[fetchCalls.length - 1]
    expect(lastCall.url).toBe('/admin/slos')
    const query = (lastCall.opts?.query ?? {}) as Record<string, string>
    expect(query.from).toBe('2026-01-01')
    expect(query.to).toBe('2026-01-31')
  })

  test('the second invocation carries the new window values, not the previous ones', async () => {
    const fetchMock = jest.fn(async () => ({ data: emptySloResponse() }))

    const { fetchCalls, bindings } = await mountSlosPage({ fetchMock })

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>

    from.value = '2026-02-01'
    to.value = '2026-02-28'
    await reload()
    await new Promise(resolve => setTimeout(resolve, 20))

    const latest = fetchCalls[fetchCalls.length - 1]
    const query = (latest.opts?.query ?? {}) as Record<string, string>
    expect(query.from).toBe('2026-02-01')
    expect(query.to).toBe('2026-02-28')
  })
})

// The script-mock tests above prove that the page re-invokes $api.get with
// from/to when reload() runs. The AC additionally requires that the
// date-window *controls* (the rendered <input type="date"> elements) drive
// that flow — i.e. v-model must bind the inputs to from/to and @change
// must invoke reload on user interaction. These SSR + source-wiring tests
// guard that contract so a broken v-model or @change wouldn't leave the
// suite green.

describe('US-006 AC3 (Behavioral SSR): template renders two date inputs bound to from and to', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('rendering with from=2026-01-01 and to=2026-01-31 produces two date inputs whose value attributes match the refs', async () => {
    const ctx = createRenderContext({
      from: VueFull.ref('2026-01-01'),
      to: VueFull.ref('2026-01-31'),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    const dateInputs = html.match(/<input[^>]*type="date"[^>]*>/g) ?? []
    expect(dateInputs).toHaveLength(2)

    // The Vue compiler turns v-model="from" into a `value` attribute bound
    // to the ref. Verifying the rendered value attributes match the ref
    // contents proves v-model is wired (the wiring test below separately
    // asserts the literal v-model/@change directive strings in the SFC
    // source, so a fully broken template cannot regress silently).
    expect(html).toMatch(/<input[^>]*value="2026-01-01"[^>]*type="date"[^>]*>/)
    expect(html).toMatch(/<input[^>]*value="2026-01-31"[^>]*type="date"[^>]*>/)
  })
})

describe('US-006 AC3 (Wiring): each date input triggers reload on change', () => {
  test('the from input has v-model="from" and @change="reload" wired in the SFC source', () => {
    const source = readFileSync(pagePath, 'utf-8')
    // Match the from <input type="date" ...> block and assert both directives
    // appear in the same tag attributes.
    const fromInput = source.match(/<input[^>]*v-model="from"[^>]*>/)
    expect(fromInput).not.toBeNull()
    expect(fromInput?.[0]).toContain('@change="reload"')
  })

  test('the to input has v-model="to" and @change="reload" wired in the SFC source', () => {
    const source = readFileSync(pagePath, 'utf-8')
    const toInput = source.match(/<input[^>]*v-model="to"[^>]*>/)
    expect(toInput).not.toBeNull()
    expect(toInput?.[0]).toContain('@change="reload"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — While the request is pending, the page shows a loading indicator and
//       not the metric cards.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC4 (Behavioral SFC mount): pending state exposes a loading flag and clears after resolution', () => {
  test('pending is true while the fetch is in flight and false once it resolves', async () => {
    let resolveFetch: ((value: unknown) => void) | null = null
    const fetchMock = jest.fn(
      () => new Promise(resolve => { resolveFetch = resolve }),
    )

    const { bindings } = await mountSlosPage({ fetchMock })

    const pending = bindings.pending as { value: boolean }
    expect(pending.value).toBe(true)

    resolveFetch?.({ data: emptySloResponse() })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(pending.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — $api.get rejecting with a 403 ApiError renders an admin-only state
//       rather than a generic error toast.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC5 (Behavioral SFC mount): 403 ApiError renders an admin-only state, not a generic toast', () => {
  test('rejecting with ApiError code 403 sets adminOnly to true and does NOT call toast.error', async () => {
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    const fetchMock = jest.fn(() => Promise.reject(new ApiError(403, 'Forbidden')))

    const { bindings, toast } = await mountSlosPage({ fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    const adminOnly = bindings.adminOnly as { value: boolean }
    expect(adminOnly.value).toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — $api.get rejecting with a non-403 error surfaces extractApiError(err)
//       via the app toast.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC6 (Behavioral SFC mount): non-403 error surfaces extractApiError via toast.error', () => {
  test('rejecting with a generic ApiError(500) calls toast.error with extractApiError(err)', async () => {
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    const fetchMock = jest.fn(() => Promise.reject(new ApiError(500, 'Internal Server Error')))

    const { toast } = await mountSlosPage({ fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(toast.error).toHaveBeenCalledTimes(1)
    const calledWith = (toast.error as jest.Mock).mock.calls[0][0]
    expect(calledWith).toBe('Internal Server Error')
  })

  test('admin-only flag stays false on non-403 errors', async () => {
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    const fetchMock = jest.fn(() => Promise.reject(new ApiError(500, 'Boom')))

    const { bindings } = await mountSlosPage({ fetchMock })
    await new Promise(resolve => setTimeout(resolve, 30))

    const adminOnly = bindings.adminOnly as { value: boolean }
    expect(adminOnly.value).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial finding: overlapping date-window requests must not let a stale
// response overwrite metrics from the newer request. Each reload() carries its
// own request id and ignores late resolutions from prior requests.
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 (Adversarial): overlapping reload() requests are sequenced by request id', () => {
  test('a stale response does not overwrite metrics from the newer successful request', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null
    let resolveSecond: ((value: unknown) => void) | null = null

    const fetchMock = jest.fn(async (_url: string, fetchOpts?: Record<string, unknown>) => {
      const query = (fetchOpts?.query ?? {}) as Record<string, string>
      const isFirst = query.from === '2026-01-01' && query.to === '2026-01-31'
      if (isFirst) {
        return new Promise(resolve => { resolveFirst = resolve })
      }
      return new Promise(resolve => { resolveSecond = resolve })
    })

    const { fetchCalls, bindings } = await mountSlosPage({ fetchMock })

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>

    // First request already in flight. Start a second reload with a new window.
    from.value = '2026-02-01'
    to.value = '2026-02-28'
    const reloadPromise = reload()

    // The newest request must have been issued.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)

    // Resolve the SECOND (newest) request first with newer-window data.
    const p50New = bindings.metrics as { value: Array<{ label: string; value: number }> }
    expect(p50New.value).toEqual([])
    resolveSecond?.({
      data: {
        retrievalLatency: { p50: 250, p95: 0, p99: 0, sampleCount: 0 },
        staleHitRate: 0, provenanceCoverage: 0, leakageIncidents: 0, memoryGrowthRate: 0,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    // Now resolve the FIRST (stale) request with older-window data — this must
    // NOT overwrite the newer window's p50 value.
    resolveFirst?.({
      data: {
        retrievalLatency: { p50: 80, p95: 0, p99: 0, sampleCount: 0 },
        staleHitRate: 0, provenanceCoverage: 0, leakageIncidents: 0, memoryGrowthRate: 0,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    await reloadPromise

    const p50 = p50New.value.find(m => m.label === 'slos.metrics.retrievalLatencyP50')
    expect(p50?.value).toBe(250)

    const pending = bindings.pending as { value: boolean }
    expect(pending.value).toBe(false)
  })

  test('a stale rejection does not surface as the active error after a newer success', async () => {
    let rejectFirst: ((err: unknown) => void) | null = null
    let resolveSecond: ((value: unknown) => void) | null = null

    const fetchMock = jest.fn(async (_url: string, fetchOpts?: Record<string, unknown>) => {
      const query = (fetchOpts?.query ?? {}) as Record<string, string>
      const isFirst = query.from === '2026-01-01' && query.to === '2026-01-31'
      if (isFirst) {
        return new Promise<unknown>((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return new Promise(resolve => { resolveSecond = resolve })
    })

    const { bindings, toast } = await mountSlosPage({ fetchMock })

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>

    // Start a second (newer) reload while the first is in flight.
    from.value = '2026-03-01'
    to.value = '2026-03-31'
    const reloadPromise = reload()

    // Resolve the second request first.
    resolveSecond?.({ data: emptySloResponse() })
    await new Promise(resolve => setTimeout(resolve, 20))

    // Now reject the first (stale) request — must NOT call toast.error.
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    rejectFirst?.(new ApiError(500, 'stale failure'))
    await new Promise(resolve => setTimeout(resolve, 20))
    await reloadPromise

    expect(toast.error).not.toHaveBeenCalled()
  })

  test('on a non-403 reload failure the displayed metrics are not stale from the prior successful window', async () => {
    // First reload succeeds with window A. A second reload fails with a
    // non-403 error on window B; metrics from window A must NOT remain on
    // screen misleadingly labeled as window B.
    let callCount = 0
    let resolveFirst: ((value: unknown) => void) | null = null
    let rejectSecond: ((err: unknown) => void) | null = null

    const fetchMock = jest.fn(async (_url: string, fetchOpts?: Record<string, unknown>) => {
      callCount++
      const query = (fetchOpts?.query ?? {}) as Record<string, string>
      const isSecond = query.from === '2026-02-01' && query.to === '2026-02-28'
      if (callCount === 1) {
        return new Promise(resolve => { resolveFirst = resolve })
      }
      if (isSecond) {
        return new Promise<unknown>((resolve, reject) => {
          resolveSecond = resolve
          rejectSecond = reject
        })
      }
      return { data: emptySloResponse() }
    })

    const { bindings } = await mountSlosPage({ fetchMock })

    const from = bindings.from as { value: string }
    const to = bindings.to as { value: string }
    const reload = bindings.reload as () => Promise<void>

    // Window A resolves successfully.
    resolveFirst?.({
      data: {
        retrievalLatency: { p50: 100, p95: 0, p99: 0, sampleCount: 0 },
        staleHitRate: 0, provenanceCoverage: 0, leakageIncidents: 0, memoryGrowthRate: 0,
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const metrics = bindings.metrics as { value: Array<{ label: string; value: number }> }
    const p50Before = metrics.value.find(m => m.label === 'slos.metrics.retrievalLatencyP50')
    expect(p50Before?.value).toBe(100)

    // User picks a new window; that reload errors.
    from.value = '2026-02-01'
    to.value = '2026-02-28'
    const reloadPromise = reload()
    const { ApiError } = require(join(webDir, 'composables/useApi'))
    rejectSecond?.(new ApiError(500, 'boom'))
    await new Promise(resolve => setTimeout(resolve, 20))
    await reloadPromise

    // The page must NOT display the prior window's p50 value as if it
    // belonged to the newly selected dates.
    const p50After = metrics.value.find(m => m.label === 'slos.metrics.retrievalLatencyP50')
    expect(p50After?.value).toBeUndefined()
    expect(metrics.value).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral SSR tests — render the SFC template with stubbed state and verify
// the actual rendered HTML for the user-facing branches the ACs describe.
// This guards against the template (`v-for`, `v-if`, `v-else-if`) regressing
// in a way that the script-mock tests above would not catch.
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const VueFull = require('vue/dist/vue.cjs.js')
// eslint-disable-next-line @typescript-eslint/no-var-requires
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
      return h('div', { class: `stub-${tag.toLowerCase()}` }, slots)
    },
  }
}

interface SloMetric { label: string; value: number }

function createRenderContext(overrides: Record<string, unknown> = {}) {
  const { ref } = VueFull
  return {
    t: (key: string) => key,
    from: ref('2026-01-01'),
    to: ref('2026-01-31'),
    metrics: ref<SloMetric[]>([]),
    pending: ref(false),
    adminOnly: ref(false),
    reload: () => Promise.resolve(),
    ...overrides,
  }
}

describe('US-006 AC1 (Behavioral SSR): template renders one metric card per metric with label and value', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('rendering with two metrics produces two metric cards containing their label and value', async () => {
    const ctx = createRenderContext({
      metrics: VueFull.ref([
        { label: 'Availability', value: 99.95 },
        { label: 'Latency p95', value: 120 },
      ]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    const cards = html.match(/data-testid="slo-metric-card"/g) ?? []
    expect(cards).toHaveLength(2)

    // Each metric's label and value must be rendered inside its card.
    expect(html).toContain('Availability')
    expect(html).toContain('99.95')
    expect(html).toContain('Latency p95')
    expect(html).toContain('120')
  })

  test('rendering with an empty metrics list produces zero metric cards and the empty-state copy', async () => {
    const ctx = createRenderContext({ metrics: VueFull.ref([]) })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    const cards = html.match(/data-testid="slo-metric-card"/g) ?? []
    expect(cards).toHaveLength(0)
    expect(html).toContain('slos.empty')
  })
})

describe('US-006 AC4 (Behavioral SSR): pending renders the loading indicator and not metric cards', () => {
  let pageTemplate: string

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('when pending=true the rendered HTML contains the loading indicator and no metric cards', async () => {
    const ctx = createRenderContext({
      pending: VueFull.ref(true),
      metrics: VueFull.ref([{ label: 'Availability', value: 99.95 }]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: {
          name: 'MockLoadingState',
          render(this: { title?: string }) {
            return VueFull.h('div', { class: 'loading-indicator' }, this.title ?? 'Loading...')
          },
        },
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    expect(html).toContain('loading-indicator')
    expect(html).not.toContain('data-testid="slo-metric-card"')
    expect(html).not.toContain('Availability')
    expect(html).not.toContain('slos.adminOnly')
    expect(html).not.toContain('slos.empty')
  })

  test('when pending=false and metrics are present, the loading indicator is absent and cards are rendered', async () => {
    const ctx = createRenderContext({
      pending: VueFull.ref(false),
      metrics: VueFull.ref([{ label: 'Availability', value: 99.95 }]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: {
          name: 'MockLoadingState',
          render(this: { title?: string }) {
            return VueFull.h('div', { class: 'loading-indicator' }, this.title ?? 'Loading...')
          },
        },
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    expect(html).not.toContain('loading-indicator')
    expect(html).toContain('data-testid="slo-metric-card"')
  })
})

describe('US-006 AC5 (Behavioral SSR): adminOnly renders the friendly admin-only state instead of metric cards or loading', () => {
  let pageTemplate: string
  const enLocale = JSON.parse(readFileSync(join(webDir, 'i18n', 'locales', 'en.json'), 'utf-8')) as {
    slos?: { adminOnly?: string }
  }
  const friendlyAdminOnly = enLocale.slos?.adminOnly ?? ''

  beforeAll(() => {
    pageTemplate = extractTemplateSfc(readFileSync(pagePath, 'utf-8'))
  })

  test('the locale entry for slos.adminOnly is a non-empty friendly message (not the raw key)', () => {
    // Guard the SSR test below: if en.json ever loses slos.adminOnly or
    // regresses to the raw key, the SSR assertion would silently degrade
    // into a tautology. This precheck fails fast with a clear message.
    expect(typeof friendlyAdminOnly).toBe('string')
    expect(friendlyAdminOnly.length).toBeGreaterThan(0)
    expect(friendlyAdminOnly).not.toBe('slos.adminOnly')
  })

  test('when adminOnly=true the rendered HTML contains the friendly message and no metric cards', async () => {
    // Resolve t() against the actual en locale so the assertion checks the
    // user-facing string, not the raw i18n key.
    const ctx = createRenderContext({
      t: (key: string) => {
        const parts = key.split('.')
        let cur: unknown = enLocale
        for (const part of parts) {
          if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[part]
          }
          else {
            return key
          }
        }
        return typeof cur === 'string' ? cur : key
      },
      adminOnly: VueFull.ref(true),
      metrics: VueFull.ref([{ label: 'Availability', value: 99.95 }]),
    })

    const app = VueFull.createSSRApp({
      template: pageTemplate,
      setup: () => ctx,
      components: {
        PageHeader: stubDiv('PageHeader'),
        LoadingState: stubDiv('LoadingState'),
      },
      directives: { model: {} },
    })

    const html = await renderToString(app)

    // The friendly resolved message must be present in the rendered HTML.
    expect(html).toContain(friendlyAdminOnly)
    // The raw i18n key must NOT leak through (it should have been resolved).
    expect(html).not.toContain('slos.adminOnly')
    // The other terminal branches must be absent.
    expect(html).not.toContain('data-testid="slo-metric-card"')
    expect(html).not.toContain('loading-indicator')
    expect(html).not.toContain('slos.empty')
  })
})
